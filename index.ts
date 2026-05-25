import type {
  Plugin,
  PluginModule,
  PluginInput,
  MessageWithParts,
  Part,
} from "@opencode-ai/plugin"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createHash } from "node:crypto"

const DEFAULT_AGENT = "image-looker"
const ANALYSIS_TIMEOUT_MS = 60_000
const MAX_RETRIES = 2

const IMAGE_ANALYSIS_SYSTEM_PROMPT = [
  "You are an image analysis subagent. Your only job: look at the attached image and describe everything visible in precise detail.",
  "",
  "What to describe:",
  "- Text content: every word, label, heading, code snippet visible in the image",
  "- UI elements: buttons, menus, dialogs, tabs, input fields, window decorations",
  "- Layout: spatial arrangement, alignment, grouping, whitespace patterns",
  "- Visual style: colors, fonts (serif/sans-serif/monospace), icons, themes (light/dark)",
  "- Diagrams and charts: axes, legends, data points, relationships, flow directions",
  "- Code and terminal output: exact content, syntax highlighting colors, line numbers, prompts",
  "- Context clues: application name in title bar, OS window decorations, file paths, timestamps",
  "- Colored boxes and frames: pay special attention to any colored borders, highlighted regions, selection boxes, or colored overlays — these are often intentional visual cues added to draw attention to specific areas and must be described explicitly with their color, position, and approximate size",
  "",
  "Rules:",
  "- Be exhaustive, not concise. Every detail matters.",
  "- Describe spatial positions explicitly (top-left, bottom-right, centered, etc.).",
  "- Match the language of the requesting instruction.",
  "- Output raw description directly, no preamble or meta-commentary.",
  "- If the image is unclear or ambiguous, state what you can see and what is uncertain.",
  "- Do NOT suggest next steps or ask follow-up questions — just describe.",
].join("\n")

const LOG_FILE = path.join(os.tmpdir(), "image-interceptor.log")

function log(msg: string, data?: unknown): void {
  const line = `[${new Date().toISOString()}] ${msg}${data ? " " + JSON.stringify(data) : ""}\n`
  try { fs.appendFileSync(LOG_FILE, line) } catch { /* ignore */ }
}

function isImageFile(part: Part): boolean {
  if (part.type !== "file") return false
  const mime = part.mime ?? ""
  const url = part.url ?? ""
  return mime.startsWith("image/") || url.startsWith("data:image/")
}

interface ImageData {
  url: string
  mime: string
}

function getImageData(part: Part): ImageData | null {
  const url = part.url ?? ""
  const mime = part.mime ?? "image/png"
  return url ? { url, mime } : null
}

function imageCacheKey(url: string): string {
  return createHash("md5").update(url.slice(0, 200)).digest("hex").slice(0, 16)
}

function promptWithTimeout(
  client: PluginInput["client"],
  args: Parameters<PluginInput["client"]["session"]["prompt"]>[0],
  timeoutMs: number,
): Promise<void> {
  const ctl = new AbortController()
  const timer = setTimeout(() => {
    ctl.abort(new Error(`image analysis timed out after ${timeoutMs}ms`))
  }, timeoutMs)
  return client.session.prompt({ ...args, signal: ctl.signal }).finally(() => clearTimeout(timer))
}

function resolveAgent(options?: Record<string, unknown>): string {
  if (options && typeof options.agent === "string" && options.agent.trim().length > 0) {
    return options.agent.trim()
  }
  return DEFAULT_AGENT
}

function findImageFromOtherAgent(messages: MessageWithParts[], agentName: string): { idx: number; msg: MessageWithParts } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.info.role !== "user") continue
    if (m.info.agent === agentName) continue
    if (m.parts.some(isImageFile)) return { idx: i, msg: m }
  }
  return null
}

function extractAssistantText(msg: MessageWithParts | undefined): string | null {
  if (!msg || msg.info.role !== "assistant") return null

  // Primary: extract from text parts
  const texts = msg.parts
    .filter((p): p is Part & { text: string } => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
  const combined = texts.join("\n").trim()
  if (combined) return combined

  // Fallback: reasoning models put content in reasoning parts
  const reasonings = msg.parts
    .filter((p): p is Part & { text: string } => p.type === "reasoning" && typeof p.text === "string")
    .map((p) => p.text)
  return reasonings.join("\n").trim() || null
}

function buildTextPart(template: Part, text: string): Part {
  return {
    type: "text",
    text,
    id: template.id,
    sessionID: template.sessionID,
    messageID: template.messageID,
  }
}

function createAnalysisResultText(results: string[], total: number, failed: number): string {
  const combined = results.map((a, i) => `[Image ${i + 1}]\n${a}`).join("\n\n")
  const suffix = failed > 0 ? `\n\n[Note: ${failed}/${total} image(s) could not be analyzed.]` : ""
  return `[Image analysis results]\n\n${combined}${suffix}`
}

function createDegradationText(total: number): string {
  return [
    `[The user sent ${total} image(s). Automated image analysis was attempted`,
    `but all attempts failed (${total}/${total}). The model cannot see the image`,
    "directly. Ask the user to describe what is in the image, or try sending",
    "a different format (PNG or JPEG).]",
  ].join(" ")
}

class NonRetryableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "NonRetryableError"
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof NonRetryableError) return false
  if (error instanceof DOMException && error.name === "AbortError") return false
  if (error instanceof Error && error.name === "AbortError") return false
  return true
}

async function analyzeSingleImage(
  input: PluginInput,
  parentSessionID: string,
  data: ImageData,
  agent: string,
  model?: string,
): Promise<string> {
  log("analyze start", { agent, model, mime: data.mime, urlLen: data.url.length })

  const cr = await input.client.session.create({
    body: { parentID: parentSessionID, title: "Image analysis" },
    query: { directory: input.directory },
  })
  if (cr.error) {
    log("session.create failed", { error: cr.error })
    throw new Error(`session.create failed: ${JSON.stringify(cr.error)}`)
  }

  const subID = cr.data.id
  log("sub-session created", { subID })

  const body: Record<string, unknown> = {
    agent,
    system: IMAGE_ANALYSIS_SYSTEM_PROMPT,
    parts: [
      { type: "text", text: "Analyze the attached image." },
      { type: "file", mime: data.mime, url: data.url },
    ],
  }

  if (model) {
    const [providerID, ...modelParts] = model.split("/")
    const modelID = modelParts.join("/")
    if (providerID && modelID) {
      body.model = { providerID, modelID }
    }
  }

  log("prompting", { subID, partsCount: body.parts.length, hasSystem: !!body.system })
  await promptWithTimeout(input.client, {
    path: { id: subID },
    body: body as unknown as Parameters<PluginInput["client"]["session"]["prompt"]>[0]["body"],
  }, ANALYSIS_TIMEOUT_MS)
  log("prompt done", { subID })

  const mr = await input.client.session.messages({ path: { id: subID } })
  log("messages fetched", { subID, count: mr.data?.length ?? 0 })

  // Dump all messages for debugging
  for (const m of (mr.data ?? [])) {
    const textParts = m.parts.filter((p) => p.type === "text" && typeof (p as Part & { text: string }).text === "string")
    const reasoningParts = m.parts.filter((p) => p.type === "reasoning" && typeof (p as Part & { text: string }).text === "string")
    log("message detail", {
      subID,
      role: m.info.role,
      agent: m.info.agent,
      partTypes: m.parts.map((p) => p.type),
      textParts: textParts.map((p) => ({ len: (p as Part & { text: string }).text.length, preview: (p as Part & { text: string }).text.slice(0, 200) })),
      reasoningParts: reasoningParts.map((p) => ({ len: (p as Part & { text: string }).text.length, preview: (p as Part & { text: string }).text.slice(0, 200) })),
    })
  }

  const assistant = (mr.data ?? []).filter((m) => m.info.role === "assistant").pop()
  if (!assistant) {
    log("no assistant message in response", { subID })
    throw new NonRetryableError("no assistant response — model sent empty reply")
  }

  const text = extractAssistantText(assistant)
  if (!text) {
    // Dump the raw assistant parts to understand why text is empty
    log("empty assistant text", {
      subID,
      partCount: assistant.parts.length,
      partDetails: assistant.parts.map((p) => {
        const hasText = (p.type === "text" || p.type === "reasoning") && typeof (p as Part & { text: string }).text === "string"
        return {
          type: p.type,
          hasText,
          textLen: hasText ? (p as Part & { text: string }).text.length : 0,
          preview: hasText ? (p as Part & { text: string }).text.slice(0, 500) : undefined,
        }
      }),
    })
    throw new NonRetryableError("no assistant response — model sent empty reply")
  }

  log("analysis ok", { subID, textLen: text.length, preview: text.slice(0, 200) })
  return text
}

async function analyzeWithRetry(
  input: PluginInput,
  parentSessionID: string,
  data: ImageData,
  agent: string,
  model?: string,
): Promise<string> {
  let lastError: unknown
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      log("analyze attempt", { attempt, agent, model: model ?? "unknown" })
      return await analyzeSingleImage(input, parentSessionID, data, agent, model)
    } catch (e) {
      lastError = e
      log("analyze attempt failed", { attempt, error: String(e), retryable: isRetryable(e) })
      if (!isRetryable(e)) throw e
    }
  }
  throw lastError
}

const serverPlugin: Plugin = async (input: PluginInput, options?: Record<string, unknown>) => {
  const agentName = resolveAgent(options)
  log("plugin loaded", { agent: agentName, directory: input.directory })

  // Lazily resolve agent model from config on first use
  let model: string | undefined
  let modelResolved = false
  async function resolveModel(): Promise<string | undefined> {
    if (modelResolved) return model
    modelResolved = true
    try {
      const configResp = await input.client.config.get()
      log("config fetched", { hasAgent: !!configResp.data?.agent })
      const agents = configResp.data?.agent
      if (agents) {
        log("available agents", { names: Object.keys(agents) })
        if (agents[agentName]) {
          log("agent config", {
            agent: agentName,
            model: agents[agentName].model,
            hasPrompt: typeof agents[agentName].prompt === "string",
            promptLen: typeof agents[agentName].prompt === "string" ? (agents[agentName].prompt as string).length : 0,
          })
        } else {
          log("agent not found in config", { agent: agentName, available: Object.keys(agents) })
        }
      }
      if (agents && agents[agentName] && typeof agents[agentName].model === "string") {
        model = agents[agentName].model
      }
    } catch (e) { log("config fetch failed", { error: String(e) }) }
    log("resolved model", { model: model ?? "undefined" })
    return model
  }

  const seen = new Set<string>()
  const cache = new Map<string, string>()

  return {
    "experimental.chat.messages.transform": async (
      _ctx: Record<string, never>,
      output: { messages: MessageWithParts[] },
    ): Promise<void> => {
      if (!output.messages?.length) return

      log("messages.transform invoked", { msgCount: output.messages.length })

      const found = findImageFromOtherAgent(output.messages, agentName)
      if (!found) {
        log("skip — no user image from non-looker agent (sub-session or no image)")
        return
      }

      log("image found", { idx: found.idx, sessionID: found.msg.info.sessionID, agent: found.msg.info.agent })

      const sid = found.msg.info.sessionID
      if (!sid || seen.has(sid)) {
        log("skipping duplicate", { sid, alreadySeen: seen.has(sid) })
        return
      }

      seen.add(sid)
      log("processing", { sid })

      try {
        const resolvedModel = await resolveModel()
        const imgParts = found.msg.parts.filter(isImageFile)
        const otherParts = found.msg.parts.filter((p) => !isImageFile(p))
        log("image parts", { total: imgParts.length, otherParts: otherParts.length })

        const results: string[] = []
        let failed = 0

        for (const img of imgParts) {
          const data = getImageData(img)
          if (!data) {
            log("no image data", { partType: img.type })
            failed++
            continue
          }

          log("image data", { mime: data.mime, urlLen: data.url.length, urlPreview: data.url.slice(0, 100) })

          const key = imageCacheKey(data.url)
          if (cache.has(key)) {
            log("cache hit", { key })
            results.push(cache.get(key)!)
            continue
          }

          try {
            const text = await analyzeWithRetry(input, sid, data, agentName, resolvedModel)
            results.push(text)
            cache.set(key, text)
          } catch (e) {
            log("analysis failed", { error: String(e) })
            failed++
          }
        }

        const total = imgParts.length
        log("analysis complete", { total, succeeded: results.length, failed })

        if (results.length > 0) {
          const replacementText = createAnalysisResultText(results, total, failed)
          log("replacing parts", { msgIdx: found.idx, textLen: replacementText.length })
          output.messages[found.idx].parts = [
            ...otherParts,
            buildTextPart(imgParts[0], replacementText),
          ]
          log("parts replaced", {
            finalPartCount: output.messages[found.idx].parts.length,
            finalTextLen: replacementText.length,
            finalPreview: replacementText.slice(0, 200),
          })
        } else if (failed === total) {
          log("all failed — injecting degradation text")
          output.messages[found.idx].parts = [
            ...otherParts,
            buildTextPart(imgParts[0], createDegradationText(total)),
          ]
        }
      } catch (e) {
        log("fatal", { error: String(e), stack: e instanceof Error ? e.stack : undefined })
      } finally {
        seen.delete(sid)
        log("done processing", { sid })
      }
    },
  }
}

const pluginModule: PluginModule = {
  id: "image-interceptor",
  server: serverPlugin,
}

export default pluginModule

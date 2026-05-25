declare module "@opencode-ai/plugin" {
  export interface PluginInput {
    client: PluginClient
    directory: string
  }

  export interface PluginClient {
    session: {
      create(input: { body: { parentID?: string; title?: string }; query: { directory: string } }): Promise<{ data: { id: string }; error?: unknown }>
      prompt(input: { path: { id: string }; body: SessionPromptBody; signal?: AbortSignal }): Promise<void>
      messages(input: { path: { id: string } }): Promise<{ data?: MessageWithParts[]; error?: unknown }>
    }
    config: {
      get(): Promise<{ data?: { agent?: Record<string, { model?: string }> } }>
    }
  }

  export interface SessionPromptBody {
    agent: string
    model?: { providerID: string; modelID: string }
    variant?: string
    tools?: Record<string, boolean>
    system?: string
    parts: Part[]
  }

  export interface MessageWithParts {
    info: MessageInfo
    parts: Part[]
  }

  export interface MessageInfo {
    id: string
    sessionID: string
    role: "user" | "assistant" | "system" | "tool"
    agent?: string
  }

  export interface Part {
    type: string
    text?: string
    mime?: string
    url?: string
    id?: string
    sessionID?: string
    messageID?: string
  }

  export type Plugin = (input: PluginInput, options?: Record<string, unknown>) => Promise<Record<string, unknown>>

  export interface PluginModule {
    id: string
    server: Plugin
  }
}

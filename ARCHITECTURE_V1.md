# OpenCode 图片拦截插件：技术实现文档

## 问题背景

用户使用非 vision 模型（如 DeepSeek）作为主模型，同时通过 OhMyOpenAgent (OMO) 配置了 vision-capable 的多模态模型（GPT-5.5 等）。期望达到的效果：

- 主模型（DeepSeek）做代码推理
- 遇到图片时自动切换到 vision 模型分析
- 分析结果交给主模型继续处理

## OpenCode 插件机制

### 架构概述

OpenCode 的插件系统基于 npm/bun 包加载机制。一个插件是一个模块，默认导出 `PluginModule`：

```typescript
type PluginModule = {
  id: string
  server: Plugin
}

type Plugin = (input: PluginInput, options) => Promise<Hooks>
```

`server` 函数接收 `PluginInput`（包含 `client`、`directory` 等上下文），返回 `Hooks` 对象。

### 可用的 Hook 点

| Hook | 签名 | 触发时机 | 可修改 |
|---|---|---|---|
| `chat.message` | `(input: ChatMessageInput, output: ChatMessageHandlerOutput) => void` | 每次消息组装时 | `output.parts`, `output.message.model` |
| `chat.params` | `(input: ChatParamsInput, output: ChatParamsOutput) => void` | LLM 调用前 | temperature, topP, maxTokens |
| `tool.execute.before` | `(input: ToolExecuteInput, output: { args }) => void` | 工具执行前 | 工具参数 |
| `tool.execute.after` | `(input: ToolExecuteInput, output: ToolExecuteOutput) => void` | 工具执行后 | 工具输出 |
| `experimental.chat.messages.transform` | `(input: {}, output: { messages: MessageWithParts[] }) => void` | **所有消息发送给 LLM 之前** | `output.messages` 整个消息数组 |
| `experimental.session.compacting` | `(input, output) => void` | session 压缩时 | 压缩上下文 |

### 关键发现

- **没有 `session.prompt.before`** —— 无法直接拦截用户输入
- **`chat.message` 的 `output.parts` 是系统提示词**，不是用户消息内容
- **`experimental.chat.messages.transform` 是唯一能拿到完整消息数组的 hook**，可以修改任意消息的 `parts`

## OMO 内部架构

OMO（OhMyOpenAgent）本身是一个 OpenCode 插件，但它内部建立了**第二层 hook 分发系统**。

### 双层架构

```
┌──────────────────────────────────────────────────┐
│                OpenCode 插件系统                    │
│  6 个 hook 入口: chat.message, messages.transform, │
│  tool.execute.*, chat.params, ...                 │
├──────────────────────────────────────────────────┤
│  ┌────────────────────────────────────────────┐  │
│  │         OMO (OpenCode plugin)               │  │
│  │                                             │  │
│  │  内部 Hook 分发层:                            │  │
│  │                                             │  │
│  │  chat.message ─────────→ 10+ 子 hook         │  │
│  │  messages.transform ───→ 5+ 子 hook          │  │
│  │  tool.execute.after ───→ 20+ 子 hook         │  │
│  │  tool.execute.before ──→ 5+ 子 hook          │  │
│  │                                             │  │
│  │  56 个内置 HookName:                           │  │
│  │  context-window-monitor, session-recovery,    │  │
│  │  runtime-fallback, ralph-loop, ...           │  │
│  │                                             │  │
│  │  每个可被 disabled_hooks 独立开关               │  │
│  └────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────┤
│  ┌──────────────────────┐                        │
│  │  image-interceptor    │  ← 独立插件，与 OMO 平级 │
│  │  (我们的插件)          │                        │
│  └──────────────────────┘                        │
└──────────────────────────────────────────────────┘
```

### OMO Hook 分发路由

利用 `chat.message` hook 时，OMO 内部分发到 10+ 子 handler（`chat-message.ts` 中）：

```typescript
// OMO 的 chat.message 入口 → 内部分发
await hooks.stopContinuationGuard?.["chat.message"]?.(input)
await hooks.backgroundNotificationHook?.["chat.message"]?.(input, output)
await hooks.runtimeFallback?.["chat.message"]?.(input, output)
await hooks.keywordDetector?.["chat.message"]?.(input, output)
await hooks.thinkMode?.["chat.message"]?.(input, output)
await hooks.claudeCodeHooks?.["chat.message"]?.(input, output)
// ... 共 10+ 个分发
```

`messages.transform` 同理（`messages-transform.ts` 中）：

```typescript
// OMO 的 messages.transform 入口 → 内部分发
await hooks.thinkingBlockValidator?.["experimental.chat.messages.transform"]?.(...)
await hooks.toolPairValidator?.["experimental.chat.messages.transform"]?.(...)
await hooks.contextInjectorMessagesTransform?.["experimental.chat.messages.transform"]?.(...)
// ...
```

### OMO 扩展能力

OMO 的扩展方式不是通用插件 API，而是：

| 扩展方式 | 机制 | 示例 |
|---|---|---|
| Skills | yaml/ts 文件放特定目录 | `playwright`, `git-master` |
| Agents 覆盖 | 配置覆盖内置 agent | `multimodal-looker: { model: "openai/gpt-5.5" }` |
| Categories | 配置定义任务路由 | `visual-engineering`, `deep` |
| MCPs | 内置 MCP manager | `context7`, `grep_app` |
| disabled_hooks | 关闭内置 hook | `"disabled_hooks": ["ralph-loop"]` |

**没有外部注册机制**。想加自己的 hook，只能 fork OMO 源码修改。

## OpenCode 图片处理管线

```
用户粘贴图片
  → TUI 将图片转为 image content part（base64 data URL）
  → 存入 session 数据库
  ↓
  LLM 调用开始时：
    1. 组装消息数组（system + user_history + current_user_message）
    2. experimental.chat.messages.transform hook 触发  ← 拦截点
    3. ProviderTransform.message() 调用 unsupportedParts()
       → 非 vision 模型：图片被替换为 "ERROR: Cannot read image..."
       → vision 模型：图片原样保留
    4. 消息发送给 LLM
```

**关键时序**：`messages.transform` hook (步骤2) 运行在 `unsupportedParts` (步骤3) **之前**。这是唯一能在图片被丢弃前拿到原始数据的机会。

## 探索过程

### 尝试 1：OMO 内置的 `multimodal-looker` agent + `look_at` 工具

**原理**：OMO 提供了 `multimodal-looker` subagent 和 `look_at` 工具。模型可以调用 `look_at(file_path="...", goal="...")` 来分析图片文件。

**失败原因**：
- `look_at` 是**被动工具**，需要模型主动调用
- 用户粘贴图片时，图片直接作为 `image` content part 进入消息
- 非 vision 模型收到的是 `"ERROR: Cannot read image..."` 的文本，而非原始图片
- 模型没有 `image_data` 可传给 `look_at`，也不知道该调用它
- Sisyphus 的 prompt 中完全没提到 `look_at`

```typescript
// unsupportedParts 替换逻辑（OpenCode transform.ts）
function unsupportedParts(msgs, model) {
  // 非 vision 模型 → 图片被替换为错误文本
  return { type: "text", text: "ERROR: Cannot read image..." }
}
```

### 尝试 2：Sisyphus `prompt_append`

**原理**：通过 OMO 配置给 Sisyphus 的 prompt 追加指令，教模型在遇到图片错误时调用 `look_at`。

```jsonc
{ "agents": { "sisyphus": { "prompt_append": "遇到图片请调 look_at..." } } }
```

**失败原因**：
- 非 vision 模型根本看不到图片，只看到错误文本
- 图片 base64 数据在 `unsupportedParts` 中已被丢弃，模型无法传给 `look_at`
- vision 模型（Claude Opus）能直接看到图片，没有动力去调 `look_at`

### 尝试 3：修改 OMO 源码 — `chat.message` hook 注入

**原理**：在 OMO 源码 `create-session-hooks.ts` 中注册新 hook，注入 `chat.message` 拦截点，检测 `output.parts` 中的图片，调用 multimodal-looker 分析后替换。

**改动范围**：
```
src/hooks/image-interceptor/hook.ts  (新增 ~160 行)
src/hooks/image-interceptor/index.ts (新增 1 行)
src/hooks/index.ts                   (+1 行 export)
src/plugin/hooks/create-session-hooks.ts (+5 处改动)
src/plugin/chat-message.ts           (+1 行 调用)
```

**部分成功**：
- Hook 注册成功，触发时机正确 ✅
- 能检测到图片 part ✅
- 能成功调用 multimodal-looker 子 session 完成分析 ✅
- **但修改不生效** —— DeepSeek 界面仍报错 ❌

**失败原因**：`chat.message` 的 `output.parts` 是**系统提示词**的消息体，不是用户消息。修改它不影响用户消息管线。用户消息在后续的 `unsupportedParts` 中独立处理。

### 尝试 4：修改 OMO 源码 — `messages.transform` hook 注入

**原理**：改用 `experimental.chat.messages.transform` hook，直接操作完整 `output.messages` 数组，在 `unsupportedParts` 之前找到用户消息中的图片 part，用分析文本替换。

**改动范围**（在尝试 3 基础上）：
```
src/hooks/image-interceptor/hook.ts  (重写，改用 messages.transform)
src/plugin/messages-transform.ts     (+8 行 hook 调用)
```

**成功**：
- `messages.transform` 可访问所有消息 ✅
- 运行在 `unsupportedParts` 之前，图片数据未被丢弃 ✅
- 替换图片为文本后，DeepSeek 正常接收并处理 ✅

**但存在的问题**：
- 需 fork OMO 源码、安装 bun 工具链、执行 `bun install && bun run build`
- 每次 OMO 更新需重新合并、构建
- Windows 上 `bun link` 可能因权限问题静默失败
- OMO 是编译为单文件 `.exe` 分发的，用户拿不到源码
- **对普通用户门槛太高**

### 尝试 5：独立 OpenCode 插件（最终方案）

**原理**：将尝试 4 的逻辑抽取为独立 OpenCode 插件，与 OMO 平级加载，零侵入。

```jsonc
// opencode.json
{
  "plugin": {
    "oh-my-openagent@latest": {},
    // ↓ 新增一行即可
    "file:///C:/Users/xxx/image-interceptor-plugin": {}
  }
}
```

**优势**：
- 不改 OMO 源码，不受 OMO 升级影响
- 不需要编译，`bun`/`bunx` 可直接加载 `.ts` 文件
- 仅 2 个文件（`package.json` + `index.ts`），共 ~130 行
- 配置即启用

### 两种实现路径对比

| | OMO 源码修改 | 独立插件 |
|---|---|---|
| 侵入性 | 修改 5 个文件，新增 2 个文件 | 不改任何现有代码 |
| 构建 | 需要 `bun install && bun run build` | 无需构建 |
| 升级 | OMO 更新后需重新合并 | 无影响 |
| 分发 | 给 patch 文件，用户手动 apply | 复制目录 + 一行配置 |
| 调试 | 改动分散在多文件 | 逻辑集中一个文件 |
| 适用场景 | OMO 开发者、深度定制 | **普通用户** |

## 最终实现

### 架构

```
┌──────────────────────────────────────────────────────────────┐
│                    image-interceptor 插件                      │
│                                                              │
│  experimental.chat.messages.transform                        │
│  ├─ 遍历 messages[] 找最新用户消息                              │
│  ├─ 检测 part.type === "file" && mime 以 image/ 开头           │
│  ├─ 跳过 agent === "multimodal-looker" 的消息（防递归）          │
│  ├─ 提取 data URL + mime type                                │
│  ├─ 创建子 session，发送给 multimodal-looker agent              │
│  ├─ 等待分析完成，读取 assistant 响应                           │
│  ├─ 替换原始 image part 为 text part（含分析结果）               │
│  └─ 清理                                                      │
└──────────────────────────────────────────────────────────────┘
```

### 核心代码结构

```
image-interceptor-plugin/
├── package.json          # { "name": "image-interceptor", "main": "index.ts" }
└── index.ts              # 插件逻辑 (~130 行)
    ├── isImageFile()     # 判断 part 是否为图片文件
    ├── getImageData()    # 提取 URL + mime
    ├── log()             # 写 %TEMP%/image-interceptor.log
    └── serverPlugin      # 主逻辑
        └── experimental.chat.messages.transform
```

### 关键设计决策

**1. 防无限循环**
```typescript
// 跳过 multimodal-looker agent 自己产生的消息
if (m.info?.agent === "multimodal-looker") continue
```

**2. 防重复处理**
```typescript
const seen = new Set<string>()  // sessionID → 已处理标记
if (seen.has(sid)) return
```

**3. 模型解析**
```typescript
// 从 OpenCode 注册的 agents 中查找 multimodal-looker 的模型配置
// 复用 OMO 的配置，不需要重复设置
const looker = agents.find(a => a.name.toLowerCase() === "multimodal-looker")
agentModel = looker.model   // { providerID: "openai", modelID: "gpt-5.5" }
```

**4. Part 替换**
```typescript
// 保留原始 part 的 id/sessionID/messageID，确保消息结构完整
output.messages[idx].parts = [
  ...nonImageParts,
  { type: "text", text: analysisText, id, sessionID, messageID }
]
```

### OpenCode 配置

```jsonc
{
  "plugin": {
    "file:///C:/Users/xxx/image-interceptor-plugin": {}
  }
}
```

插件通过 `file://` 协议直接加载 TypeScript 源文件，不需要编译。

### 性能影响

| 场景 | 耗时 | 说明 |
|---|---|---|
| 普通消息 | < 1ms | 扫描 messages 查找图片，O(n) 线性 |
| 有图消息 | 5-30s | 阻塞等待 vision 模型完成分析 |
| 日志写入 | < 1ms | `fs.appendFileSync` 写入几个字节 |

**有图时的延迟是设计行为**——必须等 vision 模型分析完才能告诉 DeepSeek 图片内容。

### 日志

输出到 `%TEMP%\image-interceptor.log`（Windows）或 `/tmp/image-interceptor.log`（Linux/macOS）。

```powershell
# 监控日志
Get-Content "$env:TEMP\image-interceptor.log" -Wait -Tail 20
```

## 相关 Hook 对比总结

| Hook | 能访问用户消息 | 能访问图片数据 | 能修改消息体 | 适用场景 |
|---|---|---|---|---|
| `chat.params` | ❌ | ❌ | ❌ | 调整模型参数 |
| `chat.message` | ❌ (只看到 system prompt) | ❌ | ❌ (改了无效) | 注入系统指令 |
| `tool.execute.before` | ❌ | ❌ | ❌ (只能改工具参数) | 工具拦截 |
| `experimental.chat.messages.transform` | ✅ | ✅ | ✅ | **图片拦截、消息改写** |

## 已知问题与改进方向

### 1. 超时处理（高优先级）

**现象**：multimodal-looker 子 session 卡死或超时时，主模型对话同步阻塞，用户界面假死。

**原因**：`session.prompt()` 是同步调用，阻塞在 `messages.transform` hook 中，OpenCode 等待 hook 返回才能继续。

**解决方向**：用 `AbortController` + `setTimeout` 包裹 prompt 调用：

```typescript
const ctl = new AbortController()
const timer = setTimeout(() => ctl.abort(new Error("image analysis timeout")), 60_000)
try {
  await (input.client as AnyObj).session.prompt({ ..., signal: ctl.signal })
} finally {
  clearTimeout(timer)
}
```

**风险**：不确定 OpenCode SDK 的 `session.prompt` 是否接受 `signal` 参数。

### 2. 非用户消息的图片（中优先级）

**当前行为**：只拦截 `role === "user"` 的消息。Skill 输出中的截图、子 task 返回的图片、Read 工具读到的图片——这些作为 `tool` 或 `assistant` role 的消息——不会被处理。

**影响**：长时间运行的 skill 或委托 task 返回的图片，DeepSeek 仍然看不到。

**解决方向**：去掉 `role === "user"` 限制，改为跳过 `agent === "multimodal-looker"`（防递归），其余所有 role 的消息都扫描图片：

```typescript
// 改前
if (m.info?.role !== "user") continue

// 改后
// 跳过 multimodal-looker 自己的消息即可，其余全部扫描
if (m.info?.agent === MULTIMODAL_LOOKER) continue
```

**风险**：工具返回中可能包含非图片二进制数据（以 `file` part 形式），需验证 `mime.startsWith("image/")` 过滤。

### 3. 子 Session 注册冲突（低优先级）

**现象**：OMO 日志中出现 `atlas skipped: session not registered in active boulder sessionid: {子sessionID}`。

**原因**：图片拦截器创建的临时子 session 未被 OMO 的 Atlas/team-mode 系统注册。OMO 跟踪所有 session 用于任务管理，未注册的子 session 会触发此警告。

**影响**：仅是日志噪声，不影响功能。子 session 分析完成后即被丢弃。

**解决方向**：
- 调低 OMO 日志级别（忽略 warning）
- 或在创建子 session 时检查 OMO 是否提供了注册 API
- 目前可忽略

### 4. 分析结果缓存（低优先级）

**现象**：同一张图片发送多次 → 每次重新分析。

**影响**：浪费 API 调用和等待时间。

**解决方向**：对图片 data URL 做 hash，缓存分析结果：

```typescript
import { createHash } from "crypto"

const cache = new Map<string, string>()

function cacheKey(url: string): string {
  return createHash("md5").update(url).digest("hex").slice(0, 16)
}

// 在分析前检查缓存
const key = cacheKey(data.url)
if (cache.has(key)) {
  results.push(cache.get(key)!)
  continue
}
// 分析...
cache.set(key, text)
```

**风险**：同一 URL 可能指向不同图片（少见）；缓存无过期机制，长期运行会内存泄漏。加 LRU 或 TTL 可解决。

### 5. 错误降级

**当前行为**：multimodal-looker 分析失败时静默跳过，用户消息中图片 part 被保留（随后被 `unsupportedParts` 替换为错误文本）。

**改进方向**：分析失败时注入一条清晰的降级消息，告知主模型发生了什么：

```typescript
if (results.length === 0) {
  // 不改动 parts，让 unsupportedParts 正常处理
  // 但追加一条提示，帮助模型做出更好的回应
  output.messages[idx].parts.push({
    type: "text",
    text: "[Image analysis was attempted but failed. The model cannot see this image.]",
    id: ...,
    sessionID: ...,
    messageID: ...,
  })
}
```

### 问题优先级总结

| 优先级 | 问题 | 症状 | 用户感知 |
|---|---|---|---|
| 🔴 高 | 超时处理 | 界面假死 | 明显 |
| 🟡 中 | 非用户消息图片 | Skill 截图看不到 | 有影响 |
| 🟢 低 | 子 session 注册冲突 | 日志噪声 | 无 |
| 🟢 低 | 分析结果缓存 | 重复分析浪费 | 轻微 |
| 🟢 低 | 错误降级 | 分析失败后体验差 | 偶尔 |

# image-interceptor — V2 架构文档

## 概述

image-interceptor 是一个 OpenCode 插件，拦截非 vision 模型对话中的图片消息，将图片发送给 vision-capable 子 agent 进行内容分析，然后将分析结果以文本形式交还给主模型继续处理。

## 数据流

```
用户发图
  → OpenCode 存入 session DB
  → LLM 调用前触发 experimental.chat.messages.transform
  → 插件扫描 messages[] 找到非 looker agent 的图片消息
  → 创建子 session → 发送图片 + system prompt 给 vision agent
  → 等待分析完成 → 提取 text/reasoning 内容
  → 替换原始 image part 为 text part（分析结果）
  → 主模型收到文本描述，继续对话
```

## 关键时序

`messages.transform` 运行在 OpenCode 的 `unsupportedParts()` 之前——这是唯一能在图片被替换为 "ERROR: Cannot read image..." 前拿到原始图片数据的机会。

## 文件结构

```
image-interceptor-plugin/
  index.ts       # 单一源文件，~400 行
  package.json   # { "name": "image-interceptor", "main": "index.ts" }
  tsconfig.json  # TypeScript 配置
```

运行时副本：`~/.opencode/plugins/image-interceptor.ts`

## 核心模块

### 常量

| 常量 | 值 | 说明 |
|:---|:---|:---|
| `DEFAULT_AGENT` | `"image-looker"` | 默认使用的 vision agent 名 |
| `ANALYSIS_TIMEOUT_MS` | `60_000` | 单张图片分析超时 |
| `MAX_RETRIES` | `2` | 分析失败最大重试次数 |
| `IMAGE_ANALYSIS_SYSTEM_PROMPT` | （见代码） | 图片分析 system prompt，通过 `body.system` 传入子 session |

### 关键函数

| 函数 | 职责 |
|:---|:---|
| `findImageFromOtherAgent()` | 反向扫描 messages 数组，找**非** looker agent 的用户消息中的图片。跳过 `agent === agentName` 的消息（防递归） |
| `extractAssistantText()` | 从 assistant 响应中提取文本。优先取 text parts；若 text 含 tool-call 模板（`</tool_call>` / `<arg_key>`）则跳过，改用 reasoning parts |
| `analyzeSingleImage()` | 核心：创建子 session → 组装 prompt → 等待结果 → 提取文本 |
| `analyzeWithRetry()` | 带重试的包装，区分可重试/不可重试错误 |
| `promptWithTimeout()` | 用 `AbortController` 包裹 `session.prompt()`，超时 60s 自动取消 |

### 防递归机制

1. **Agent 过滤**：`findImageFromOtherAgent` 跳过 `m.info.agent === agentName` 的消息，子 session 自身的消息不会被处理
2. **Session 去重**：`seen` Set 记录已处理的 sessionID，同一 session 只处理一次（同一轮对话多张图共用一次分析，因为图片 part 已被替换为文本）

### 错误分类

| 错误类型 | 可重试？ | 场景 |
|:---|:---:|:---|
| `NonRetryableError` | 否 | 空响应、无 assistant 消息 |
| `AbortError` | 否 | 超时 |
| 其他 Error | 是 | 网络异常、服务端临时错误 |

### 降级路径

- **部分成功**：分析结果包裹在 `[Image analysis results]` 中，失败图片标注 `[Note: n/N image(s) could not be analyzed.]`
- **全部失败**：注入降级消息，告知主模型所有分析尝试失败，提示询问用户描述图片

### System Prompt 组装

子 session 的 system prompt 最终由三层拼接（OpenCode 框架行为，`request.ts:56-64`）：

```
① agent.prompt（若配置）|| provider 默认 prompt
② 框架 env + CLAUDE.md + skills
③ 插件 body.system（IMAGE_ANALYSIS_SYSTEM_PROMPT）
```

插件不依赖 agent 的 `prompt` 配置——用户只需在 opencode.json 的 agent 定义中指定 `model`，无需配 `prompt`。

## 配置

### opencode.json

```jsonc
{
  "agent": {
    "image-looker": {
      "model": "zhipuai/glm-4.6v"
    }
  }
  // 或通过 ~/.opencode/plugins/ 目录自动发现
}
```

### 插件 options

| 参数 | 类型 | 默认值 | 说明 |
|:---|:---|:---|:---|
| `agent` | `string` | `"image-looker"` | 用于分析图片的 vision agent 名 |

```jsonc
{ "plugin": [["file:///path/to/plugin", { "agent": "my-vision-agent" }]] }
```

## 调试

日志输出到 `/tmp/image-interceptor.log`：

```bash
tail -f /tmp/image-interceptor.log
```

典型正常日志：
```
[loaded] {"agent":"image-looker","directory":"..."}
[ok] {"len":1234}
```

错误时额外输出：`failed`、`empty assistant text`、`degraded`、`fatal`。

## 已知兼容性问题

| 模型 | 问题 | 处理方式 |
|:---|:---|:---|
| GLM-4.6V | text part 输出 tool-call 模板，实际分析在 reasoning part | `extractAssistantText` 检测 tool-call 标记后 fallback 到 reasoning |
| MiniMax-M2.7 | text part 可能为空，分析在 reasoning part | `extractAssistantText` text 为空时 fallback 到 reasoning |

## 变更历史

| 版本 | 关键改动 |
|:---|:---|
| V1 | 初始实现：图片拦截 → 子 session 分析 → 文本替换 |
| V2 | 删除 `types.d.ts`，`system` 字段传 prompt，`findImageFromOtherAgent` 重命名，reasoning fallback，tool-call 检测 |

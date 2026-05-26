# image-interceptor

OpenCode 插件。为纯文本主模型（DeepSeek、GLM 等）转述用户发送的截图内容。

## 解决的问题

纯文本模型无法处理图片消息。OpenCode 在发送给这类模型前会把图片替换为 `[ERROR: Cannot read image...]`，模型无法知道图片内容，需要用户手动描述。

该插件在图片被丢弃前拦截消息，将图片交给 vision agent 分析，分析结果以文本形式替换原始图片 part。主模型收到的是一条文本消息，内容是图片的结构化描述。

## 使用方式

将 `image-interceptor.ts` 放入 `~/.opencode/plugins/`，或在 `opencode.json` 中指定路径：

```jsonc
{
  "agent": {
    "image-looker": {
      "model": "zhipuai/glm-4.6v"
    }
  }
}
```

`model` 可以是任意 vision-capable 模型。`image-looker` 是插件默认查找的 agent 名，可通过 options 覆盖。

## 工作流程

1. 用户在主模型对话中发送截图
2. `experimental.chat.messages.transform` hook 检测到图片
3. 创建子 session，将图片和 system prompt 发送给 vision agent
4. vision agent 返回分析文本
5. 插件用分析文本替换原始图片 part
6. 主模型收到文本描述，继续推理

整个过程对用户透明，不改变对话流程。

## 关键设计

**防递归**：子 session 触发同一条 hook，插件会跳过来自自身 agent 的消息。

**去重**：同一 session 只处理一次。图片被替换为文本后，后续轮次不再看到原始图片 part。

**响应提取**：优先取 assistant 的 text part；如果 text 内容为 tool-call 模板（GLM-4.6V 常见），fallback 到 reasoning part。

**超时与重试**：单张图片分析有 60s 超时，非致命错误重试最多 2 次。

**缓存**：同一张图片（基于 URL 前 200 字符的 MD5）只分析一次。

**降级**：分析全部失败时注入提示消息，告知主模型无法获取图片内容。

## 依赖

- OpenCode 运行时（插件 API）
- 一个 vision-capable agent（插件不内置模型，模型由用户配置）

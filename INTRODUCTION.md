# 一个为非多模态主模型转述图片的插件

## 背景

用 OpenCode 编程时，很多人选择 DeepSeek 或 GLM 作为主模型——成本低、代码能力不错。但这些模型是纯文本的，不支持图像输入。

问题来了：讨论 UI 改动的需求单截图、调试时的报错界面、同事发来的设计稿——发到对话里，主模型收到的是 `[ERROR: Cannot read image data...]`。你只能口头描述图片内容，或者手动调用 vision 工具分析后再粘贴结果。

## 实现

这个插件做的事很简单：在消息发给主模型之前，把图片截下来，交给一个 vision agent 做分析，分析结果换成文本放回消息里。主模型看到的是一段"这张图里有 xyz"的文字，而不是一个它处理不了的 image part。

数据路径如下：

```
用户发图 → OpenCode 消息管线
              ↓
  messages.transform hook（图片仍在）
              ↓
  创建子 session → vision agent 分析
              ↓
  分析结果文本替换原始 image part
              ↓
          主模型 ← 纯文本描述
```

## 关键决策

**为什么是独立插件而不是改 OMO 源码**：OMO 内置的 `multimodal-looker` agent 和 `look_at` 工具依赖模型主动调用——但纯文本模型根本不知道图里有什么，不会触发工具。用插件在消息层面拦截，完全不依赖主模型行为。

**为什么 hook 点选 `experimental.chat.messages.transform`**：这是唯一能在 OpenCode 的 `unsupportedParts()` 逻辑之前访问完整消息数组的 hook。其他 hook 要么只看到 system prompt，要么时机太晚图片已被丢弃。

**为什么 system prompt 内置在插件里**：插件不依赖 agent 配置中的 prompt 字段。用户只需指定用哪个 vision 模型，prompt 由插件自带。这降低了配置门槛——一行 `model` 即用。

## 使用

`image-interceptor.ts` 放入 `~/.opencode/plugins/` 目录即可。OpenCode 会通过 Bun 的 TypeScript 原生支持直接加载。

opencode.json 配置：

```jsonc
{
  "agent": {
    "image-looker": {
      "model": "zhipuai/glm-4.6v"
    }
  }
}
```

支持任意 vision-capable 模型。多张图片可批量分析，同一图片自动缓存避免重复调用。

## 限制

- 依赖 `messages.transform` 这个标记为 experimental 的 hook，OpenCode API 变更可能影响兼容性
- 图片分析需等待 vision 模型响应（通常数秒），首次发图时消息会短暂延迟
- 不支持 PDF 或其他非图片文件类型

## 与 OMO 的关系

该插件与 OMO 是平级关系，不依赖 OMO，也不与 OMO 冲突。如果 OMO 启用了 `multimodal-looker` agent，插件会复用其模型配置；如果没有 OMO，只需在 opencode.json 中自行定义 `image-looker` agent。

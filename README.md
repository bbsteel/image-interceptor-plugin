# image-interceptor

OpenCode plugin. Routes images sent by the user to a vision-capable agent for analysis, then pipes the text description back to the primary text-only model.

## Problem

Text-only models (DeepSeek, GLM, etc.) cannot process image messages. OpenCode replaces images with `[ERROR: Cannot read image data...]` before sending to these models, leaving the model unable to understand visual content without manual user description.

This plugin intercepts images before they are discarded, sends them to a vision agent, and replaces the original image part with the analysis text. The primary model receives a structured text description instead of an error.

## Usage

Place `index.ts` in `~/.opencode/plugins/`, or reference it in `opencode.json`:

```jsonc
{
  "agent": {
    "image-looker": {
      "model": "zhipuai/glm-4.6v"
    }
  }
}
```

`model` can be any vision-capable model. `image-looker` is the default agent name; override it via plugin options.

## How It Works

1. User sends an image in a conversation with a text-only model
2. The `experimental.chat.messages.transform` hook detects the image
3. A child session is created; the image and a system prompt are sent to the vision agent
4. The vision agent returns analysis text
5. The plugin replaces the original image part with the text result
6. The primary model receives the text description and continues

The process is transparent to the user.

## Design Notes

**Recursion guard**: The child session triggers the same hook. The plugin skips messages originating from its own agent.

**Deduplication**: Each session is processed once. After the image part is replaced with text, subsequent turns see no image.

**Response extraction**: Prefers `text` parts from the assistant response. Falls back to `reasoning` parts if text contains tool-call templates (observed with GLM-4.6V) or is empty.

**Timeout and retry**: 60-second timeout per image via `AbortController`. Up to 2 retries for transient errors.

**Caching**: Same image (MD5 of first 200 chars of the data URL) is analyzed only once per session.

**Degradation**: If all analysis attempts fail, a message is injected informing the primary model that image content is unavailable.

## Dependencies

- OpenCode runtime (plugin API)
- A vision-capable agent (model not bundled; configured by user)

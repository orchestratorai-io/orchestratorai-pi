/** Ollama enables Qwen's default thinking when Pi omits reasoning_effort. */
export function ollamaThinkingPayload(
  payload: unknown,
  model: { provider: string; api: string; id: string } | undefined,
  thinking: string,
): object | undefined {
  if (thinking !== "off" || model?.provider !== "ollama" || model.api !== "openai-completions" ||
      !/^qwen3\.[56](?::|$)/.test(model.id) ||
      !payload || typeof payload !== "object" || Array.isArray(payload)) return;
  return { ...payload, reasoning_effort: "none" };
}

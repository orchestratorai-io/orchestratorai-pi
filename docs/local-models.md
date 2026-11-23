# Local model setup

OrchestratorAI Pi is local-model-first, but model configuration is machine-specific and must not be committed to this repository.

Pi currently supports local OpenAI-compatible servers such as Ollama, LM Studio, and vLLM through `~/.pi/agent/models.json`. It also supports a llama.cpp router. Keep the server bound to `127.0.0.1` unless the legal machine has an explicit, reviewed network requirement.

## Ollama-compatible example

Add a provider to `~/.pi/agent/models.json` using the model actually installed on the legal machine:

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://127.0.0.1:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        {
          "id": "REPLACE_WITH_INSTALLED_MODEL",
          "reasoning": false
        }
      ]
    }
  }
}
```

Then select the model in Pi with `/model`, or pass `--model ollama/REPLACE_WITH_INSTALLED_MODEL`.

## The Pi app's default model

The Mac app's "Local model" box starts at `qwen3.6:35b-mlx` (`ContentView.defaultModel` in `Sources/Pi/PiApp.swift`), the model installed in Ollama on the Mac Studio since 2026-11-23. Type another installed model's name into the box to use it instead. Workflows that pin a model in their YAML, such as `.pi/workflows/prep-probe-qwen36.yaml`, use that model regardless of the box.

## Legal review cautions

- Local execution reduces exposure to an external provider, but it does not make the machine automatically secure.
- Use encrypted storage, access controls, backups, and a retention policy appropriate for privileged legal material.
- Review model quality on representative synthetic contracts before using real client material.
- Keep cloud providers disabled unless the user explicitly enables one for a defined purpose.


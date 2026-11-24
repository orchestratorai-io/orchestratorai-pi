import Foundation

/// What the app's "Local model" box holds, split into Pi's `--provider` and `--model`.
///
/// `ollama/qwen3-coder-next:q4_K_M` or `lmstudio/qwen3-8b` name the provider (an id in
/// `~/.pi/agent/models.json`) before the first slash; `qwen3.6:35b-mlx` has no slash and
/// runs on Ollama. The model part may itself contain slashes (`spark-vllm/Qwen/Qwen3.8-27B-FP8`).
/// One exception: a prefix with a dot is a registry host, not a provider
/// (`hf.co/user/model:tag`, which Ollama pulls by that whole name), so it stays on Ollama.
struct LocalModelReference: Equatable {
    static let defaultProvider = "ollama"

    let provider: String
    let model: String

    init(provider: String, model: String) {
        self.provider = provider
        self.model = model
    }

    init(_ boxValue: String) {
        let value = boxValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let slash = value.firstIndex(of: "/") else {
            self.init(provider: Self.defaultProvider, model: value)
            return
        }
        let prefix = String(value[..<slash])
        let rest = String(value[value.index(after: slash)...])
        if prefix.isEmpty {
            // "/qwen3.6" - no provider named: the default, with the stray slash dropped.
            self.init(provider: Self.defaultProvider, model: rest)
        } else if prefix.contains(".") || rest.isEmpty {
            self.init(provider: Self.defaultProvider, model: value)
        } else {
            self.init(provider: prefix, model: rest)
        }
    }

    /// The arguments `launchPi` passes to `pi`.
    var arguments: [String] { ["--provider", provider, "--model", model] }
}

import XCTest
@testable import Pi

/// 2026-11-23 review items 12, 13, 15, 16: opening runs, the workflow catalog,
/// the local model's provider, and the answer-prep model in deposition-prep.
final class WorkflowsAndModelsTests: XCTestCase {

    private func run(_ workflow: String, params: [String: String] = [:]) -> RunRecord {
        RunRecord(id: "run-\(workflow)", workflow: workflow, title: "t", sourceDocument: nil, params: params, model: nil,
                  piRunId: nil, status: "failed", error: nil, resultMarkdown: nil, agents: nil, resumes: 0,
                  createdAt: "2026-11-23T00:00:00Z", startedAt: nil, completedAt: nil, updatedAt: "2026-11-23T00:00:00Z")
    }

    private var repoRoot: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    }

    /// A throwaway project with only the given `.pi/workflows` files.
    private func project(_ files: [String: String]) throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("pi-catalog-\(UUID().uuidString)")
        let workflows = dir.appendingPathComponent(".pi/workflows")
        try FileManager.default.createDirectory(at: workflows, withIntermediateDirectories: true)
        for (name, text) in files {
            try text.write(to: workflows.appendingPathComponent(name), atomically: true, encoding: .utf8)
        }
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        return dir
    }

    private func workflowYAML(name: String, launch: String?, params: String = "  - { name: document }\n") -> String {
        var text = "name: \(name)\ndescription: d\nparams:\n\(params)"
        if let launch {
            text += "doc: |-\n  Notes.\n\n" + launch.split(separator: "\n", omittingEmptySubsequences: false).map { "  \($0)" }.joined(separator: "\n") + "\n"
        }
        text += "profile: p\ntask: t\n"
        return text
    }

    // MARK: 12. Opening a run

    func testOpeningARunKeepsItsSavedParamsOverItsOwnWorkflowDefaults() throws {
        let dir = try project(["deposition-prep.yaml": workflowYAML(name: "deposition-prep", launch: """
            ```orchestrator-launch
            group: litigation
            file: { kind: none }
            fields:
              - { param: witness, label: Witness, kind: line, default: "Dana Ruiz" }
              - { param: mode, label: Mode, kind: choice, options: [Preparation outline, Predicted cross-exam] }
            ```
            """, params: "  - { name: witness, required: true }\n  - { name: mode, default: Preparation outline }\n")])
        let launch = try XCTUnwrap(LegalWorkflowCatalog.workflow(id: "deposition-prep", projectDirectory: dir)?.launch)
        let opened = run("deposition-prep", params: ["witness": "Lee Park", "mode": "Predicted cross-exam"])
        let values = launch.values(opening: opened)
        XCTAssertEqual(values["witness"], "Lee Park")
        XCTAssertEqual(values["mode"], "Predicted cross-exam")
        XCTAssertEqual(launch.values(opening: nil)["witness"], "Dana Ruiz")
    }

    func testSwitchingIntoTheOpenRunsWorkflowIsOpeningNotLeaving() {
        // onChange(of: selectedWorkflow) skips its reset in exactly this case.
        XCTAssertTrue(DetailSelection.isOpening(run("deposition-prep"), workflow: "deposition-prep"))
        XCTAssertFalse(DetailSelection.isOpening(run("deposition-prep"), workflow: "kb-query"))
        XCTAssertFalse(DetailSelection.isOpening(nil, workflow: "kb-query"))
    }

    func testARunWhoseWorkflowIsNotInTheCatalogIsStillShown() {
        let catalog = [WorkflowDefinition(id: "contract-review", title: "Contract Review", icon: "i", description: "",
                                          groupId: "document-management", status: .comingSoon, launch: nil)]
        let inline = run("inline")
        let active = DetailSelection.activeWorkflow(selected: "inline", openRun: inline, in: catalog)
        XCTAssertNil(active, "an inline run must not be framed as Contract Review")
        XCTAssertEqual(DetailSelection.displayedRun(inline, selectedWorkflow: "inline", activeWorkflow: active)?.id, inline.id)
        // A run from another workflow is not shown under this one.
        XCTAssertNil(DetailSelection.displayedRun(run("kb-query"), selectedWorkflow: "contract-review", activeWorkflow: catalog[0]))
        // With nothing open, an unknown selection still falls back to Contract Review.
        XCTAssertEqual(DetailSelection.activeWorkflow(selected: "gone", openRun: nil, in: catalog)?.id, "contract-review")
    }

    // MARK: 13. Workflow catalog

    func testCustomGroupsAreShownAfterLegalsFive() {
        let make = { (id: String, group: String) in
            WorkflowDefinition(id: id, title: id, icon: "i", description: "", groupId: group, status: .comingSoon, launch: nil)
        }
        let sections = LegalWorkflowCatalog.sidebarSections(for: [
            make("a", "litigation"), make("b", "tax-and-estates"), make("c", "document-management"), make("d", "tax-and-estates"), make("e", "hr"),
        ])
        XCTAssertEqual(sections.map(\.group.id), ["document-management", "litigation", "tax-and-estates", "hr"])
        XCTAssertEqual(sections[2].group.name, "Tax And Estates")
        XCTAssertEqual(sections[2].items.map(\.id), ["b", "d"])
        XCTAssertEqual(sections[3].group.name, "Hr")
    }

    func testExtraWorkflowsAreKeyedByTheirYAMLName() throws {
        let launch = "```orchestrator-launch\ngroup: tax\n```"
        let dir = try project([
            "my-file.yaml": workflowYAML(name: "tax-review", launch: launch),
            "copy-of-tax.yaml": workflowYAML(name: "tax-review", launch: launch),
        ])
        let extras = LegalWorkflowCatalog.workflows(projectDirectory: dir).filter { $0.groupId == "tax" }
        XCTAssertEqual(extras.map(\.id), ["tax-review"], "keyed by name: and listed once")
        XCTAssertTrue(extras[0].isReady)
    }

    func testABrokenLaunchBlockGivesNoSpecAndTheWorkflowIsNotReady() throws {
        let dir = try project([
            "contract-review.yaml": workflowYAML(name: "contract-review", launch: "```orchestrator-launch\ngroup: [unclosed\n```"),
            "due-diligence.yaml": workflowYAML(name: "due-diligence", launch: "```orchestrator-launch\ngroup: transactional\nfile: { kind: folder }"),
            "deal-memo.yaml": workflowYAML(name: "deal-memo", launch: "```orchestrator-launch\njust a sentence\n```"),
            "kb-query.yaml": workflowYAML(name: "kb-query", launch: nil),
        ])
        let catalog = LegalWorkflowCatalog.workflows(projectDirectory: dir)
        for id in ["contract-review", "due-diligence", "deal-memo"] {
            let entry = try XCTUnwrap(catalog.first { $0.id == id })
            XCTAssertNil(entry.launch, id)
            XCTAssertFalse(entry.isReady, id)
        }
        // No launch block at all is not broken: the generic file launch, Ready.
        XCTAssertTrue(try XCTUnwrap(catalog.first { $0.id == "kb-query" }).isReady)
    }

    func testRequiredFieldsAreCheckedForFileAndFolderWorkflowsToo() throws {
        let params = "  - { name: document }\n  - { name: matter, required: true }\n"
        for kind in ["file", "folder"] {
            let dir = try project(["w.yaml": workflowYAML(name: "w", launch: """
                ```orchestrator-launch
                group: tax
                file: { kind: \(kind), param: document }
                fields:
                  - { param: matter, label: Matter, kind: line }
                ```
                """, params: params)])
            let launch = try XCTUnwrap(WorkflowLaunchSpec.load(from: dir.appendingPathComponent(".pi/workflows/w.yaml")))
            XCTAssertEqual(launch.inputKind.rawValue, kind)
            XCTAssertFalse(launch.canStart(hasInput: true, values: ["matter": "  "]), kind)
            XCTAssertFalse(launch.canStart(hasInput: false, values: ["matter": "Acme"]), kind)
            XCTAssertTrue(launch.canStart(hasInput: true, values: ["matter": "Acme"]), kind)
        }
    }

    func testEveryShippedWorkflowStillLoadsAsReady() throws {
        // The stricter launch-block parsing must not take any shipped workflow off the list.
        let catalog = LegalWorkflowCatalog.workflows(projectDirectory: repoRoot)
        XCTAssertGreaterThanOrEqual(catalog.count, 14)
        for entry in catalog { XCTAssertTrue(entry.isReady, entry.id) }
        XCTAssertNotNil(catalog.first { $0.id == "kb-query" })
    }

    // MARK: 15. Provider in the Local model box

    func testABareModelNameRunsOnOllama() {
        XCTAssertEqual(LocalModelReference("qwen3.6:35b-mlx"), LocalModelReference(provider: "ollama", model: "qwen3.6:35b-mlx"))
        XCTAssertEqual(LocalModelReference("  qwen3.6:35b-mlx \n").arguments, ["--provider", "ollama", "--model", "qwen3.6:35b-mlx"])
    }

    func testAProviderPrefixIsPassedAsTheProvider() {
        // docs/local-models.md writes `ollama/<model>`; that must not become ollama/ollama/<model>.
        XCTAssertEqual(LocalModelReference("ollama/qwen3-coder-next:q4_K_M"), LocalModelReference(provider: "ollama", model: "qwen3-coder-next:q4_K_M"))
        XCTAssertEqual(LocalModelReference("lmstudio/qwen3-8b"), LocalModelReference(provider: "lmstudio", model: "qwen3-8b"))
        // Only the first slash separates; vLLM model ids carry their own.
        XCTAssertEqual(LocalModelReference("spark-vllm/Qwen/Qwen3.8-27B-FP8"), LocalModelReference(provider: "spark-vllm", model: "Qwen/Qwen3.8-27B-FP8"))
    }

    func testRegistryHostsAndStraySlashesStayOnOllama() {
        XCTAssertEqual(LocalModelReference("hf.co/unsloth/Qwen3-8B-GGUF:Q4_K_M"), LocalModelReference(provider: "ollama", model: "hf.co/unsloth/Qwen3-8B-GGUF:Q4_K_M"))
        XCTAssertEqual(LocalModelReference("/qwen3.6"), LocalModelReference(provider: "ollama", model: "qwen3.6"))
        XCTAssertEqual(LocalModelReference("ollama/"), LocalModelReference(provider: "ollama", model: "ollama/"))
    }

    // MARK: 16. deposition-prep's answer-prep model

    func testDepositionPrepOffersPrepModelDefaultingToTheModelThatPassedTheGuard() throws {
        let passed = "ollama/qwen3-coder-next:q4_K_M"
        let readme = try String(contentsOf: repoRoot.appendingPathComponent("README.md"), encoding: .utf8)
        XCTAssertTrue(readme.contains("qwen3-coder-next"), "the README still records which model passed")
        let launch = try XCTUnwrap(LegalWorkflowCatalog.workflow(id: "deposition-prep", projectDirectory: repoRoot)?.launch)
        XCTAssertEqual(launch.params["prep_model"], passed)
        let field = try XCTUnwrap(launch.fields.first { $0.param == "prep_model" })
        XCTAssertEqual(field.kind, .choice)
        XCTAssertEqual(field.defaultValue, passed)
        XCTAssertEqual(field.options, [passed, "Local model box"])
        XCTAssertFalse(launch.requiredParams.contains("prep_model"))

        // Only the answer-prep step pins it: every other step stays on the Local model box.
        let yaml = try String(contentsOf: repoRoot.appendingPathComponent(".pi/workflows/deposition-prep.yaml"), encoding: .utf8)
        let pins = yaml.components(separatedBy: .newlines).filter { $0.trimmingCharacters(in: .whitespaces).hasPrefix("model:") }
        XCTAssertEqual(pins.map { $0.trimmingCharacters(in: .whitespaces) }, ["model: \"\(passed)\""])
    }
}

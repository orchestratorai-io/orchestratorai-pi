import Foundation

/// Honest install status for Legal catalog entries.
enum WorkflowInstallStatus: String, Hashable {
    case ready
    case comingSoon

    var label: String {
        switch self {
        case .ready: return "Ready"
        case .comingSoon: return "Coming soon"
        }
    }
}

struct WorkflowGroupDefinition: Identifiable, Hashable {
    let id: String
    let name: String
    let sortOrder: Int
}

struct WorkflowDefinition: Identifiable, Hashable {
    let id: String
    let title: String
    let icon: String
    let description: String
    let groupId: String
    let status: WorkflowInstallStatus
    /// Present only when `.pi/workflows/{id}.yaml` exists; carries the launch UI.
    let launch: WorkflowLaunchSpec?

    var isReady: Bool { status == .ready && launch != nil }
    var fileLabel: String { launch?.fileLabel ?? "document" }
}

/// Legal's 14-workflow product registry. Titles, icons, and descriptions for
/// Ready entries are overridden by the workflow YAML's own launch block, so the
/// registry only has to be right about *what we offer*, not how each launches.
enum LegalWorkflowCatalog {
    static let groups: [WorkflowGroupDefinition] = [
        WorkflowGroupDefinition(id: "document-management", name: "Document Management", sortOrder: 0),
        WorkflowGroupDefinition(id: "transactional", name: "Transactional", sortOrder: 1),
        WorkflowGroupDefinition(id: "litigation", name: "Litigation", sortOrder: 2),
        WorkflowGroupDefinition(id: "compliance-risk", name: "Compliance & Risk", sortOrder: 3),
        WorkflowGroupDefinition(id: "research-knowledge", name: "Research & Knowledge", sortOrder: 4),
    ]

    private static let seed: [(id: String, title: String, icon: String, description: String, groupId: String)] = [
        ("document-onboarding", "Document Onboarding", "doc.badge.plus",
         "Classify, inventory, check completeness, and hand counsel a prioritized intake checklist.", "document-management"),
        ("contract-review", "Contract Review", "checklist",
         "Red/Blue issue spotting, arbitration, and a shared attorney-review checkpoint.", "document-management"),
        ("due-diligence", "Due Diligence", "magnifyingglass.circle",
         "Comprehensive due diligence analysis across document sets.", "transactional"),
        ("deal-memo", "Deal Memo", "doc.richtext",
         "Generate deal memos from due diligence findings.", "transactional"),
        ("adversarial-brief", "Brief Stress Test", "flame",
         "Red-team stress testing of legal briefs and arguments.", "litigation"),
        ("discovery-review", "Discovery Review", "tray.full",
         "Document review and classification for litigation.", "litigation"),
        ("deposition-prep", "Deposition Prep", "person.wave.2",
         "Prepare witnesses and anticipate cross-examination.", "litigation"),
        ("cross-exam-simulation", "Cross-Exam Simulation", "person.2.wave.2",
         "Simulate adversarial cross-examination scenarios.", "litigation"),
        ("monte-carlo-trial-simulator", "Trial Simulator", "chart.line.uptrend.xyaxis",
         "Monte Carlo simulation of trial outcomes.", "litigation"),
        ("persistent-case-team", "Matters", "briefcase",
         "Persistent case teams with ongoing matter management.", "litigation"),
        ("compliance-audit", "Compliance Audit", "checkmark.shield",
         "Regulatory compliance auditing against GDPR, HIPAA, SOX.", "compliance-risk"),
        ("sentinel", "Portfolio Sentinel", "eye",
         "Continuous monitoring of contract portfolios.", "compliance-risk"),
        ("legal-research", "Legal Research", "books.vertical",
         "Deep legal research with cited sources.", "research-knowledge"),
        ("kb-query", "Knowledge Base Query", "text.book.closed",
         "Ask questions against the firm knowledge base.", "research-knowledge"),
    ]

    /// Workflows whose runs are kept out of every run list a buyer sees. These are the
    /// per-model prep probes (`.pi/workflows/prep-probe-*.yaml`): engineering experiments
    /// comparing local models, not product workflows. Their runs and YAML stay on disk.
    static let hiddenFromRunList: Set<String> = [
        "prep-probe-qwen36",
        "prep-probe-qwen38",
        "prep-probe-coder",
    ]

    static func isHiddenFromRunList(_ workflowId: String) -> Bool {
        hiddenFromRunList.contains(workflowId)
    }

    /// Also hides the "inline … (resumed)" rows an older extension created by mistake on
    /// every resume (the resume itself was journalled on the original run). They stay in the
    /// store, hidden, not deleted. The extension no longer creates them.
    static func isHiddenFromRunList(_ run: RunRecord) -> Bool {
        isHiddenFromRunList(run.workflow) || isResumeArtifact(run)
    }

    static func isResumeArtifact(_ run: RunRecord) -> Bool {
        run.workflow == "inline" && run.title.hasSuffix(" (resumed)")
    }

    static func workflows(projectDirectory: URL) -> [WorkflowDefinition] {
        let workflowsDir = projectDirectory.appendingPathComponent(".pi/workflows")
        var definitions = seed.map { entry -> WorkflowDefinition in
            let yamlURL = workflowsDir.appendingPathComponent("\(entry.id).yaml")
            let launch = FileManager.default.fileExists(atPath: yamlURL.path) ? WorkflowLaunchSpec.load(from: yamlURL) : nil
            return WorkflowDefinition(
                id: entry.id,
                title: launch?.title ?? entry.title,
                icon: launch?.icon ?? entry.icon,
                description: launch.map { $0.description.isEmpty ? entry.description : $0.description } ?? entry.description,
                groupId: launch.flatMap { $0.groupId.isEmpty ? nil : $0.groupId } ?? entry.groupId,
                status: launch == nil ? .comingSoon : .ready,
                launch: launch
            )
        }

        // Any additional project workflow that carries a launch block is offered too,
        // so a Mac user who authors their own YAML sees it without touching the app.
        // They are keyed by the YAML's `name:`, not the file name: that name is what Pi runs
        // and what the store records as the run's workflow, so runs find their catalog entry.
        var known = Set(definitions.map(\.id))
        let extra = ((try? FileManager.default.contentsOfDirectory(at: workflowsDir, includingPropertiesForKeys: nil)) ?? [])
            .filter { $0.pathExtension == "yaml" || $0.pathExtension == "yml" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        for url in extra {
            guard let launch = WorkflowLaunchSpec.load(from: url), !launch.groupId.isEmpty else { continue }
            let id = launch.workflowName
            guard !known.contains(id) else { continue }
            known.insert(id)
            definitions.append(WorkflowDefinition(
                id: id, title: launch.title, icon: launch.icon, description: launch.description,
                groupId: launch.groupId, status: .ready, launch: launch
            ))
        }
        return definitions
    }

    /// The sidebar's sections: the five Legal groups in their order, then any group a
    /// workflow names that is not one of them (a user's own `group: tax`), in the order
    /// those groups first appear, named from the id. Empty groups are left out.
    static func sidebarSections(for workflows: [WorkflowDefinition]) -> [(group: WorkflowGroupDefinition, items: [WorkflowDefinition])] {
        var sections: [(group: WorkflowGroupDefinition, items: [WorkflowDefinition])] = []
        for group in groups {
            let items = workflows.filter { $0.groupId == group.id }
            if !items.isEmpty { sections.append((group, items)) }
        }
        let knownIds = Set(groups.map(\.id))
        var extraIds: [String] = []
        for workflow in workflows where !knownIds.contains(workflow.groupId) && !extraIds.contains(workflow.groupId) {
            extraIds.append(workflow.groupId)
        }
        for (offset, id) in extraIds.enumerated() {
            let group = WorkflowGroupDefinition(id: id, name: groupName(fromId: id), sortOrder: groups.count + offset)
            sections.append((group, workflows.filter { $0.groupId == id }))
        }
        return sections
    }

    /// "tax-and-estates" -> "Tax And Estates"; an empty id (a workflow with no group) -> "Other".
    static func groupName(fromId id: String) -> String {
        let words = id.split(whereSeparator: { $0 == "-" || $0 == "_" || $0 == " " })
        guard !words.isEmpty else { return "Other" }
        return words.map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
    }

    static func workflow(id: String, projectDirectory: URL) -> WorkflowDefinition? {
        workflows(projectDirectory: projectDirectory).first { $0.id == id }
    }
}

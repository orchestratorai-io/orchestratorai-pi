import SwiftUI

/// What the left column is pointing at: the cross-workflow inbox, or one catalog entry.
enum SidebarSelection: Hashable {
    case inbox
    case workflow(String)

    var workflowId: String? {
        if case .workflow(let id) = self { return id }
        return nil
    }
}

/// Left column: a pinned Inbox row plus the Legal catalog grouped by practice area.
/// The catalog rows carry only a title, icon, and install badge — the detail card
/// already shows the description, so the sidebar stays scannable at 14 entries.
struct SidebarView: View {
    @ObservedObject var runner: PiRunner
    let workflows: [WorkflowDefinition]
    @Binding var selection: SidebarSelection?
    @Binding var expandedGroups: Set<String>

    private var inboxCount: Int {
        runner.attentionRuns.count
    }

    // Every catalog entry is listed. The old "Show coming soon" switch is gone: all 14
    // Legal workflows ship a YAML, so it never changed what the list showed.
    private var visibleWorkflows: [WorkflowDefinition] { workflows }

    var body: some View {
        // The List must be the column root so it receives the toolbar/title inset;
        // wrapping it in a VStack pushed the Inbox row under the window controls.
        List(selection: $selection) {
            Section {
                inboxRow
            }

            // Includes groups a user's own workflow names that are not one of Legal's five.
            ForEach(LegalWorkflowCatalog.sidebarSections(for: visibleWorkflows), id: \.group.id) { section in
                Section(isExpanded: groupBinding(section.group.id)) {
                    ForEach(section.items) { workflow in
                        workflowRow(workflow)
                    }
                } header: {
                    Text(section.group.name)
                }
            }
        }
        .listStyle(.sidebar)
        // Words only: what Pi is, said once where it is always on screen.
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                Divider()
                Text("Pi is free. It runs the OrchestratorAI Legal workflows on this Mac so you can try them.")
                Text("Pi is part of OrchestratorAI Legal. The full suite is available from OrchestratorAI: matt@orchestratorai.io")
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(4)
            .padding(.horizontal, 12)
            .padding(.bottom, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.bar)
            .accessibilityIdentifier("sidebar.about")
        }
        .navigationTitle("Workflows")
        // Wide enough for the longest catalog title plus its badge without
        // truncating; draggable between the min and max, because a person who
        // wants more room for the report can give the detail pane the space back.
        .navigationSplitViewColumnWidth(min: 240, ideal: 290, max: 400)
    }

    private var inboxRow: some View {
        HStack(spacing: 6) {
            Label("Inbox", systemImage: "tray.full")
            Spacer(minLength: 0)
            if inboxCount > 0 {
                Text("\(inboxCount)")
                    .font(.caption2.weight(.semibold))
                    .monospacedDigit()
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .frame(minWidth: 26)
                    .background(Color.orange.opacity(0.22))
                    .foregroundStyle(Color.orange)
                    .clipShape(Capsule())
                    .padding(.trailing, 2)
            }
        }
        .tag(SidebarSelection.inbox)
        .accessibilityIdentifier("sidebar.inbox")
    }

    private func workflowRow(_ workflow: WorkflowDefinition) -> some View {
        HStack(spacing: 6) {
            // Wrap rather than truncate: dragging the column narrow should cost
            // a second line, not the end of the workflow's name.
            Label(workflow.title, systemImage: workflow.icon)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 4)
            Text(workflow.status.label)
                .font(.caption2.weight(.semibold))
                .lineLimit(1)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(workflow.isReady ? Color.green.opacity(0.18) : Color.secondary.opacity(0.14))
                .foregroundStyle(workflow.isReady ? Color.green : Color.secondary)
                .clipShape(Capsule())
                // The badge keeps its full width; the title takes the second line instead.
                .layoutPriority(1)
        }
        .tag(SidebarSelection.workflow(workflow.id))
        .accessibilityIdentifier("sidebar.workflow.\(workflow.id)")
    }

    private func groupBinding(_ groupId: String) -> Binding<Bool> {
        Binding(
            get: { expandedGroups.contains(groupId) },
            set: { expanded in
                if expanded {
                    expandedGroups.insert(groupId)
                } else {
                    expandedGroups.remove(groupId)
                }
            }
        )
    }
}

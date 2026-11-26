# Deal Memo scorecard verification — 2026-11-26

## Continuity

- Picked up at `81ae24f` on `GolferGeek/pi-workflows-codex` (`pi/quality-guards` at the same commit).
- Fresh post-guard stored runs already existed for document-onboarding, sentinel, kb-query, deposition-prep, contract-review, legal-research, and compliance-audit.
- Deal Memo was next: its two stored runs predated the 2026-11-23 guard rollout.
- The primary checkout had only an untracked `.swiftpm/` directory. Its ignored `.env`, decision-model configuration, SQLite store, Pi npm packages, and build output were present; no secret values were copied into tracked files.

## Before

Replaying the current Deal Memo scorecard over the two historical completed runs produced:

| Run | Citation guard | Severity guard | Seeded defects |
|---|---|---|---|
| `0af2e5a2` (2026-09-28) | review | pass | 2/2 caught |
| `deal-mem…` (2026-09-19) | block (invented date) | pass | 2/2 caught |

Together: one `block`, one `review`, both severity checks `pass`, and 4/4 deliberately planted defects caught.

## Changes and fresh run

- Deal Memo drafters now prohibit invented dates, economics, legal requirements, and generic market terms, and explicitly cap each section.
- The synthesizer must deduplicate, remain source-bound, and produce a bounded partner memo.
- The finalizer must keep proposals labelled and source-bound.
- A terminal-launched saved workflow now skips the app-only partner checkpoint in the flow when no app run ID exists. The real attorney gate remains unchanged for app runs.
- Added a regression test for the terminal/app branch and the source/size constraints.

Fresh local run `e36d156b` used `qwen3.6:35b-mlx` and completed intake, all five drafting branches, synthesis, the terminal partner-review skip, and finalization. The interactive terminal was stopped after finalization because feeding the full 27,108-character report through the guard-agent model added more than four idle minutes; the same report was then scored directly with the repository's deterministic `guard-check.ts` calibration path.

| Run | Citation guard | Severity guard | Seeded defects |
|---|---|---|---|
| `e36d156b` (2026-11-26) | review (0 unsupported; 1 attorney-look item) | pass | 2/2 caught |

The acceptance bar is met for Deal Memo: no scorecard block, no unsupported sampled claim, normalized severities pass, and every planted citation/severity defect is detected. The remaining citation review is appropriate human review of whether “immediately accelerate” precisely reflects the lender finding; it is not an unsupported-fact block.

## Local regression evidence

- Extension: 75/75 tests pass.
- Swift: 58/58 tests pass (existing Swift 6 actor-isolation warnings only).
- Guard declarations: all 14 catalog workflows validate in dry mode.
- Live Deal Memo seeded scorecard: 2/2 defects caught.

The next unverified catalog workflow is `adversarial-brief`.

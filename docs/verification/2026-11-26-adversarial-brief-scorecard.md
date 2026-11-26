# Adversarial Brief scorecard verification — 2026-11-26

## Continuity and baseline

- Picked up at Deal Memo commit `299ee9c` on `GolferGeek/pi-workflows-codex`.
- Previously refreshed workflows: document-onboarding, sentinel, kb-query, deposition-prep, contract-review, legal-research, compliance-audit, and deal-memo.
- Two historical Adversarial Brief reports both passed severity calibration but blocked citation grounding; seeded defects were caught 4/4. One report invented an April 2026 protocol invocation, and another turned debate assertions into source facts.

## Process changes

- Debate agents are source-bound and output-capped; local debate branches run sequentially to avoid Ollama contention.
- The analyst carries the complete original brief forward verbatim. The fortifier cannot reread the file or invent source facts, and a terminal run with no attorney decision now preserves the original brief instead of silently applying every recommendation.
- The synthesizer and report writer label debate assessments, preserve source details exactly, cap report size, and emit the scorecard's literal severity-checklist format.
- Terminal runs skip app-only gates while app runs retain the real attorney and guard gates.
- The default continuation threshold is 10, with 5–10 still selectable. I chose 10 after threshold 7 triggered a second round that exceeded 23 minutes and threshold 9 would still continue on an ordinary first-round severity 9; 10 reserves the extra round for a fatal finding.

## Fresh verification

Fresh local run `8e0134c2` completed on `qwen3.6:35b-mlx` in 15m45s. Round one converged, round two skipped, the fortifier made no file-read calls, and the workflow completed normally.

| Run | Citation guard | Severity guard | Seeded defects |
|---|---|---|---|
| `8e0134c2` | review (0 unsupported; 10 attorney-look items) | review (4/5 within one level; one LOW re-graded HIGH) | 2/2 caught |

This meets the workflow bar: no scorecard block, no unsupported sampled claim, and every planted citation/severity defect was detected. The review findings are appropriate attorney review flags, not fabricated source facts; the severity review identifies one debatable prioritization for counsel rather than a missed issue.

## Remaining queue

Cross-exam simulation, discovery review, due diligence, Monte Carlo trial simulator, and persistent case team still need fresh scorecard verification.

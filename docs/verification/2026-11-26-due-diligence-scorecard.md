# Due Diligence scorecard verification — 2026-11-26

## Continuity and baseline

- Picked up at Discovery Review commit `7b68d82` on `GolferGeek/pi-workflows-codex`.
- Historical scorecards were citation block/review because conditional remedies became certainties (including an invented automatic termination); severity passed both and seeded defects were caught 4/4.

## Process changes

- Per-document analysis is capped at 600 words and uses a closed record: exact paths, source numbers/dates/triggers, no unsupported arithmetic, outside law, regulatory history, fine caps, assumed documents, or market practice.
- Synthesis and reporting preserve conditional language, distinguish `Assessment:` and `Recommendation:`, cap output, and use `[VERIFY]` for legal effect. Privacy Shield handling is limited to the two record facts (the DPA relies on it; no SCCs are attached).
- Missing materials must be source-referenced; inferred requests are recommendations and cannot invent titles/dates/meetings.
- The exact checklist syntax and substantive severity calibration are enforced; terminal/app gates and guard scoring branch deterministically while real app gates remain intact.

## Fresh verification

The bounded `qwen3.6:35b-mlx` rerun stayed below 47k context but stalled in report writing for more than two minutes after 6m32s, so verification moved to installed `qwen3.5:9b`. Iterations removed external GDPR dates/fine caps and invented board-record claims.

| Run | Citations | Severity | Seeded defects | Timing/model |
|---|---|---|---|---|
| `f659f5e7` | review (0 unsupported; 3 attorney-look items) | review (9/10 within one level; sub-processor item re-graded LOW→HIGH) | 2/2 caught | 2m46s, `qwen3.5:9b` |

The workflow meets the no-block bar: zero unsupported sampled claims and every planted citation/severity defect is detected. The single two-level severity disagreement is recorded and the process now explicitly prevents that item from being rated LOW.

## Remaining queue

Monte Carlo trial simulator and persistent case team still need fresh scorecard verification.

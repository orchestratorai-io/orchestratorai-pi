# Discovery Review scorecard verification — 2026-11-26

## Continuity and baseline

- Picked up at Cross-Exam Simulation commit `74143ee` on `GolferGeek/pi-workflows-codex`.
- Both historical reports had privilege `review`: potentially privileged or counsel-touched documents appeared in the production set. Severity passed both runs and seeded defects were caught 4/4.

## Process changes

- Coders preserve exact paths, remain source-bound, use the 0.95 privilege rule, and produce bounded coding records.
- The batcher preserves coding rather than reinterpreting privilege.
- The production writer excludes both `privileged` and `potentially-privileged` documents unless the individual privilege gate explicitly clears the exact document. A skipped terminal gate clears nothing and invents no correction.
- Inventory excludes README/index noise, all four app attorney gates have deterministic terminal fallbacks, the app gates remain intact, and terminal guard scoring uses the deterministic scorecard path.
- The report uses the literal severity checklist format and is capped at 2,500 words.

## Fresh verification

Fresh local run `9a023d3a` completed on `qwen3.6:35b-mlx` in 4m02s without runaway context.

| Run | Privilege | Severity | Seeded defects |
|---|---|---|---|
| `9a023d3a` | pass (no withheld/review document produced) | pass | 2/2 caught |

The workflow meets the bar: both live guards pass and every planted privilege/severity defect is detected.

## Remaining queue

Due diligence, Monte Carlo trial simulator, and persistent case team still need fresh scorecard verification.

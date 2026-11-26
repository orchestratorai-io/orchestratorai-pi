# Monte Carlo Trial Simulator scorecard verification — 2026-11-26

## Continuity and baseline

- Picked up at Due Diligence commit `2c0bc61` on `GolferGeek/pi-workflows-codex`.
- Replaying the current scorecard over both historical reports produced citation `review` twice (zero unsupported sampled claims but two distorted or uncertain simulated legal conclusions in each), severity `pass` twice, and 4/4 seeded defects caught.

## Process changes

- Parameter, advocate, jury, statistician, and report prompts are bounded and use `thinking: off`; scenario descriptions cannot invent judge names, vote counts, demographics, instructions, venue facts, rulings, law, or evidence outside the record.
- Jury damages are deterministic at the source boundary: defense means zero; plaintiff or mixed means one exact nonzero dollar figure printed in the record, with its named theory. Midpoints, compromises, percentages, multipliers, and new figures are forbidden.
- Statistics show arithmetic, avoid interpolated percentiles below ten observations, and label sensitivity only as a simulation association. Reports cannot turn scenario frequency into probability or causal effect.
- The compact simulation log is limited to id, verdict, damages, supplied factors, and one reasoning sentence. Asserted, contested, and unresolved admissibility remains unresolved; scenario treatment is explicitly an assumption.
- Terminal guard handling is deterministic and the workflow has regression coverage for the bounded, source-labeled contract.

## Fresh verification

The first bounded run on `qwen3.6:35b-mlx` completed in 8m28s but showed prolonged no-activity periods and exposed a zero-damages plaintiff outcome plus invented narrative detail. The first `qwen3.5:9b` correction completed in about three minutes and scored citation `review` because it invented two damages figures. The exact-source-amount invariant fixed that gap.

| Run | Citations | Severity | Seeded defects | Timing/model |
|---|---|---|---|---|
| `297440e7` | pass (10/10 sampled statements supported) | pass (5/5 exact severity agreement) | 2/2 caught | 3m15s, `qwen3.5:9b` |

The final run meets the bar: both live guards pass, damages stay on an exact record figure, context stays bounded below 36k tokens, and both planted defects are caught.

## Remaining queue

Persistent Case Team is the only workflow still needing fresh scorecard verification.

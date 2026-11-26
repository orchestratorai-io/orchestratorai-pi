# Cross-Exam Simulation scorecard verification — 2026-11-26

## Continuity and baseline

- Picked up at Adversarial Brief commit `3a6a7b8` on `GolferGeek/pi-workflows-codex`.
- Two historical reports were review-only for coaching/citations; severity was one pass and one review because the older report lacked the exact checklist syntax. Seeded defects were caught 6/6.
- Historical coaching sometimes supplied testimony or admissions, and reports converted allegations and strategy into factual findings.

## Process changes

- Strategist and question generator now prohibit invented exhibits, quotations, dates, and prior statements.
- Scoring and debriefing coach truthful process and demeanor without scripting testimony. The debrief analyzes only observed transcript behavior and scores, emits separate coaching bullets, uses the exact severity checklist syntax, and cannot restate an alleged evidence chain as fact.
- Terminal runs use a deterministic, expressly limited witness response and skip app-only guard gates; app runs retain the real per-turn attorney gate.
- The case-facts launch sample is now also the parameter default, making the saved terminal slash command usable; it previously required a second named parameter that slash commands cannot supply.

## Fresh verification

The first default-model run on `qwen3.6:35b-mlx` grew to roughly 94k context in turn four and was stopped after more than 11 minutes without completing. With no coordinator response, I chose installed `qwen3.5:9b` as the general-purpose faster local model (rather than guard-specialized Clef or smaller Gemma/Nemotron variants); it completed full five-turn runs in 2m58s–4m40s, and the product default was not changed.

Scorecard iteration moved from a citation block and 2/3 seeded catches, through a second citation block caused by an overstated evidence-chain synthesis, to the final stored run:

| Run | Coaching | Citations | Severity | Seeded defects |
|---|---|---|---|---|
| `f8c02e1c` | review (0 scripted; 2 attorney-look items) | review (0 unsupported; 4 attorney-look items) | pass | 3/3 caught |

The final run meets the bar: no guard block, no unsupported sampled claim, no scripted coaching, normalized severity passes, and every planted coaching/citation/severity defect is detected.

## Remaining queue

Discovery review, due diligence, Monte Carlo trial simulator, and persistent case team still need fresh scorecard verification.

# Qwen 3.6 local workflow verification

The Mac Studio worktree started at merged `origin/master` `f70613df0f36a3f33ebef0fc9c876adac32feb94`. Saved workflows ran through local Pi 0.85.1 and Ollama/MLX 0.40.17. The selected agent model was `qwen3.6:35b-mlx`. Clef scored each saved report through the repository's `npm run guards -- --seeded --verbose` path. Terminal tests used the fixture presets and terminal gate branches. Qwen workflows ran one at a time. Clef grading overlapped some later reruns on the shared GPU.

Wall time is the journal's started-to-completed duration, excluding scoring. Peak context is the highest input plus cache-read and cache-write tokens for one request in the native Pi session. Older scorecards also report cumulative usage, so those figures use a different denominator. The individual scorecards identify intermediate runs where useful.

## Local checks

- npm test passed 89 of 89, including the three diligence evidence regressions.
- Swift passed 60 of 60.
- All 14 catalog guard declarations passed dry validation.

## Results

Each comparison runs from the archived Qwen 3.5 9B baseline to the selected Qwen 3.6 35B MLX run.

| Workflow | Runs | Wall time | Peak input tokens | Citations | Severity | Seeded defects |
|---|---|---:|---:|---|---|---:|
| [Cross-Exam Simulation](2026-11-27-cross-exam-simulation-scorecard.md) | `f8c02e1c` → `235bf9a2` | 3m18s → 2m39s | 11,256 → 6,415 | Review → Review | Pass → Pass | 3/3 → 3/3 |
| [Due Diligence](2026-11-27-due-diligence-scorecard.md) | `f659f5e7` → `4889cd81` | 2m46s → 2m57s | 5,740 → 7,594 | Review → Review | Review → Pass | 2/2 → 2/2 |
| [Monte Carlo Trial Simulator](2026-11-27-monte-carlo-trial-simulator-scorecard.md) | `297440e7` → `11d2550c` | 3m15s → 10m15s | 4,275 → 15,240 | Pass → Review | Pass → Pass | 2/2 → 2/2 |
| [Persistent Case Team](2026-11-27-persistent-case-team-scorecard.md) | `6365428b` → `1616b925` | 5m00s → 6m03s | 18,009 → 26,165 | Pass → Review | Pass → Pass | 2/2 → 2/2 |

Cross-Exam coaching graded review on both models, with zero scripted notes in the selected run. All four Qwen 3.6 runs finished, their largest completed request used 26,165 input tokens, and all nine seeded defects were caught. The fresh Due Diligence run replaced the blocked run `4850e8f4`. All four selected reports now grade citation review. The review items still need counsel attention. The case-team exact-edit experiment was stopped at a 47,784-token request, and the verified run used one repair write.

The remaining latency is concentrated in trial advocates and the case-team validator. Extend mechanical checks beyond the supported SLA clauses and preserve the statistician's supplied numbers in trial reporting. Exercise actual app-side attorney interactions separately before treating these fixture results as app acceptance.


## Due Diligence citation follow-up

Run `4889cd81` completed in 177.1 seconds with a 7,594-token peak input request. Citations graded **review** with zero unsupported claims and four review items across ten samples. Severity **passed** with six exact matches and four within one level, and the scorecard caught both seeded defects.

The analyst, synthesis, and report submissions now reserve the SLA and 409A findings for source-backed rendering. Pi found only two of three monthly availability observations strictly below the 99.5% termination threshold. The 99.62% observation prevents this three-month window from establishing the trigger. The report cites the capitalisation summary for the March 2026 option grant, the November 2024 valuation used to set the strike price, and the source's explicit statement that the data room has no refreshed 409A. The remaining citation review items concern consent, acceleration, and related language in the generative analysis.

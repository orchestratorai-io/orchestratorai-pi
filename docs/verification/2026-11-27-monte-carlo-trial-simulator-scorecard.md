# Monte Carlo Trial Simulator on Qwen 3.6

## Diagnosis and changes

- The earlier Qwen 3.6 run `2d37fbd1` completed in 507.5 seconds and peaked at 4,012 input tokens per provider request. The statistician took two requests and generated 16,352 output tokens, including 59,252 characters of reasoning despite its off setting. Both advocates were also dispatched together within each simulation, even though the outer simulation map was serial.
- The Ollama adapter honors thinking off. Plaintiff and defense run one at a time, each still considering the original record and addressing the material disputed elements. The advocates use low thinking and a compact argument schema after no-thinking rehearsals showed skipped result-tool calls. The shared parameter designer hands juries the exact damages amounts, theories, and quoted source text, alongside the scenario and competing arguments. The compact verdict schema bounds its factors and reasoning, and the statistics prompt requests formulas and scenario IDs without replaying their narratives.
- The parameter designer and both advocates declare the case-record path and receive the complete source inline when it fits the 8 KiB text limit. Other files require a successful read before submission. The simulation report retains the source-only limitations, describes contested admissibility as unresolved, and keeps the exact record-amount rule for damages.

## Advocate tuning

The first two no-thinking rehearsals, `4ee4dcb9` and `7092763d`, stopped when counsel wrote chat text without calling the result tool. The structured low-thinking run `11d2550c` completed all three cases in 615.3 seconds, with record-sourced damages of $3.4M and $1.6M and zero for the defense verdict. Schema retries on long argument strings created a 15,240-token peak input and long generation. One plaintiff node generated 13,036 output tokens across three requests. The additional structured no-thinking rerun `d1921321` also ended at the first advocate without a submitted result. The verified workflow therefore uses low thinking for the two advocates and off for the other simulation profiles. Counsel length checks remain a retry and latency bottleneck.


| Model and run | Wall time | Peak input | Citations | Severity | Seeded caught |
|---|---:|---:|---|---|---:|
| Qwen 3.5 9B `297440e7` | 3m15s | 4,275 | Pass, 10/10 supported | Pass, 5/5 exact | 2/2 |
| Qwen 3.6 35B MLX `11d2550c` | 10m15s | 15,240 | Review, 0 unsupported, 2 flagged across 10 claims | Pass, 5 within one level | 2/2 |

The baseline scorecard covers the delivered report. Its journal ended in the app guard wrapper. The Qwen 3.6 report's review items cover the treatment and purported effect of contested E-6 across scenarios. The three jury awards used exact supplied figures and a zero defense award. Two advocates spent more than two minutes each while continuing to generate, particularly after result-schema corrections.

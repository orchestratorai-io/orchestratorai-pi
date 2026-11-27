# Due Diligence on Qwen 3.6

## Diagnosis and changes

- The earlier Qwen 3.6 run `ab3cf931` passed 37,800 task bytes to synthesis. Its 9,330-token input generated 10,253 output tokens in about 104 seconds. The report then received a 10,550-byte task and a 2,782-token input. Ollama finished uncached prefill in about 1.2 seconds and spent the remaining roughly 146 seconds decoding before cancellation. Pi preserved about 60,416 characters of reasoning with no accepted report, despite the profile's `thinking: off`.
- The Ollama request adapter makes the configured off setting explicit. The analysis map dispatches one document at a time on the shared local runner. Analysts group exact source facts with their triggers and effects once, and synthesis and report prompts reference concise risk IDs between sections. Synthesis and reporting use the supplied findings and matrix without reopening the room.
- During the first reruns Qwen sometimes submitted a plausible-looking analysis without reading the file at all. Each analysis task now declares its exact required source. Pi injects a complete UTF-8 Markdown or text file up to 8 KiB as untrusted evidence. Other files use Pi's normal read tool, with a result hook that rejects findings until the declared path was read. An unreadable file can still report an error. Both attorney gates remain in the app workflow.

The intermediate Qwen run `0a0cc92a` completed in 193.3 seconds with a 5,964-token peak. Its scorecard caught 2/2 seeds and routed citations and severity to review. The two citation review items covered a mistaken lender attribution and SLA trigger wording. A security deficiency also graded LOW instead of HIGH. The final workflow carries exact instrument titles and party roles through synthesis and reporting, separates observed values from thresholds, and sets a MEDIUM floor for material security issues.

## Live evidence

Run `4850e8f4` completed the five-document fixture in 295.2 seconds. The source packets supplied each exact fixture to its analyst. The synthesis task was 18,756 bytes and reached 7,037 peak input tokens. The final report took 48.3 seconds from a 17,033-byte task and a 4,207-token request, with 4,943 output tokens and no separate reasoning. Clef was grading a separate saved report during the first part of this run, sharing the same GPU.

The roster restored Meridian Credit Partners as the lender in synthesis. Manual review still found a claim that 99.62% was below 99.5%, which can wrongly turn a three-period contractual trigger into an exercised remedy. Qwen's interpretation of exact numeric and conditional facts still needs review.

| Model and run | Wall time | Peak input | Citations | Severity | Seeded caught |
|---|---:|---:|---|---|---:|
| Qwen 3.5 9B `f659f5e7` | 2m46s | 5,740 | Review, 0 unsupported, 3 flagged | Review, 9/10 within one level | 2/2 |
| Qwen 3.6 35B MLX `4850e8f4` | 4m55s | 7,037 | Block, 2 unsupported and 2 flagged across 10 claims | Pass, 10 within one level | 2/2 |

The citation block covers the false three-month SLA claim and an updated 409A report presented without source support. This run verifies the bounded execution path. The report needs correction before use.

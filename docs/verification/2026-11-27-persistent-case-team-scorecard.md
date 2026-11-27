# Persistent Case Team on Qwen 3.6

## Diagnosis and changes

- In the earlier Qwen 3.6 run `59b30fc1`, all three extraction branches started together and independently loaded the same batch. The entity conversation reached 12,097 input tokens. Their 27,563 bytes of output made the writer's initial task 28,562 bytes and 8,265 input tokens. The writer recorded a write followed by a response without an accepted result. Its two recorded responses generated 10,407 output tokens, with 12,901 characters of reasoning despite the off setting.
- The extraction branches run one at a time. Each passes compact, cited rows for its own record section. The document extract also carries forward unresolved cited questions. The writer checks the schema and source values before one write and confirms the result, leaving the independent validator to read the persisted record and batch. The validator prepares any repairs together and reads the repaired file back once. It checks that measured values, legal triggers, and remedies remain distinct. The report applies any source corrections identified in validation. The report's guard record remains the incoming batch.
- In rehearsal the fresh target did not exist and the entity extractor searched the parent directory, importing a different generated record as legacy. Each extractor now uses only the explicitly supplied prior path and the batch sources. A missing prior path starts a new record.

The rehearsal `c735b118` completed in 320.9 seconds and used 22,538 input tokens at the validator peak. The entity agent read a sibling after getting ENOENT for the new target. Manual review found a reversed customer/provider role and an assertion that all three monthly values were below 99.5% even though one was 99.62%. This run motivated restricting legacy reads and prioritizing conditions and roles in the validator. It is tracked as a diagnostic run.


Run `659ac276` preserved the requested record boundary, but the validator repeatedly tried to reproduce exact old text for the edit tool and failed on whitespace and content mismatches. After 22 completed validator responses, Pi recorded 44,831 peak input tokens. Ollama started one more request with 47,784 input tokens after a 3,307-byte initial validator task. I stopped the run after 9m09s to prevent further growth while it was still streaming. The validator now uses a single bounded rewrite when repairs are necessary, followed by one read-back and an explicit checklist for any unresolved issues.

## Live evidence

Run `1616b925` completed in 363.5 seconds. Its writer started with 13,497 task bytes and peaked at 7,529 input tokens. The validator used one write after reading the record and batch, then read back the file and submitted a checklist. Its validator started with a 3,387-byte task and peaked at 26,165 input tokens across four requests. The 16,916-output-token repair request spent most of its time generating explanatory prose and the rewrite. It had no separate thinking channel under the off setting.

The retained record contained 1,498 words, the five required sections, five index entries, Markdown table separators and a correct Northwind customer role. A manual comparison found the MSA timeline row reduced the source's March 3, 2024 date to March 2024. Exact date precision still needs counsel review despite the completed source check.

| Model and run | Wall time | Peak input | Citations | Severity | Seeded caught |
|---|---:|---:|---|---|---:|
| Qwen 3.5 9B `6365428b` | 5m00s | 18,009 | Pass, 10/10 supported | Pass, 5 within one level | 2/2 |
| Qwen 3.6 35B MLX `1616b925` | 6m03s | 26,165 | Review, 0 unsupported, 5 flagged across 10 claims | Pass, 7/7 exact | 2/2 |

The citation flags include SLA-condition wording and timeline or contract attribution, including conflation of dates with the DPA in the report. The validator's long repair and the report's handling of citations are the remaining bottlenecks. Keep the report in attorney review.

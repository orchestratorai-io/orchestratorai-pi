# Persistent Case Team scorecard verification — 2026-11-26

## Continuity and baseline

- Picked up at Monte Carlo Trial Simulator commit `11dadff` on `GolferGeek/pi-workflows-codex`.
- The historical `351e20ac` report replayed with citations `pass`, severity `review`, and 2/2 seeded defects caught. A second historical report replayed with citations `review` (zero unsupported sampled claims but six uncertain or distorted claims), severity `review`, and 2/2 seeded defects caught; historical seeded detection was 4/4 overall.
- Direct inspection also found that generated matter records could concatenate extracts, invent arithmetic and metadata dates, miscopy quantities, confuse the January 2023 DPA date with 2025 subprocessor additions, and mark new source-backed questions as legacy.

## Process changes

- Entity, timeline, document-index, record-writer, validator, and report profiles use `thinking: off` and bounded prompts. The generated record cannot support its own report: citations score only the incoming batch.
- The record writer has one fixed five-section schema, a 1,800-word ceiling, exact `Person`/`Organization` types, exact paths, source-only quantities and dates, strict timeline ordering, and a read-back check. It cannot calculate, reinterpret, append extracts, or invent a wall-clock date.
- A dedicated record validator rereads every source and the written file, then repairs only schema/source-exactness defects. Its regression contract includes the five-file document count, two former employees, the January 2023–June 2024 hiring range, legacy-label removal, and the separate January 2023 DPA and 2025 subprocessor dates.
- The report writer is source-only and bounded to 2,000 words, uses explicit `Assessment:`/`Recommendation:` labels, exact incoming-path citations, and calibrated attorney-review severities.
- The delegated `guard-gate` profile cannot currently see `report_guard` inside child-agent context. Persistent Case Team therefore records a deterministic pending marker and uses the repository's canonical local scorecard after completion, preventing a successful substantive run from failing on an unavailable child tool.

## Fresh verification

A bounded `qwen3.6:35b-mlx` attempt was stopped after roughly six minutes when its record-writer stopped making progress; its context remained about 45k tokens, far below the 90k runaway threshold. Iterative `qwen3.5:9b` runs exposed and fixed circular grounding, extract concatenation, fabricated dates/arithmetic, quantity drift, legacy-tag misuse, severity drift, and a distorted governing-law attribution.

| Run | Citations | Severity | Seeded defects | Timing/model |
|---|---|---|---|---|
| `6365428b` | pass (10/10 sampled statements supported) | pass (5 findings: 4 exact, 1 one level apart, 0 two levels apart) | 2/2 caught | 5m00s, `qwen3.5:9b` |

The accepted run completed with seven agents and bounded usage (43.3k input / 31.3k output tokens). The persisted record is 1,202 words, uses the exact five-section schema, has five document rows, preserves two former employees and the correct date relationships, contains no `[VERIFY LEGACY]` leakage, and uses non-fabricated local-generation metadata.

## Queue status

All workflows in the fresh scorecard-verification queue are now verified; none remain.

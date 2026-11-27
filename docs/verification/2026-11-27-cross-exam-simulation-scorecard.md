# Cross-Exam Simulation on Qwen 3.6

## Diagnosis and changes

- The previous Qwen 3.6 run `d8ea8670` sent a 27,756-byte strategy into each question. The third scorer started with a 2,737-byte task and 1,252 input tokens. Four result-tool attempts and continued reasoning grew its request to 37,817 input tokens in the Ollama log. Pi recorded 34,419 output tokens for the scorer before the run stopped. The older roughly 94k figure uses an unspecified context counter.
- Pi set the scorer's thinking level to `off`, but its Ollama requests omitted `reasoning_effort`. Ollama 0.40.17 enabled Qwen thinking by default. A loopback probe using the same fixture prompt returned reasoning when the field was omitted and no reasoning with `reasoning_effort: "none"`. The extension now sends that value for Qwen 3.5/3.6 on Ollama's OpenAI-completions API when Pi's setting is off.
- The strategist hands off three length-checked fields and is prompted to make one bounded record lookup. The scorer returns only three scores, a truthful-process note selected from the schema, and a stop flag. Pi appends the original question, answer, and scores to a five-turn transcript without asking a model to copy prior turns. The debrief receives the transcript alone. It selects three turn-specific recommendations from the same truthful-process practices, and Pi renders the debrief and preserves the original transcript. The debrief explicitly uses low thinking for the coaching judgment.

## Live evidence

The saved workflow completed all five turns on `qwen3.6:35b-mlx` in run `235bf9a2`. The strategist's accepted handoff was 1,350 bytes. Question and scorer requests peaked at 1,433 and 1,356 input tokens respectively. The debrief took 124.1 seconds with a 3,893-byte task, 1,531 input tokens and 13,049 output tokens. Its request was small and the remaining delay was reasoning and generation.

The three rendered coaching recommendations are question comprehension, distinguishing memory from verification, and acknowledging limits without speculation. The free-text analysis still inferred lack of preparation from fixed terminal responses and assigned one HIGH checklist item despite zero damage scores. Counsel should review those judgments.

| Model and run | Wall time | Peak input | Coaching | Citations | Severity | Seeded caught |
|---|---:|---:|---|---|---|---:|
| Qwen 3.5 9B `f8c02e1c` | 3m18s | 11,256 | Review, 0 scripted, 2 flagged | Review, 0 unsupported, 4 flagged | Pass | 3/3 |
| Qwen 3.6 35B MLX `235bf9a2` | 2m39s | 6,415 | Review, 0 scripted, 3 flagged | Review, 0 unsupported, 1 flagged across 9 claims | Pass, 3 within one level | 3/3 |

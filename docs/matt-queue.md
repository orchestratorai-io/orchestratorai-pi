# Matt's queue

Everything waiting on Matt in this project, **most important first**. Deadlines come first, then items blocking other work, then the rest.

- **Matt:** say "give me your top issue" (or "the next one") and you get the first item that is not yet Answered. Answer it in a line.
- **Status** (every item has one):
  - **Waiting**: in the queue, not yet asked.
  - **Asked (date)**: put to Matt.
  - **Answered (date)**: Matt replied; his answer is written in the item, word for word.
  - **Processed**: acted on. Move the item to `docs/matt-queue-archive.md` (newest first) and renumber the queue.
- **Agents:** when you need Matt to decide or do something, add it here with **Status: Waiting**, in priority order, in the format below. Never leave an ask only in chat: Matt reads in bursts, runs several agents at once, and doesn't carry context between messages. After his answer:
  1. set Answered with his words;
  2. act on it and record the decision where this project keeps decisions;
  3. set Processed and move the item to the archive.
- **Format** (each item must read cold, with no shorthand from earlier conversations, and no PR numbers or internal names as the explanation):
  - title (with a deadline if any);
  - **Status**;
  - **What** (plain words);
  - **Why it matters**;
  - **Options**, if more than one;
  - **Recommendation**;
  - **Reply** (the exact words to say);
  - **Answer** (added when Answered).
- **grokbot** reads this file (and the same file in Matt's other projects) to answer "what are my top issues?". It lists items that are Waiting or Asked.

## 1. Install qwen3-coder-next for Deposition Prep's answer step, or change that step's default (no deadline)

**Status:** Waiting

**What:** Deposition Prep, in "Predicted cross-exam" mode, writes witness answer preparation and then checks it with the witness-coaching guard. That one step now has its own model setting, "Answer-prep model", which starts at `ollama/qwen3-coder-next:q4_K_M`: the only model that passed the guard when local models were compared (qwen3.6 wrote scripted testimony every time). But `ollama list` on the Mac Studio on 2026-11-23 shows that model is no longer installed. So a Predicted cross-exam run with the defaults stops at that step with a model error. The other mode, "Preparation outline", is not affected.

**Why it matters:** A demo of Predicted cross-exam fails partway unless someone changes the setting first.

**Options:**
1. Pull the model again on the Studio: `ollama pull qwen3-coder-next:q4_K_M` (a large download, roughly 50 GB). Nothing in Pi changes.
2. Change the step's default to "Local model box" (today `qwen3.6:35b-mlx`). One-line change, but qwen3.6 failed the guard on every probe, so the guard would usually withhold the answer preparation.
3. Leave it, and pick "Local model box" in the launch card before a Predicted cross-exam run.

**Recommendation:** 1, if the disk space is there: it is the only model shown to produce answer preparation that passes the guard.

**Reply:** "Pull qwen3-coder-next" or "Default it to the Local model box" or "Leave it".

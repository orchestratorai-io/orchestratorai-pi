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

## 1. Before the next Pi demo: the local model Pi uses by default is gone from the Studio

**Status:** Waiting

**What:** Pi starts every workflow on the local model `qwen3.6:latest` unless someone types another name in the "Ollama model" box. That model is no longer installed in Ollama on the Mac Studio (`ollama list` on 2026-11-23 shows `qwen3.6:35b-mlx`, but not `qwen3.6:latest`). So a run started with the defaults fails straight away, before it does any work.

**Why it matters:** The plan is to show one short run live, such as Document Onboarding. With the defaults that run fails in front of the audience, and the failed run then sits in the list a buyer sees. The runs already in the list are unaffected; they open and read fine.

**Options:**
1. Pull the model again: `ollama pull qwen3.6:latest` on the Studio. Nothing in Pi changes; costs a download of roughly 20 GB.
2. Change Pi's default to the `qwen3.6:35b-mlx` that is already installed. A one-line code change and a rebuild, but no workflow has been run on that exact model yet, so each one needs a fresh test run.
3. Leave it, and type `qwen3.6:35b-mlx` into the model box by hand before each live run.

**Recommendation:** Option 1. It puts back exactly the model every saved run and sample output was made with, so the demo matches what has already been checked.

**Reply:** "Pull the model again" / "switch the default to the mlx one" / "I'll type it in".

**Answer:**

## 2. Install Xcode on the Mac Studio, or Pi cannot be rebuilt

**Status:** Waiting

**What:** The Mac Studio has only Apple's Command Line Tools, not Xcode. `./scripts/build-app.sh` now fails: one of the packages Pi depends on for rendering text uses a SwiftUI feature whose compiler plug-in ships inside Xcode and is absent from the Command Line Tools. Installing Xcode from the App Store and running `sudo xcode-select -s /Applications/Xcode.app` fixes it. It is roughly a 10 GB download and needs an admin password, which is why this is a question rather than something already done.

**Update 2026-11-23:** Xcode is now installed (`xcode-select -p` gives `/Applications/Xcode.app/Contents/Developer`) and `./scripts/build-app.sh` builds Pi again. This item looks done; it can be closed.

**Why it matters:** The `dist/Pi.app` that the demos and the click-through verification use was built on 2026-10-04 and still launches, so nothing is broken today. But no change to Pi's Swift code can be shipped until the Studio can compile again — the new smoke test (`./scripts/smoke-test.sh`) can only check the old bundle, with `--skip-build`.

**Options:**
1. Install Xcode on the Studio. Unblocks building; costs a large download and disk space.
2. Drop the `textual` dependency and render workflow output without it. No Xcode needed, but it changes how every result reads, and that is a product decision, not a build fix.
3. Leave it. Pi is demo-only and nobody edits its Swift; revisit when someone needs to.

**Recommendation:** Option 1. The Studio is the coding machine for every Apple-side project here, so it will need Xcode again regardless, and option 2 trades a one-time download for a permanent change to the output.

**Reply:** "Install Xcode on the Studio" / "drop textual instead" / "leave it for now".

**Answer:**


# Matt queue archive

## Before the next Pi demo: the local model Pi uses by default is gone from the Studio

**Status:** Answered (2026-11-23) → Processed (2026-11-23)

**What:** Pi starts every workflow on the local model `qwen3.6:latest` unless someone types another name in the "Ollama model" box. That model is no longer installed in Ollama on the Mac Studio (`ollama list` on 2026-11-23 shows `qwen3.6:35b-mlx`, but not `qwen3.6:latest`). So a run started with the defaults fails straight away, before it does any work.

**Why it matters:** The plan is to show one short run live, such as Document Onboarding. With the defaults that run fails in front of the audience, and the failed run then sits in the list a buyer sees. The runs already in the list are unaffected; they open and read fine.

**Options:**
1. Pull the model again: `ollama pull qwen3.6:latest` on the Studio. Nothing in Pi changes; costs a download of roughly 20 GB.
2. Change Pi's default to the `qwen3.6:35b-mlx` that is already installed. A one-line code change and a rebuild, but no workflow has been run on that exact model yet, so each one needs a fresh test run.
3. Leave it, and type `qwen3.6:35b-mlx` into the model box by hand before each live run.

**Recommendation:** Option 1. It puts back exactly the model every saved run and sample output was made with, so the demo matches what has already been checked.

**Reply:** "Pull the model again" / "switch the default to the mlx one" / "I'll type it in".

**Answer:** Option 2, "switch the default to the mlx one" (Matt's choice on the morning of 2026-11-23, relayed by the CEO; his exact wording was not passed on).

**Processed note:** Pi's default model is now `qwen3.6:35b-mlx` (`ContentView.defaultModel` in `Sources/Pi/PiApp.swift`, the README, `docs/local-models.md`, and a test pinning the default). `dist/Pi.app` was rebuilt with it. Runs already saved keep the model they were made with. No workflow has had a fresh run on the new model yet; that stays with the local-model work. `.pi/workflows/prep-probe-qwen36.yaml` still names `qwen3.6:latest` on purpose (it is a probe of that exact model) and will fail until that model is pulled again. (Later on 2026-11-23 the probe was repointed to `qwen3.6:35b-mlx`, since the app catalog, the clickthrough screenshots script and the docs still use it.)

## Install Xcode on the Mac Studio, or Pi cannot be rebuilt

**Status:** Processed (2026-11-23)

**What:** The Mac Studio has only Apple's Command Line Tools, not Xcode. `./scripts/build-app.sh` now fails: one of the packages Pi depends on for rendering text uses a SwiftUI feature whose compiler plug-in ships inside Xcode and is absent from the Command Line Tools. Installing Xcode from the App Store and running `sudo xcode-select -s /Applications/Xcode.app` fixes it. It is roughly a 10 GB download and needs an admin password, which is why this is a question rather than something already done.

**Update 2026-11-23:** Xcode is now installed (`xcode-select -p` gives `/Applications/Xcode.app/Contents/Developer`) and `./scripts/build-app.sh` builds Pi again. This item looks done; it can be closed.

**Why it matters:** The `dist/Pi.app` that the demos and the click-through verification use was built on 2026-10-04 and still launches, so nothing is broken today. But no change to Pi's Swift code can be shipped until the Studio can compile again — the new smoke test (`./scripts/smoke-test.sh`) can only check the old bundle, with `--skip-build`.

**Options:**
1. Install Xcode on the Studio. Unblocks building; costs a large download and disk space.
2. Drop the `textual` dependency and render workflow output without it. No Xcode needed, but it changes how every result reads, and that is a product decision, not a build fix.
3. Leave it. Pi is demo-only and nobody edits its Swift; revisit when someone needs to.

**Recommendation:** Option 1. The Studio is the coding machine for every Apple-side project here, so it will need Xcode again regardless, and option 2 trades a one-time download for a permanent change to the output.

**Reply:** "Install Xcode on the Studio" / "drop textual instead" / "leave it for now".

**Answer:** none needed; Xcode was installed on the Studio.

**Processed note:** Closed 2026-11-23 after `./scripts/build-app.sh` built `dist/Pi.app` cleanly with Xcode selected.

## 1. A Developer ID certificate, so Pi can be a downloadable app

- **Status:** Answered (2026-10-05) → Processed (2026-10-05)
- **Answer:** already enrolled
- **What:** Pi can only be given to someone today as a git repository they build
  themselves. To hand them an app they can download and open, the app has to be
  signed with an Apple **Developer ID** certificate and notarized by Apple. This
  Mac only has an *Apple Development* certificate, which cannot be used for
  that. It needs an Apple Developer Program membership ($99/year) and a
  Developer ID Application certificate created under it. Only you can do this —
  it is an account and identity action, not code.
- **Why it matters:** without it, macOS refuses to open the app on any machine
  it was not built on, so there is no download, no `.dmg` and no Homebrew
  install — and we cannot even test whether those work. Everything else in the
  packaging plan is ordinary work we can do; this is the one thing in the way.
  The technical question that could have killed the whole idea has already been
  answered: a signed, hardened Pi still launches `pi` and its child processes
  with no special permissions (`docs/verification/2026-09-30-hardened-runtime-spike.md`).
- **Options:** (a) enroll now and create the certificate, so packaging can be
  built and tested; (b) wait, and keep handing people the repository.
- **Recommendation:** (a), whenever you want anyone outside the building to open
  Pi without a checkout. There is no rush if the only audience is demos you
  drive yourself.
- **Reply:** "Yes, enrolling / already enrolled — I'll make the Developer ID
  cert", or "Not yet, keep shipping the repo."

- **Status:** Processed (2026-10-05)
- **Processed note:** Developer ID Application cert present on Studio: `Developer ID Application: Matthew Weber (227GEZ2676)` (8D05A72D…). Matt confirmed done 2026-10-05. Not App Store.


---

's queue: archive

Processed items moved out of `docs/matt-queue.md`, newest first. Each keeps its question, Matt's answer and the date.

_Nothing archived yet._

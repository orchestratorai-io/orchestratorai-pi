#!/usr/bin/env bash
# Smoke test: does Pi build, bundle, launch and come up on this Mac?
#
# Checks, in order:
#   1. the host can run what we are about to build (macOS version, arch)
#   2. Package.swift, Info.plist and the built binary agree on the minimum macOS
#   3. ./scripts/build-app.sh produces a well-formed dist/Pi.app
#   4. the bundle launches, registers with LaunchServices and puts a window up
#   5. it is still alive after settling, with no crash report
#   6. it quits cleanly when asked
#
# Needs no privacy grants, so it also works from an unattended handoff. The
# deeper clickthrough harness (scripts/clickthrough/) drives the UI and does
# need Accessibility; this is the check that runs anywhere.
#
# Usage: ./scripts/smoke-test.sh [--skip-build] [--keep-running]
set -euo pipefail

project_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project_dir"

app_dir="$project_dir/dist/Pi.app"
binary="$app_dir/Contents/MacOS/Pi"
plist="$app_dir/Contents/Info.plist"
launch_timeout=30     # seconds to wait for the process
window_timeout=30     # seconds to wait for a window
settle=5              # seconds it must stay up after the window appears

skip_build=0
keep_running=0
for arg in "$@"; do
  case "$arg" in
    --skip-build) skip_build=1 ;;
    --keep-running) keep_running=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

checks=0
fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { checks=$((checks + 1)); echo "  ok   $*"; }
step() { echo; echo "== $* =="; }

# ---------------------------------------------------------------- 1. the host
step "Host"
os_version="$(sw_vers -productVersion)"
arch="$(uname -m)"
echo "  macOS $os_version on $arch ($(scutil --get LocalHostName 2>/dev/null || hostname))"

# --------------------------------------------- 2. one minimum macOS, not three
step "Deployment target"
# Package.swift: .macOS(.v15) -> 15
pkg_major="$(sed -n 's/.*\.macOS(\.v\([0-9][0-9]*\)).*/\1/p' Package.swift | head -1)"
[ -n "$pkg_major" ] || fail "could not read the macOS platform from Package.swift"
plist_min="$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' Resources/Info.plist)"
plist_major="${plist_min%%.*}"
echo "  Package.swift .macOS(.v$pkg_major), Resources/Info.plist LSMinimumSystemVersion $plist_min"

[ "$pkg_major" = "$plist_major" ] || fail \
  "Package.swift builds for macOS $pkg_major but Resources/Info.plist advertises $plist_min — a Mac between the two would launch the app and fail to load it"
pass "Package.swift and Info.plist agree on macOS $pkg_major"

[ "${os_version%%.*}" -ge "$pkg_major" ] || fail \
  "this Mac runs macOS $os_version, below the macOS $pkg_major this builds for"
pass "macOS $os_version satisfies the macOS $pkg_major minimum"

# ------------------------------------------------------------------ 3. build
step "Build"
# Preflight the toolchain. `textual` pulls in `swiftui-math`, which uses
# SwiftUI's `@Entry` macro, and the macro implementation lives in
# libSwiftUIMacros.dylib — an Xcode component that the Command Line Tools do
# not ship. Without it swift build dies ~200 lines deep in swift-frontend, so
# we say it here instead.
plugin_dir="$(dirname "$(xcrun -f swiftc)")/../lib/swift/host/plugins"
if [ "$skip_build" = 0 ] && [ ! -e "$plugin_dir/libSwiftUIMacros.dylib" ]; then
  echo "FAIL: this Mac cannot build Pi from source." >&2
  echo "  The active developer directory is $(xcode-select -p)," >&2
  echo "  and $plugin_dir has no libSwiftUIMacros.dylib." >&2
  echo "  SwiftUI's @Entry macro — used by the swiftui-math package that textual" >&2
  echo "  depends on — needs it, and it ships with Xcode, not the Command Line Tools." >&2
  echo "  Fix: install Xcode, then sudo xcode-select -s /Applications/Xcode.app." >&2
  echo "  To check only the already-built dist/Pi.app meanwhile: ./scripts/smoke-test.sh --skip-build" >&2
  exit 1
fi

if [ "$skip_build" = 1 ]; then
  echo "  --skip-build: using the existing $app_dir"
  [ -d "$app_dir" ] || fail "no $app_dir to reuse; drop --skip-build"
else
  ./scripts/build-app.sh > /tmp/pi-smoke-build.log 2>&1 || {
    tail -30 /tmp/pi-smoke-build.log >&2
    fail "./scripts/build-app.sh failed (full log: /tmp/pi-smoke-build.log)"
  }
  pass "./scripts/build-app.sh succeeded"
fi

step "Bundle"
[ -x "$binary" ] || fail "$binary is missing or not executable"
pass "executable at Contents/MacOS/Pi"
plutil -lint "$plist" > /dev/null || fail "$plist is not a valid plist"
bundle_exec="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$plist")"
[ "$bundle_exec" = "Pi" ] || fail "CFBundleExecutable is '$bundle_exec', not 'Pi'"
bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist")"
[ -n "$bundle_id" ] || fail "the bundle has no CFBundleIdentifier"
pass "Info.plist is valid ($bundle_id)"

# The bundle carries a copy of Resources/Info.plist; a stale copy is how the
# shipped minimum drifts away from the one we just checked.
bundle_min="$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$plist")"
[ "$bundle_min" = "$plist_min" ] || fail \
  "the bundle advertises macOS $bundle_min but Resources/Info.plist says $plist_min — rebuild (drop --skip-build)"
pass "the bundle advertises macOS $bundle_min, matching the source"

# The linker records its own minimum; a stale build would disagree with the manifest.
binary_min="$(vtool -show-build "$binary" 2>/dev/null | sed -n 's/.*minos \([0-9][0-9.]*\).*/\1/p' | head -1 || true)"
[ -n "$binary_min" ] || fail "could not read LC_BUILD_VERSION from $binary"
[ "${binary_min%%.*}" = "$pkg_major" ] || fail \
  "the built binary requires macOS $binary_min but Package.swift declares macOS $pkg_major"
pass "the binary's own minimum is macOS $binary_min"

# ----------------------------------------------------------------- 4. launch
step "Launch"
# A left-over instance would make every check below pass without proving
# anything about the build we just made.
if pgrep -x Pi > /dev/null; then
  echo "  an earlier Pi is running; quitting it first"
  osascript -e 'tell application "Pi" to quit' > /dev/null 2>&1 || true
  for _ in $(seq 1 10); do pgrep -x Pi > /dev/null || break; sleep 1; done
  pgrep -x Pi > /dev/null && fail "could not quit the Pi already running (pid $(pgrep -x Pi | tr '\n' ' '))"
fi

launched_at="$(date +%s)"
open "$app_dir" || fail "open $app_dir failed"

pid=""
for _ in $(seq 1 "$launch_timeout"); do
  pid="$(pgrep -x Pi | head -1 || true)"
  [ -n "$pid" ] && break
  sleep 1
done
[ -n "$pid" ] || fail "no Pi process appeared within ${launch_timeout}s"
pass "running as pid $pid"

cleanup() {
  [ "$keep_running" = 1 ] && return 0
  osascript -e 'tell application "Pi" to quit' > /dev/null 2>&1 || true
  for _ in $(seq 1 10); do pgrep -x Pi > /dev/null || return 0; sleep 1; done
  kill "$pid" 2>/dev/null || true
}
trap cleanup EXIT

# LaunchServices check-in is the app answering the window server, not just a
# process existing — a binary that dies in dyld never gets here.
checked_in=0
for _ in $(seq 1 "$launch_timeout"); do
  if lsappinfo info -app "$bundle_id" 2>/dev/null | grep -q 'checkin time'; then
    checked_in=1; break
  fi
  sleep 1
done
[ "$checked_in" = 1 ] || fail "Pi never checked in with LaunchServices"
pass "checked in with LaunchServices as a foreground app"

# ----------------------------------------------------- 5. it is really up
step "Window"
window_check="$(mktemp -d)/pi-window-check"
swiftc -O "$project_dir/scripts/pi-window-check.swift" -o "$window_check" 2>/tmp/pi-smoke-windowcheck.log || {
  cat /tmp/pi-smoke-windowcheck.log >&2
  fail "could not build scripts/pi-window-check.swift"
}
window=""
for _ in $(seq 1 "$window_timeout"); do
  window="$("$window_check" "$pid" 960 700 2>/dev/null | head -1 || true)"
  [ -n "$window" ] && break
  sleep 1
done
[ -n "$window" ] || fail "no Pi window at least 960x700 appeared within ${window_timeout}s"
pass "$window on screen"

step "Stability"
sleep "$settle"
kill -0 "$pid" 2>/dev/null || fail "Pi exited during the ${settle}s settle"
pass "still running ${settle}s after its window appeared"

crash_dir="$HOME/Library/Logs/DiagnosticReports"
if [ -d "$crash_dir" ]; then
  # find exits nonzero on any unreadable entry, and pipefail would take that
  # for a failed check.
  recent="$(find "$crash_dir" -name 'Pi-*.ips' -newermt "@$launched_at" 2>/dev/null | head -1 || true)"
  [ -z "$recent" ] || fail "a crash report was written this run: $recent"
fi
pass "no crash report since launch"

# ------------------------------------------------------------------ 6. quit
step "Quit"
if [ "$keep_running" = 1 ]; then
  echo "  --keep-running: leaving pid $pid up"
else
  trap - EXIT
  osascript -e 'tell application "Pi" to quit' > /dev/null 2>&1 || fail "the quit AppleScript failed"
  gone=0
  for _ in $(seq 1 15); do
    kill -0 "$pid" 2>/dev/null || { gone=1; break; }
    sleep 1
  done
  [ "$gone" = 1 ] || { kill "$pid" 2>/dev/null || true; fail "Pi did not quit within 15s"; }
  pass "quit cleanly"
fi

echo
echo "PASS — $checks checks, macOS $os_version on $arch"

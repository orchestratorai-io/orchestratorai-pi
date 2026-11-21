// Does the process we launched have a real window on screen?
//
// Usage: pi-window-check <pid> [minWidth] [minHeight]
//
// CGWindowListCopyWindowInfo gives owner pid and bounds without any privacy
// grant — unlike the accessibility tree the clickthrough harness walks, which
// needs the calling terminal in System Settings → Accessibility. That makes
// this usable from an unattended handoff. Window *titles* would need Screen
// Recording, so we never read them.
import CoreGraphics
import Foundation

let args = CommandLine.arguments
guard args.count > 1, let wantedPID = Int(args[1]) else {
    FileHandle.standardError.write(Data("usage: pi-window-check <pid> [minWidth] [minHeight]\n".utf8))
    exit(2)
}
let minWidth = args.count > 2 ? Double(args[2]) ?? 200 : 200
let minHeight = args.count > 3 ? Double(args[3]) ?? 200 : 200

guard let list = CGWindowListCopyWindowInfo(
    [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID
) as? [[String: Any]] else {
    FileHandle.standardError.write(Data("could not read the window list\n".utf8))
    exit(2)
}

var found = 0
for window in list {
    guard (window[kCGWindowOwnerPID as String] as? Int) == wantedPID,
          let bounds = window[kCGWindowBounds as String] as? [String: Any],
          let width = bounds["Width"] as? Double,
          let height = bounds["Height"] as? Double,
          width >= minWidth, height >= minHeight
    else { continue }
    found += 1
    print("window \(Int(width))x\(Int(height))")
}
exit(found > 0 ? 0 : 1)

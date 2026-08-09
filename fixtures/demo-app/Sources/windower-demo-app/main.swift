import AppKit
import Foundation

// MARK: - Click logging

/// Appends one JSONL record per button click to the log file configured via
/// `WINDOWER_DEMO_LOG` (or `./demo-app-clicks.jsonl` relative to CWD if unset).
/// `seq` is a single global counter shared across all three buttons, not a
/// per-button counter — the e2e harness uses it to assert click *ordering*
/// across buttons, not just per-button counts.
final class ClickLogger {
    private let fileHandle: FileHandle
    private var seq: Int = 0
    private let isoFormatter = ISO8601DateFormatter()

    init() {
        let path = ProcessInfo.processInfo.environment["WINDOWER_DEMO_LOG"] ?? "./demo-app-clicks.jsonl"
        let fileManager = FileManager.default
        if !fileManager.fileExists(atPath: path) {
            fileManager.createFile(atPath: path, contents: nil)
        }
        guard let handle = FileHandle(forWritingAtPath: path) else {
            fatalError("windower-demo-app: could not open log file at \(path)")
        }
        handle.seekToEndOfFile()
        self.fileHandle = handle
    }

    func logClick(button: String) {
        seq += 1
        let clickedAt = isoFormatter.string(from: Date())
        // Field order matches the documented contract exactly:
        // {"button":"demo-btn-1","seq":1,"clickedAt":"2026-...Z"}
        let line = "{\"button\":\"\(button)\",\"seq\":\(seq),\"clickedAt\":\"\(clickedAt)\"}\n"
        guard let data = line.data(using: .utf8) else { return }
        fileHandle.write(data)
        // No internal buffering beyond what FileHandle.write already
        // flushes to the OS — safe for a test harness tailing the file.
        try? fileHandle.synchronize()
    }
}

// MARK: - App delegate

final class DemoAppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private let clickLogger = ClickLogger()

    // Button geometry contract (content-view coordinates, AppKit bottom-left
    // origin, NOT flipped): each button is 100x50pt, centers land at
    // (150,150), (450,150), (750,150) for demo-btn-1/2/3 respectively.
    // origin = center - (width/2, height/2) = center - (50, 25).
    private let buttonSize = NSSize(width: 100, height: 50)
    private let buttonCenters: [(title: String, center: NSPoint)] = [
        ("demo-btn-1", NSPoint(x: 150, y: 150)),
        ("demo-btn-2", NSPoint(x: 450, y: 150)),
        ("demo-btn-3", NSPoint(x: 750, y: 150)),
    ]

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)

        let styleMask: NSWindow.StyleMask = [.titled, .closable, .resizable, .miniaturizable]
        let win = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 900, height: 700),
            styleMask: styleMask,
            backing: .buffered,
            defer: false
        )
        win.title = "Windower Demo App"
        // Set frame explicitly right after creation — do not let AppKit
        // auto-position the window.
        win.setFrame(NSRect(x: 200, y: 200, width: 900, height: 700), display: true)

        let contentView = NSView(frame: NSRect(x: 0, y: 0, width: 900, height: 700))
        win.contentView = contentView

        for (title, center) in buttonCenters {
            let origin = NSPoint(x: center.x - buttonSize.width / 2, y: center.y - buttonSize.height / 2)
            let button = NSButton(
                frame: NSRect(origin: origin, size: buttonSize)
            )
            button.title = title
            button.bezelStyle = .rounded
            button.setButtonType(.momentaryPushIn)
            button.target = self
            button.action = #selector(buttonClicked(_:))
            contentView.addSubview(button)
        }

        win.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.window = win

        // Poll target for e2e harnesses: printed only after the window has
        // been shown and activated.
        let pid = ProcessInfo.processInfo.processIdentifier
        print("WINDOW_READY pid=\(pid) title=\"Windower Demo App\"")
        fflush(stdout)
    }

    @objc private func buttonClicked(_ sender: NSButton) {
        clickLogger.logClick(button: sender.title)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}

// MARK: - Entry point

let app = NSApplication.shared
let delegate = DemoAppDelegate()
app.delegate = delegate
app.run()

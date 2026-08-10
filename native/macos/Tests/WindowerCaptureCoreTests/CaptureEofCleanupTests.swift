import AVFoundation
import XCTest

/// contracts/screen-capture-exclusivity.md §Process ownership: the capture
/// process is a child of whoever holds ScreenCaptureKit exclusivity, and a
/// dead parent is announced by stdin EOF (the OS closes the pipe). Before
/// exiting on that EOF the process MUST stop any active capture and finalize
/// its output, so the file left behind is decodable rather than truncated.
/// That EOF path is the ONLY orphan-prevention mechanism — there is no pid
/// tracking, reaper, or supervisor to test instead.
///
/// This drives the real built binary the same way `CaptureIntegrationTests`
/// does (`locateExecutable()` + three `Pipe()`s, with closing stdin as the EOF
/// trigger), but keeps stdin open across several requests, so it reads stdout
/// line-by-line instead of `readDataToEndOfFile()`. Every wait is bounded: a
/// hang-on-EOF regression must fail this test, not wedge the suite.
///
/// Starting a real capture needs the Screen Recording TCC grant, which cannot
/// be granted non-interactively (CLAUDE.md §"TCC permissions gate CI"), so an
/// ungranted host `XCTSkip`s rather than failing — same convention as
/// `locateExecutable()`'s missing-binary skip. The complementary un-skippable
/// coverage is `e2e/src/orphan-capture-child.e2e.test.ts`, which proves the
/// same path against a real `kill -9`'d parent.
final class CaptureEofCleanupTests: XCTestCase {
    // MARK: Harness

    /// Same lookup as `CaptureIntegrationTests.locateExecutable()`.
    private func locateExecutable() throws -> URL {
        let testBundleURL = Bundle(for: type(of: self)).bundleURL
        let candidate = testBundleURL.deletingLastPathComponent()
            .appendingPathComponent("windower-capture-macos")
        guard FileManager.default.isExecutableFile(atPath: candidate.path) else {
            throw XCTSkip(
                "windower-capture-macos executable not found next to test bundle at \(candidate.path); "
                    + "run `swift build` before `swift test` if this fails locally.")
        }
        return candidate
    }

    /// Reads newline-delimited JSON off a pipe on a background thread so the
    /// test can wait for one line with a deadline instead of blocking forever
    /// on `availableData`.
    private final class LineReader {
        private let lock = NSLock()
        private let arrived = DispatchSemaphore(value: 0)
        private var lines: [String] = []
        private var buffer = Data()
        private var reachedEof = false

        init(handle: FileHandle) {
            Thread.detachNewThread {
                while true {
                    let chunk = handle.availableData
                    if chunk.isEmpty {
                        self.lock.lock()
                        self.reachedEof = true
                        self.lock.unlock()
                        self.arrived.signal()
                        return
                    }
                    self.lock.lock()
                    self.buffer.append(chunk)
                    while let newline = self.buffer.firstIndex(of: 0x0A) {
                        let lineData = self.buffer.subdata(in: self.buffer.startIndex..<newline)
                        self.buffer.removeSubrange(self.buffer.startIndex...newline)
                        if let line = String(data: lineData, encoding: .utf8), !line.isEmpty {
                            self.lines.append(line)
                            self.arrived.signal()
                        }
                    }
                    self.lock.unlock()
                }
            }
        }

        /// The next complete line, or `nil` on EOF or once `timeout` elapses.
        func nextLine(timeout: TimeInterval) -> String? {
            let deadline = Date().addingTimeInterval(timeout)
            while true {
                lock.lock()
                if !lines.isEmpty {
                    let line = lines.removeFirst()
                    lock.unlock()
                    return line
                }
                let done = reachedEof
                lock.unlock()
                if done { return nil }
                let remaining = deadline.timeIntervalSinceNow
                if remaining <= 0 { return nil }
                _ = arrived.wait(timeout: .now() + remaining)
            }
        }
    }

    private func decode(_ line: String) throws -> [String: Any] {
        try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])
    }

    /// `XCTSkip`s on the taxonomy codes that mean "this host cannot capture",
    /// and fails on anything else.
    private func skipIfUngranted(_ response: [String: Any], during method: String) throws {
        guard let error = response["error"] as? [String: Any] else { return }
        let data = error["data"] as? [String: Any]
        let code = data?["code"] as? String ?? "<none>"
        let message = error["message"] as? String ?? "<no message>"
        if code == "PERMISSION_DENIED" || code == "UNSUPPORTED_CAPABILITY" {
            throw XCTSkip(
                "\(method) answered \(code) (\(message)) — this host has no Screen Recording grant, "
                    + "which cannot be granted non-interactively. Real-process coverage of the same "
                    + "EOF path lives in e2e/src/orphan-capture-child.e2e.test.ts.")
        }
        XCTFail("\(method) failed unexpectedly: \(code) — \(message)")
    }

    /// Waits for exit with a deadline. `readDataToEndOfFile()` would block
    /// forever on a hang-on-EOF regression; this fails fast instead.
    private func waitForExit(_ process: Process, timeout: TimeInterval) -> Bool {
        let exited = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in exited.signal() }
        // The handler is only invoked for a process that is still running when
        // it is installed; cover the already-exited race explicitly.
        if !process.isRunning { return true }
        return exited.wait(timeout: .now() + timeout) == .success
    }

    // MARK: Test

    func testStdinEofDuringActiveCaptureFinalizesTheOutputAndExits() async throws {
        let executableURL = try locateExecutable()

        let process = Process()
        process.executableURL = executableURL
        let stdin = Pipe()
        let stdout = Pipe()
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = Pipe()  // stderr is free-form logs only
        try process.run()
        defer { if process.isRunning { process.terminate() } }

        let reader = LineReader(handle: stdout.fileHandleForReading)
        func send(_ line: String) {
            stdin.fileHandleForWriting.write(Data((line + "\n").utf8))
        }

        // A display target needs no GUI fixture and is always present.
        send(#"{"jsonrpc":"2.0","id":1,"method":"enumerateTargets","params":{"kinds":["display"]}}"#)
        guard let enumerateLine = reader.nextLine(timeout: 20) else {
            XCTFail("enumerateTargets produced no response within 20s")
            return
        }
        let enumerated = try decode(enumerateLine)
        try skipIfUngranted(enumerated, during: "enumerateTargets")
        let targets = try XCTUnwrap(
            (enumerated["result"] as? [String: Any])?["targets"] as? [[String: Any]])
        guard let displayId = targets.compactMap({ $0["id"] as? String }).first else {
            throw XCTSkip("no display targets enumerated on this host")
        }

        let sessionId = "eof-cleanup-\(UUID().uuidString)"
        let outputURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("windower-\(sessionId).mp4")
        defer { try? FileManager.default.removeItem(at: outputURL) }

        send(
            """
            {"jsonrpc":"2.0","id":2,"method":"startCapture","params":{"sessionId":"\(sessionId)",\
            "target":{"kind":"display","id":"\(displayId)"},\
            "video":{"fps":10,"codec":"h264","container":"mp4","quality":"medium","showCursor":false},\
            "audio":{"tracks":[],"separateTracks":false}}}
            """)
        guard let startLine = reader.nextLine(timeout: 30) else {
            XCTFail("startCapture produced no response within 30s")
            return
        }
        let started = try decode(startLine)
        try skipIfUngranted(started, during: "startCapture")
        XCTAssertEqual((started["result"] as? [String: Any])?["started"] as? Bool, true)

        // Let a few real frames land — `stopCapture`'s teardown (which the EOF
        // path reuses) deliberately refuses to finalize a zero-frame session.
        try await Task.sleep(nanoseconds: 2_000_000_000)

        // THE trigger under test: closing stdin is exactly what a dead parent
        // does to this process.
        try stdin.fileHandleForWriting.close()

        XCTAssertTrue(
            waitForExit(process, timeout: 30),
            "windower-capture-macos did not exit on stdin EOF within 30s — the ownership model in "
                + "contracts/screen-capture-exclusivity.md §Process ownership is the only thing "
                + "preventing an orphaned ScreenCaptureKit process.")
        XCTAssertEqual(process.terminationStatus, 0, "EOF must be a clean exit, not a crash")

        XCTAssertTrue(
            FileManager.default.fileExists(atPath: outputURL.path),
            "EOF mid-recording left no output file at \(outputURL.path)")

        // Decodability is the actual requirement: an `AVAssetWriter` that was
        // never finished leaves a file whose moov atom is missing, so it has no
        // readable tracks and no duration.
        let asset = AVURLAsset(url: outputURL)
        let videoTracks = try await asset.loadTracks(withMediaType: .video)
        XCTAssertFalse(
            videoTracks.isEmpty,
            "the file left behind has no readable video track — it was not finalized")
        let duration = try await asset.load(.duration)
        XCTAssertGreaterThan(
            CMTimeGetSeconds(duration), 0,
            "the file left behind has no duration — it was not finalized")
    }
}

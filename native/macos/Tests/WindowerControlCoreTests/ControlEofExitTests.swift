import XCTest

/// contracts/screen-capture-exclusivity.md §Process ownership: "The same
/// ownership semantics apply to `windower-control-macos`: it MUST also exit on
/// stdin EOF. It simply has no capture state to clean up first, so the EOF
/// path is a plain exit."
///
/// This is the control surface's half of that rule, and its whole content is
/// that nothing was added: no stream to stop, no writer to finalize, no
/// cleanup machinery — just exit. Needs no TCC grant and no GUI, so unlike
/// `CaptureEofCleanupTests` it runs unconditionally in CI.
///
/// `ControlIntegrationTests.roundTrip` can't express this: it closes stdin and
/// then blocks in `readDataToEndOfFile()`, so a hang-on-EOF regression would
/// hang the suite rather than fail it. Every wait here is bounded.
final class ControlEofExitTests: XCTestCase {
    private func locateExecutable() throws -> URL {
        let testBundleURL = Bundle(for: type(of: self)).bundleURL
        let candidate = testBundleURL.deletingLastPathComponent()
            .appendingPathComponent("windower-control-macos")
        guard FileManager.default.isExecutableFile(atPath: candidate.path) else {
            throw XCTSkip(
                "windower-control-macos executable not found next to test bundle at \(candidate.path); "
                    + "run `swift build` before `swift test` if this fails locally.")
        }
        return candidate
    }

    private func waitForExit(_ process: Process, timeout: TimeInterval) -> Bool {
        let exited = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in exited.signal() }
        if !process.isRunning { return true }
        return exited.wait(timeout: .now() + timeout) == .success
    }

    /// Closing stdin is exactly what a dead parent does to this process.
    private func assertExitsOnStdinEof(afterSending requestLines: [String]) throws {
        let process = Process()
        process.executableURL = try locateExecutable()
        let stdin = Pipe()
        process.standardInput = stdin
        process.standardOutput = Pipe()
        process.standardError = Pipe()
        try process.run()
        defer { if process.isRunning { process.terminate() } }

        for line in requestLines {
            stdin.fileHandleForWriting.write(Data((line + "\n").utf8))
        }
        try stdin.fileHandleForWriting.close()

        XCTAssertTrue(
            waitForExit(process, timeout: 15),
            "windower-control-macos did not exit on stdin EOF within 15s — a parent's death would "
                + "leave it orphaned, which is precisely what the EOF path exists to prevent.")
        XCTAssertEqual(process.terminationStatus, 0, "EOF must be a clean exit, not a crash")
    }

    func testExitsOnStdinEofWithNoRequests() throws {
        try assertExitsOnStdinEof(afterSending: [])
    }

    func testExitsOnStdinEofAfterServicingARequest() throws {
        try assertExitsOnStdinEof(afterSending: [
            #"{"jsonrpc":"2.0","id":1,"method":"describe","params":{}}"#
        ])
    }

    /// A request still in flight on `rpcQueue` when EOF arrives is drained by
    /// `inFlightRequests.wait()` — which must delay the exit, never prevent it.
    func testExitsOnStdinEofWhileARequestIsStillInFlight() throws {
        try assertExitsOnStdinEof(afterSending: [
            #"{"jsonrpc":"2.0","id":1,"method":"performInput","params":{"actions":[{"kind":"wait","durationMs":750}]}}"#
        ])
    }
}

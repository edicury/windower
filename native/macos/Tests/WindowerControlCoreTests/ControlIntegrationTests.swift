import XCTest

/// Phase 21 — the control surface's mirror of `CaptureIntegrationTests`:
/// spawns the built `windower-control-macos` binary and drives real JSON-RPC
/// through its stdio loop. `describe`, `getPermissions` and an unknown-method
/// rejection all require no TCC grant and no GUI, so this runs headlessly in
/// CI (CLAUDE.md's "TCC permissions gate CI"); actually posting events needs
/// the Accessibility grant and stays e2e-gated.
final class ControlIntegrationTests: XCTestCase {
    func locateExecutable() throws -> URL {
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

    /// Sends every line in `requestLines` and returns every response line
    /// decoded, keyed by nothing — order is deliberately not asserted, since
    /// the contract explicitly permits out-of-order responses.
    func roundTrip(_ requestLines: [String]) throws -> [[String: Any]] {
        let executableURL = try locateExecutable()

        let process = Process()
        process.executableURL = executableURL
        let stdin = Pipe()
        let stdout = Pipe()
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = Pipe()

        try process.run()

        for line in requestLines {
            stdin.fileHandleForWriting.write(Data((line + "\n").utf8))
        }
        try stdin.fileHandleForWriting.close()

        let outputData = stdout.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()

        let outputString = try XCTUnwrap(String(data: outputData, encoding: .utf8))
        return try outputString.split(separator: "\n").map {
            try XCTUnwrap(
                try JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any])
        }
    }

    func testDescribeAdvertisesOnlyTheControlSurface() throws {
        let responses = try roundTrip([
            #"{"jsonrpc":"2.0","id":1,"method":"describe","params":{}}"#
        ])
        let obj = try XCTUnwrap(responses.first)
        XCTAssertEqual(obj["jsonrpc"] as? String, "2.0")
        XCTAssertEqual(obj["id"] as? Int, 1)

        let result = try XCTUnwrap(obj["result"] as? [String: Any])
        XCTAssertEqual(result["platform"] as? String, "macos")
        XCTAssertNotNil(result["version"] as? String)

        let capabilities = try XCTUnwrap(result["capabilities"] as? [String])
        XCTAssertEqual(Set(capabilities), ["input.mouse", "input.keyboard", "window-control"])
    }

    /// The whole point of the split: every capture-surface method must be
    /// unknown here. If one of these ever starts succeeding, this binary has
    /// grown a second ScreenCaptureKit consumer.
    func testCaptureSurfaceMethodsAreUnsupportedOnTheControlBinary() throws {
        let methods = [
            "enumerateTargets", "startCapture", "stopCapture", "cancelCapture", "captureFrame",
        ]
        let responses = try roundTrip(
            methods.enumerated().map { index, method in
                #"{"jsonrpc":"2.0","id":\#(index + 1),"method":"\#(method)","params":{}}"#
            })
        XCTAssertEqual(responses.count, methods.count)
        for obj in responses {
            let error = try XCTUnwrap(obj["error"] as? [String: Any], "unexpected success: \(obj)")
            let data = try XCTUnwrap(error["data"] as? [String: Any])
            XCTAssertEqual(data["code"] as? String, "UNSUPPORTED_CAPABILITY")
        }
    }

    /// The control-relevant permission subset: `accessibility` only. The other
    /// two kinds must be ABSENT (meaning "unknown", to be merged from a
    /// capture connection) rather than reported as `denied`.
    func testGetPermissionsReportsOnlyTheControlRelevantSubset() throws {
        let responses = try roundTrip([
            #"{"jsonrpc":"2.0","id":1,"method":"getPermissions","params":{}}"#
        ])
        let result = try XCTUnwrap(responses.first?["result"] as? [String: Any])
        XCTAssertNotNil(result["accessibility"])
        XCTAssertNil(result["screenRecording"])
        XCTAssertNil(result["microphone"])
        XCTAssertEqual(result["sidecarAvailable"] as? Bool, true)
    }

    /// `performInput`'s `sessionId` is a correlation hint the control surface
    /// must never validate — it owns no sessions, so an unrecognized id must
    /// not produce `SESSION_NOT_FOUND`. A `wait`-only action list posts no
    /// events, so this needs no Accessibility grant when it is granted, and
    /// fails with PERMISSION_DENIED (never SESSION_NOT_FOUND) when it isn't.
    func testPerformInputNeverRejectsAnUnknownSessionId() throws {
        let responses = try roundTrip([
            #"{"jsonrpc":"2.0","id":1,"method":"performInput","params":{"sessionId":"no-such-session","actions":[{"kind":"wait","durationMs":0}]}}"#
        ])
        let obj = try XCTUnwrap(responses.first)
        if let error = obj["error"] as? [String: Any] {
            let data = try XCTUnwrap(error["data"] as? [String: Any])
            XCTAssertEqual(
                data["code"] as? String, "PERMISSION_DENIED",
                "the only acceptable failure here is a missing Accessibility grant")
        } else {
            let result = try XCTUnwrap(obj["result"] as? [String: Any])
            XCTAssertEqual(result["performed"] as? Int, 1)
        }
    }

    /// contracts/sidecar-protocol.md §Transport: a backend MAY answer out of
    /// order, and a stalled request must not block servicing others. A
    /// `performInput` sleeping on a long `wait` is the control surface's
    /// equivalent of the capture surface's wedged `SCShareableContent` call.
    func testASlowRequestDoesNotBlockAConcurrentOne() throws {
        let responses = try roundTrip([
            #"{"jsonrpc":"2.0","id":1,"method":"performInput","params":{"actions":[{"kind":"wait","durationMs":1500}]}}"#,
            #"{"jsonrpc":"2.0","id":2,"method":"describe","params":{}}"#,
        ])
        XCTAssertEqual(responses.count, 2)
        // `describe` is answered while the wait is still sleeping, so it comes
        // back FIRST — the observable proof the dispatch is concurrent. (If
        // the Accessibility grant is missing, `performInput` fails fast and
        // this ordering is not meaningful, so only assert both arrived.)
        let ids = responses.compactMap { $0["id"] as? Int }
        XCTAssertEqual(Set(ids), [1, 2])
        if responses.first?["error"] == nil, responses.count == 2 {
            let firstId = responses[0]["id"] as? Int
            let performInputSucceeded = responses.contains {
                ($0["id"] as? Int) == 1 && $0["result"] != nil
            }
            if performInputSucceeded {
                XCTAssertEqual(
                    firstId, 2,
                    "describe should be answered before the still-sleeping performInput")
            }
        }
    }
}

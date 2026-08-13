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
        XCTAssertEqual(Set(capabilities), ["window-control"])
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

    /// Phase 24 removed the Operator, and with it `performInput`/
    /// `enumerateElements` — their only caller. Both methods must now fall
    /// through to the `default` branch and answer `UNSUPPORTED_CAPABILITY`,
    /// exactly like any other method this implementation no longer
    /// advertises (settled decision 2, tasks/phase-24-remove-operator.md).
    func testPerformInputAndEnumerateElementsAreNoLongerSupported() throws {
        let methods = ["performInput", "enumerateElements"]
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

}

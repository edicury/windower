import XCTest

/// Spawns the built `windower-capture-macos` executable and pipes real
/// requests through its stdin/stdout, asserting the JSON response shape —
/// modeled off the Phase 0 plumbing proof this replaces. `describe` requires
/// no TCC permission or GUI, so this runs headlessly in CI.
///
/// Phase 21 renamed the binary from `windower-sidecar-macos` and split the
/// control surface out into `windower-control-macos`; the surface-boundary
/// assertions below (control methods answering `UNSUPPORTED_CAPABILITY`, no
/// `input.*`/`window-control` in `describe`) are what keep the split from
/// silently regressing at the protocol level, the same way
/// `scripts/check-no-screencapturekit.sh` keeps it from regressing at the
/// link level.
final class CaptureIntegrationTests: XCTestCase {
    /// Locates the sibling `windower-capture-macos` executable next to this
    /// test bundle — `swift test` builds the executable target into the
    /// same `.build/<triple>/debug` (or `/release`) directory as the test
    /// bundle, so `Bundle(for:)`'s directory is the right place to look
    /// without hardcoding a build configuration.
    func locateExecutable() throws -> URL {
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

    /// Sends one request line and returns the first response line's decoded
    /// JSON object.
    func roundTrip(_ requestLine: String) throws -> [String: Any] {
        let executableURL = try locateExecutable()

        let process = Process()
        process.executableURL = executableURL
        let stdin = Pipe()
        let stdout = Pipe()
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = Pipe()  // discard stderr logs

        try process.run()

        stdin.fileHandleForWriting.write(Data((requestLine + "\n").utf8))
        try stdin.fileHandleForWriting.close()

        let outputData = stdout.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()

        let outputString = try XCTUnwrap(String(data: outputData, encoding: .utf8))
        let firstLine = try XCTUnwrap(outputString.split(separator: "\n").first)
        return try XCTUnwrap(
            try JSONSerialization.jsonObject(with: Data(firstLine.utf8)) as? [String: Any])
    }

    func testDescribeRequestOverRealProcess() throws {
        let obj = try roundTrip(#"{"jsonrpc":"2.0","id":1,"method":"describe","params":{}}"#)
        XCTAssertEqual(obj["jsonrpc"] as? String, "2.0")
        XCTAssertEqual(obj["id"] as? Int, 1)

        let result = try XCTUnwrap(obj["result"] as? [String: Any])
        XCTAssertEqual(result["platform"] as? String, "macos")
        XCTAssertNotNil(result["version"] as? String)

        let capabilities = try XCTUnwrap(result["capabilities"] as? [String])
        XCTAssertTrue(capabilities.contains("enumerate.displays"))
        XCTAssertTrue(capabilities.contains("enumerate.windows"))
        // Implemented as of Phase 4.
        XCTAssertTrue(capabilities.contains("capture.display"))
        XCTAssertTrue(capabilities.contains("capture.window"))
        XCTAssertTrue(capabilities.contains("capture.region"))
        // Implemented as of Phase 5.
        XCTAssertTrue(capabilities.contains("audio.system"))
        XCTAssertTrue(capabilities.contains("audio.microphone"))
        // Implemented as of Phase 10.
        XCTAssertTrue(capabilities.contains("eventTimeline.cursor"))
        XCTAssertTrue(capabilities.contains("eventTimeline.mouse"))
        // Advertised optimistically (best-effort, per-session truthfulness
        // reported via a `log` notification instead) — see main.swift's doc
        // comment on `supportedCapabilities`.
        XCTAssertTrue(capabilities.contains("eventTimeline.keyboard"))
        // Phase 19.
        XCTAssertTrue(capabilities.contains("screenshot"))
    }

    /// Phase 21 §Handshake: "each `describe` reports only the capabilities of
    /// the methods that implementation actually serves".
    func testDescribeDoesNotAdvertiseControlSurfaceCapabilities() throws {
        let obj = try roundTrip(#"{"jsonrpc":"2.0","id":2,"method":"describe","params":{}}"#)
        let result = try XCTUnwrap(obj["result"] as? [String: Any])
        let capabilities = try XCTUnwrap(result["capabilities"] as? [String])
        XCTAssertFalse(capabilities.contains("input.mouse"))
        XCTAssertFalse(capabilities.contains("input.keyboard"))
        XCTAssertFalse(capabilities.contains("window-control"))
    }

    /// Control-surface methods are not merely unimplemented here — dispatching
    /// them would recreate the coupling phase 21 removes, so they must answer
    /// the same way any unadvertised method does.
    func testControlSurfaceMethodsAreUnsupportedOnTheCaptureBinary() throws {
        for method in ["performInput", "resizeWindow"] {
            let obj = try roundTrip(
                #"{"jsonrpc":"2.0","id":3,"method":"\#(method)","params":{}}"#)
            let error = try XCTUnwrap(
                obj["error"] as? [String: Any], "\(method) unexpectedly succeeded")
            let data = try XCTUnwrap(error["data"] as? [String: Any])
            XCTAssertEqual(data["code"] as? String, "UNSUPPORTED_CAPABILITY", "for \(method)")
        }
    }

    /// The capture surface reports the capture-relevant permission kinds and
    /// stays silent about `accessibility`, which belongs to the control
    /// surface (contracts/sidecar-protocol.md §Method-ownership surfaces). An
    /// absent kind means "unknown", which is why it must be absent rather than
    /// reported as `denied`.
    func testGetPermissionsReportsOnlyTheCaptureRelevantSubset() throws {
        let obj = try roundTrip(#"{"jsonrpc":"2.0","id":4,"method":"getPermissions","params":{}}"#)
        let result = try XCTUnwrap(obj["result"] as? [String: Any])
        XCTAssertNotNil(result["screenRecording"])
        XCTAssertNotNil(result["microphone"])
        XCTAssertNil(result["accessibility"])
        XCTAssertEqual(result["sidecarAvailable"] as? Bool, true)
    }

    func testUnknownMethodReturnsUnsupportedCapabilityTaxonomyCode() throws {
        let obj = try roundTrip(#"{"jsonrpc":"2.0","id":9,"method":"totallyBogus","params":{}}"#)
        let error = try XCTUnwrap(obj["error"] as? [String: Any])
        let data = try XCTUnwrap(error["data"] as? [String: Any])
        XCTAssertEqual(data["code"] as? String, "UNSUPPORTED_CAPABILITY")
    }
}

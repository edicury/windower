import XCTest

/// Spawns the built `windower-sidecar-macos` executable and pipes a real
/// `describe` request through its stdin/stdout, asserting the JSON response
/// shape — modeled off the Phase 0 plumbing proof this replaces. `describe`
/// requires no TCC permission or GUI, so this runs headlessly in CI.
final class IntegrationTests: XCTestCase {
    /// Locates the sibling `windower-sidecar-macos` executable next to this
    /// test bundle — `swift test` builds the executable target into the
    /// same `.build/<triple>/debug` (or `/release`) directory as the test
    /// bundle, so `Bundle(for:)`'s directory is the right place to look
    /// without hardcoding a build configuration.
    func locateExecutable() throws -> URL {
        let testBundleURL = Bundle(for: type(of: self)).bundleURL
        let candidate = testBundleURL.deletingLastPathComponent()
            .appendingPathComponent("windower-sidecar-macos")
        guard FileManager.default.isExecutableFile(atPath: candidate.path) else {
            throw XCTSkip(
                "windower-sidecar-macos executable not found next to test bundle at \(candidate.path); "
                    + "run `swift build` before `swift test` if this fails locally.")
        }
        return candidate
    }

    func testDescribeRequestOverRealProcess() throws {
        let executableURL = try locateExecutable()

        let process = Process()
        process.executableURL = executableURL
        let stdin = Pipe()
        let stdout = Pipe()
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = Pipe()  // discard stderr logs

        try process.run()

        let request = #"{"jsonrpc":"2.0","id":1,"method":"describe","params":{}}"# + "\n"
        stdin.fileHandleForWriting.write(Data(request.utf8))
        try stdin.fileHandleForWriting.close()

        let outputData = stdout.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()

        let outputString = try XCTUnwrap(String(data: outputData, encoding: .utf8))
        let firstLine = try XCTUnwrap(outputString.split(separator: "\n").first)

        let obj = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: Data(firstLine.utf8)) as? [String: Any])
        XCTAssertEqual(obj["jsonrpc"] as? String, "2.0")
        XCTAssertEqual(obj["id"] as? Int, 1)

        let result = try XCTUnwrap(obj["result"] as? [String: Any])
        XCTAssertEqual(result["platform"] as? String, "macos")
        XCTAssertNotNil(result["version"] as? String)

        let capabilities = try XCTUnwrap(result["capabilities"] as? [String])
        XCTAssertTrue(capabilities.contains("enumerate.displays"))
        XCTAssertTrue(capabilities.contains("enumerate.windows"))
        // Implemented as of Phase 3.
        XCTAssertTrue(capabilities.contains("window-control"))
        // Not yet implemented at this phase — must not be advertised.
        XCTAssertFalse(capabilities.contains("capture.display"))
    }

    func testUnknownMethodReturnsUnsupportedCapabilityTaxonomyCode() throws {
        let executableURL = try locateExecutable()

        let process = Process()
        process.executableURL = executableURL
        let stdin = Pipe()
        let stdout = Pipe()
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = Pipe()

        try process.run()

        let request = #"{"jsonrpc":"2.0","id":9,"method":"totallyBogus","params":{}}"# + "\n"
        stdin.fileHandleForWriting.write(Data(request.utf8))
        try stdin.fileHandleForWriting.close()

        let outputData = stdout.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()

        let outputString = try XCTUnwrap(String(data: outputData, encoding: .utf8))
        let firstLine = try XCTUnwrap(outputString.split(separator: "\n").first)
        let obj = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: Data(firstLine.utf8)) as? [String: Any])

        let error = try XCTUnwrap(obj["error"] as? [String: Any])
        let data = try XCTUnwrap(error["data"] as? [String: Any])
        XCTAssertEqual(data["code"] as? String, "UNSUPPORTED_CAPABILITY")
    }
}

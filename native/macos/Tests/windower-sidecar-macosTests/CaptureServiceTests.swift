import Foundation
import XCTest

@testable import WindowerSidecarCore

/// Headless-safe tests for Phase 4's capture RPC surface: wire-shape
/// encode/decode against the exact schemas in
/// `packages/core/src/protocol/methods.ts`, target-union decoding, and the
/// SESSION_NOT_FOUND paths.
///
/// A real `SCStream` capture is NOT exercised here — it needs a Screen
/// Recording TCC grant and a live GUI session, which CI cannot provide
/// (CLAUDE.md "TCC permissions gate CI"). That verification is deferred to
/// Phase 13's local e2e run, exactly as Phase 2/3 deferred live
/// SCShareableContent/AXUIElement calls.
final class CaptureServiceTests: XCTestCase {

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: json.data(using: .utf8)!)
    }

    private func encodeToObject<T: Encodable>(_ value: T) throws -> [String: Any] {
        let data = try JSONEncoder().encode(value)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    // MARK: - CaptureTargetInput

    func testDecodesDisplayTarget() throws {
        let target = try decode(
            CaptureTargetInput.self,
            """
            {"kind":"display","id":"1","name":"Built-in","bounds":{"x":0,"y":0,"width":2560,"height":1600},"isPrimary":true,"scaleFactor":2}
            """)
        XCTAssertEqual(target.kind, "display")
        XCTAssertEqual(target.id, "1")
        XCTAssertNil(target.displayId)
        XCTAssertEqual(target.bounds, Rect(x: 0, y: 0, width: 2560, height: 1600))
    }

    func testDecodesWindowTarget() throws {
        let target = try decode(
            CaptureTargetInput.self,
            """
            {"kind":"window","id":"4242","title":"Safari","appName":"Safari","appBundleId":"com.apple.Safari","bounds":{"x":100,"y":200,"width":1280,"height":720},"isFocused":true,"resizable":true}
            """)
        XCTAssertEqual(target.kind, "window")
        XCTAssertEqual(target.id, "4242")
        XCTAssertNil(target.displayId)
        XCTAssertEqual(target.bounds, Rect(x: 100, y: 200, width: 1280, height: 720))
    }

    func testDecodesRegionTarget() throws {
        let target = try decode(
            CaptureTargetInput.self,
            """
            {"kind":"region","displayId":"1","bounds":{"x":40,"y":80,"width":800,"height":600}}
            """)
        XCTAssertEqual(target.kind, "region")
        XCTAssertNil(target.id)
        XCTAssertEqual(target.displayId, "1")
        XCTAssertEqual(target.bounds, Rect(x: 40, y: 80, width: 800, height: 600))
    }

    // MARK: - StartCaptureParams

    func testDecodesFullStartCaptureParams() throws {
        let params = try decode(
            StartCaptureParams.self,
            """
            {"sessionId":"sess-1",
             "target":{"kind":"window","id":"7","title":"t","appName":"a","appBundleId":"b","bounds":{"x":0,"y":0,"width":10,"height":10},"isFocused":false,"resizable":true},
             "video":{"fps":60,"codec":"hevc","container":"mov","resolution":{"width":1920,"height":1080},"quality":"high","showCursor":true},
             "audio":{"tracks":[{"source":"system","enabled":true},{"source":"microphone","enabled":true,"deviceId":"dev-1"},{"source":"narration","filePath":"/tmp/n.wav","offsetMs":250}],"separateTracks":true}}
            """)
        XCTAssertEqual(params.sessionId, "sess-1")
        XCTAssertEqual(params.target.kind, "window")
        XCTAssertEqual(params.video.fps, 60)
        XCTAssertEqual(params.video.codec, "hevc")
        XCTAssertEqual(params.video.container, "mov")
        XCTAssertEqual(params.video.quality, "high")
        XCTAssertTrue(params.video.showCursor)
        XCTAssertEqual(params.video.resolution?.width, 1920)
        XCTAssertEqual(params.video.resolution?.height, 1080)
        // Audio is decoded opaquely this phase (video-only), but a
        // well-formed AudioSettings payload must never fail to decode.
        XCTAssertNotNil(params.audio)
    }

    func testDecodesStartCaptureParamsWithoutResolution() throws {
        let params = try decode(
            StartCaptureParams.self,
            """
            {"sessionId":"s","target":{"kind":"display","id":"1"},
             "video":{"fps":30,"codec":"h264","container":"mp4","quality":"medium","showCursor":false},
             "audio":{"tracks":[],"separateTracks":false}}
            """)
        XCTAssertNil(params.video.resolution)
        XCTAssertEqual(params.video.fps, 30)
        XCTAssertFalse(params.video.showCursor)
    }

    func testVideoSettingsRoundTrips() throws {
        let original = VideoSettingsInput(
            fps: 24, codec: "h264", container: "mp4",
            resolution: VideoSettingsInput.Resolution(width: 1280, height: 720),
            quality: "lossless_ish", showCursor: true)
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(VideoSettingsInput.self, from: data)
        XCTAssertEqual(decoded, original)
    }

    // MARK: - Result wire shapes

    func testStartCaptureResultWireShape() throws {
        let object = try encodeToObject(StartCaptureResult(started: true))
        XCTAssertEqual(object.keys.sorted(), ["started"])
        XCTAssertEqual(object["started"] as? Bool, true)
    }

    func testStopCaptureResultWireShape() throws {
        let result = StopCaptureResult(
            outputFilePath: "/tmp/windower-abc.mp4",
            actualDurationMs: 4210.5,
            actualResolution: StopCaptureResult.Resolution(width: 1920, height: 1080))
        let object = try encodeToObject(result)
        XCTAssertEqual(object.keys.sorted(), ["actualDurationMs", "actualResolution", "outputFilePath"])
        XCTAssertEqual(object["outputFilePath"] as? String, "/tmp/windower-abc.mp4")
        XCTAssertEqual(object["actualDurationMs"] as? Double, 4210.5)
        let resolution = try XCTUnwrap(object["actualResolution"] as? [String: Any])
        XCTAssertEqual(resolution["width"] as? Int, 1920)
        XCTAssertEqual(resolution["height"] as? Int, 1080)
    }

    func testCancelCaptureResultWireShape() throws {
        let object = try encodeToObject(CancelCaptureResult(canceled: true))
        XCTAssertEqual(object.keys.sorted(), ["canceled"])
        XCTAssertEqual(object["canceled"] as? Bool, true)
    }

    func testStopAndCancelParamsDecode() throws {
        XCTAssertEqual(try decode(StopCaptureParams.self, #"{"sessionId":"s1"}"#).sessionId, "s1")
        XCTAssertEqual(try decode(CancelCaptureParams.self, #"{"sessionId":"s2"}"#).sessionId, "s2")
    }

    func testCaptureEndedNotificationWireShape() throws {
        let object = try encodeToObject(
            CaptureEndedNotificationParams(sessionId: "s", reason: "target-closed"))
        XCTAssertEqual(object.keys.sorted(), ["reason", "sessionId"])
        XCTAssertEqual(object["sessionId"] as? String, "s")
        XCTAssertEqual(object["reason"] as? String, "target-closed")
    }

    func testCaptureEndedNotificationEncodesAsIdlessJsonRpcLine() throws {
        let params = try JSONCodec.encode(
            CaptureEndedNotificationParams(sessionId: "s", reason: "error"))
        let line = try XCTUnwrap(
            EnvelopeCodec.encodeLine(JsonRpcNotification(method: "captureEnded", params: params)))
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: line.data(using: .utf8)!) as? [String: Any])
        XCTAssertEqual(object["jsonrpc"] as? String, "2.0")
        XCTAssertEqual(object["method"] as? String, "captureEnded")
        XCTAssertNil(object["id"])
        XCTAssertFalse(line.contains("\n"))
    }

    // MARK: - SESSION_NOT_FOUND

    func testStopCaptureOnUnknownSessionThrowsSessionNotFound() {
        let manager = CaptureSessionManager()
        XCTAssertThrowsError(try manager.stopCapture(params: StopCaptureParams(sessionId: "nope"))) {
            error in
            guard let rpcError = error as? SidecarRpcError else {
                return XCTFail("Expected SidecarRpcError, got \(error)")
            }
            XCTAssertEqual(rpcError.taxonomyCode, .sessionNotFound)
        }
    }

    func testCancelCaptureOnUnknownSessionThrowsSessionNotFound() {
        let manager = CaptureSessionManager()
        XCTAssertThrowsError(
            try manager.cancelCapture(params: CancelCaptureParams(sessionId: "nope"))
        ) { error in
            guard let rpcError = error as? SidecarRpcError else {
                return XCTFail("Expected SidecarRpcError, got \(error)")
            }
            XCTAssertEqual(rpcError.taxonomyCode, .sessionNotFound)
        }
    }

    func testFreshManagerHasNoActiveSessions() {
        XCTAssertEqual(CaptureSessionManager().activeSessionCount, 0)
    }

    // MARK: - Notification hook

    func testNotificationHookIsSettableAndReadable() {
        let manager = CaptureSessionManager()
        XCTAssertNil(manager.onNotification)
        var received: (String, JSONValue)?
        manager.onNotification = { method, params in received = (method, params) }
        manager.onNotification?("captureEnded", .object(["sessionId": .string("s")]))
        XCTAssertEqual(received?.0, "captureEnded")
        XCTAssertEqual(received?.1, .object(["sessionId": .string("s")]))
    }
}

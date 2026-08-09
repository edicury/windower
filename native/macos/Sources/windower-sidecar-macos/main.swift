import Foundation
import WindowerSidecarCore

// windower-sidecar-macos — Phase 2: enumeration & permissions.
//
// Real newline-delimited JSON-RPC 2.0 stdio loop matching the Phase 1
// envelope in packages/core/src/protocol/jsonrpc.ts exactly. stderr is
// free-form logs only, never protocol data (contracts/sidecar-protocol.md
// §Transport).

let sidecarVersion = "0.1.0"

/// Capabilities this backend actually implements at this phase. audio.system
/// and audio.microphone are implemented as of Phase 5 (system audio via
/// `SCStreamConfiguration.capturesAudio` + a second `.audio` stream output;
/// microphone via `AVCaptureSession`) — see `CaptureSessionManager.startCapture`.
/// `audio.system.perApp` is NOT advertised: `AudioTrackConfig`
/// (data-model.md) has no field to request per-app audio, so there is
/// nothing for the daemon to invoke were it advertised.
///
/// `eventTimeline.cursor`/`eventTimeline.mouse`/`eventTimeline.keyboard`
/// (Phase 10) ARE advertised statically, matching
/// `contracts/sidecar-protocol.md`'s own `describe` example and
/// `packages/core/src/protocol/methods.ts`'s `CapabilitySchema` — `describe`
/// is a one-shot handshake at sidecar spawn, before any session exists, so
/// there is no protocol-level mechanism to report "keyboard capture worked
/// THIS session" through it. `eventTimeline.keyboard` here is therefore
/// optimistic ("this backend attempts keyboard capture"), the same
/// granularity every other capability in this list already has. The
/// genuinely per-session fact — whether a `CGEventTap` for key events could
/// actually be created this time (some secure-input contexts block it) — is
/// surfaced instead via a `log` notification
/// (`EventTapSource.installKeyTap`'s failure path) when it happens, so the
/// daemon/user at least has a signal even though the static capability list
/// can't be corrected retroactively. `eventTimeline.cursor`/`.mouse` have no
/// equivalent failure mode once Accessibility is granted (Phase 2/3
/// baseline), so they're unconditionally true.
let supportedCapabilities: [String] = [
    "enumerate.displays",
    "enumerate.windows",
    "enumerate.apps",
    "window-control",
    "capture.display",
    "capture.window",
    "capture.region",
    "audio.system",
    "audio.microphone",
    "eventTimeline.cursor",
    "eventTimeline.mouse",
    "eventTimeline.keyboard",
]

func logStderr(_ message: String) {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
}

/// stdout is written from two places: this file's synchronous dispatch loop
/// and SCStream's background delegate queues (via the `captureEnded`
/// notification hook). Interleaved partial writes would corrupt the
/// newline-delimited framing, so every write is serialized.
let stdoutLock = NSLock()

func writeLine(_ s: String) {
    let data = (s + "\n").data(using: .utf8)!
    stdoutLock.lock()
    FileHandle.standardOutput.write(data)
    stdoutLock.unlock()
}

/// Classifies a parsed JSON-RPC line the same way `classifyJsonRpcLine` does
/// in packages/core/src/protocol/jsonrpc.ts: a request carries both `method`
/// and `id`; a notification carries `method` without `id`.
enum LineKind {
    case request
    case notification
    case other
}

func classify(_ line: JsonRpcLine) -> LineKind {
    let hasId = line.id != nil
    let hasMethod = line.method != nil
    if hasMethod && hasId { return .request }
    if hasMethod && !hasId { return .notification }
    return .other
}

/// Decodes `params` (a `JSONValue?`) into a concrete `Decodable` type,
/// treating an absent/null params as `{}` for methods whose params schema
/// allows an empty object.
func decodeParams<T: Decodable>(_ type: T.Type, from params: JSONValue?) throws -> T {
    let value = params ?? .object([:])
    do {
        return try JSONCodec.decode(type, from: value)
    } catch {
        throw SidecarRpcError.invalidParams("Invalid params: \(error)")
    }
}

func handleRequest(id: JSONValue, method: String, params: JSONValue?) {
    do {
        let resultValue: JSONValue
        switch method {
        case "describe":
            struct DescribeResult: Encodable {
                let platform: String
                let version: String
                let capabilities: [String]
            }
            let result = DescribeResult(
                platform: "macos", version: sidecarVersion, capabilities: supportedCapabilities)
            resultValue = try JSONCodec.encode(result)

        case "enumerateTargets":
            let decodedParams = try decodeParams(EnumerateTargetsParams.self, from: params)
            do {
                let targets = try EnumerationService.enumerateTargets(kinds: decodedParams.kinds)
                resultValue = try JSONCodec.encode(EnumerateTargetsResult(targets: targets))
            } catch {
                // ScreenCaptureKit surfaces a lack of Screen Recording
                // permission as SCStreamErrorDomain code -3801 ("The user
                // declined TCCs for application, window, display capture")
                // rather than a typed Swift error — string-sniff it so
                // callers get PERMISSION_DENIED (the taxonomy code the
                // daemon actually branches on) instead of a generic
                // INTERNAL_ERROR.
                let nsError = error as NSError
                if nsError.domain == "com.apple.ScreenCaptureKit.SCStreamErrorDomain" && nsError.code == -3801 {
                    throw SidecarRpcError.serverError(
                        "enumerateTargets failed: Screen Recording permission not granted",
                        code: .permissionDenied)
                }
                throw SidecarRpcError.serverError(
                    "enumerateTargets failed: \(error)", code: .internalError)
            }

        case "getPermissions":
            let report = PermissionsService.currentReport(sidecarVersion: sidecarVersion)
            resultValue = try JSONCodec.encode(report)

        case "requestPermission":
            let decodedParams = try decodeParams(RequestPermissionParams.self, from: params)
            let semaphore = DispatchSemaphore(value: 0)
            var status: PermissionStatus = .notApplicable
            PermissionsService.requestPermission(decodedParams.kind) { resultStatus in
                status = resultStatus
                semaphore.signal()
            }
            semaphore.wait()
            resultValue = try JSONCodec.encode(RequestPermissionResult(status: status))

        case "resizeWindow":
            let decodedParams = try decodeParams(ResizeWindowParams.self, from: params)
            let result = try WindowControlService.resizeWindow(
                targetId: decodedParams.targetId, bounds: decodedParams.bounds)
            resultValue = try JSONCodec.encode(result)

        case "startCapture":
            let decodedParams = try decodeParams(StartCaptureParams.self, from: params)
            let result = try CaptureSessionManager.shared.startCapture(params: decodedParams)
            resultValue = try JSONCodec.encode(result)

        case "stopCapture":
            let decodedParams = try decodeParams(StopCaptureParams.self, from: params)
            let result = try CaptureSessionManager.shared.stopCapture(params: decodedParams)
            resultValue = try JSONCodec.encode(result)

        case "cancelCapture":
            let decodedParams = try decodeParams(CancelCaptureParams.self, from: params)
            let result = try CaptureSessionManager.shared.cancelCapture(params: decodedParams)
            resultValue = try JSONCodec.encode(result)

        default:
            throw SidecarRpcError.unsupportedCapability("Unknown method: \(method)")
        }

        let response = JsonRpcSuccessResponse(id: id, result: resultValue)
        if let line = EnvelopeCodec.encodeLine(response) {
            writeLine(line)
        }
    } catch let error as SidecarRpcError {
        writeErrorResponse(id: id, error: error)
    } catch {
        writeErrorResponse(
            id: id,
            error: SidecarRpcError.serverError("\(error)", code: .internalError))
    }
}

func writeErrorResponse(id: JSONValue, error: SidecarRpcError) {
    let response = JsonRpcErrorResponse(
        id: id,
        error: JsonRpcErrorObject(
            code: error.rpcCode,
            message: error.message,
            data: JsonRpcErrorData(code: error.taxonomyCode)
        )
    )
    if let line = EnvelopeCodec.encodeLine(response) {
        writeLine(line)
    }
}

func handle(line: String) {
    guard let data = line.data(using: .utf8) else {
        logStderr("windower-sidecar-macos: received non-UTF8 line, ignoring")
        return
    }
    let parsedLine: JsonRpcLine
    do {
        parsedLine = try JSONDecoder().decode(JsonRpcLine.self, from: data)
    } catch {
        logStderr("windower-sidecar-macos: failed to parse JSON-RPC line: \(error)")
        return
    }

    switch classify(parsedLine) {
    case .request:
        // `id` and `method` are guaranteed non-nil by `classify`.
        handleRequest(id: parsedLine.id!, method: parsedLine.method!, params: parsedLine.params)
    case .notification:
        // The sidecar currently receives no daemon→sidecar notifications
        // per contracts/sidecar-protocol.md; log and ignore unknown ones
        // rather than crashing.
        logStderr("windower-sidecar-macos: ignoring unexpected notification: \(parsedLine.method ?? "?")")
    case .other:
        logStderr("windower-sidecar-macos: ignoring line that is neither request nor notification")
    }
}

// Sidecar-initiated notifications (currently `captureEnded`) are emitted
// from SCStream's background delegate queues; `writeLine` is the
// serialized stdout writer they funnel through.
CaptureSessionManager.shared.onNotification = { method, params in
    let notification = JsonRpcNotification(method: method, params: params)
    if let line = EnvelopeCodec.encodeLine(notification) {
        writeLine(line)
    }
}

// Newline-delimited JSON-RPC 2.0 over stdio — contracts/sidecar-protocol.md
// §Transport. stdout carries protocol data ONLY; all logs go to stderr.
while let line = readLine(strippingNewline: true) {
    if line.isEmpty { continue }
    handle(line: line)
}

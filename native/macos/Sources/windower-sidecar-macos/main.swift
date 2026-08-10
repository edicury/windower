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
    // Phase 19 (operator). Advertised statically for the same reason the
    // eventTimeline.* entries are: `describe` is a one-shot handshake with no
    // mechanism to report a per-call outcome. `input.*` depends on the
    // Accessibility grant and `screenshot` on Screen Recording — both are
    // reported truthfully by `getPermissions`, and both surface
    // PERMISSION_DENIED per call when missing rather than being silently
    // dropped from this list. `screenshot` additionally needs macOS 14+
    // (SCScreenshotManager); a 13.x host answers UNSUPPORTED_CAPABILITY at
    // call time.
    "input.mouse",
    "input.keyboard",
    "screenshot",
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
                if case .timedOut(let afterMs)? = error as? EnumerationError {
                    // bugs.spec.md #6: don't let a wedged SCShareableContent
                    // completion handler hang this RPC (and therefore the
                    // whole single-threaded sidecar) forever — see
                    // `EnumerationError.timedOut`'s doc.
                    throw SidecarRpcError.serverError(
                        "enumerateTargets failed: SCShareableContent did not respond within \(Int(afterMs))ms",
                        code: .captureFailed)
                }
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

        case "performInput":
            let decodedParams = try decodeParams(PerformInputParams.self, from: params)
            let result = try InputSynthesisService.perform(params: decodedParams)
            resultValue = try JSONCodec.encode(result)

        case "captureFrame":
            let decodedParams = try decodeParams(CaptureFrameParams.self, from: params)
            let result = try FrameCaptureService.captureFrame(params: decodedParams)
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

// bugs.spec.md #6, "structural fix" session: `handleRequest` used to run
// synchronously, inline, on this file's `readLine()` thread — the sidecar's
// only thread servicing JSON-RPC. Two call sites reachable from it
// (`EnumerationService.fetchShareableContent`, used by `enumerateTargets`
// AND `captureFrame`; `FrameCaptureService`'s `SCScreenshotManager.captureImage`
// bridge) can block for up to their configured timeout (8-10s) waiting on a
// `SCShareableContent`/`SCScreenshotManager` completion handler that, per
// field evidence, can itself hang far longer while an `SCStream` is
// concurrently live. A prior session bounded those waits so they fail
// instead of hanging forever, but as long as `handleRequest` ran inline here,
// even a BOUNDED 8-10s stall meant `readLine()` could not read (let alone
// service) any subsequent line for that whole window — e.g. a `stopCapture`
// the caller sends specifically to abort a wedged session would itself queue
// up behind the stalled call and be delayed by the same 8-10s, and the video
// truncates for the full stall duration regardless.
//
// Fix: `readLine()` keeps synchronously reading and framing lines (cheap,
// never blocks on anything but stdin itself), but each REQUEST's actual
// handling is dispatched onto `rpcQueue`, a concurrent background queue, so
// a stalled `captureFrame`/`enumerateTargets` call never prevents the next
// line from being read, parsed, and (for an independent request) serviced
// immediately. This is protocol-conformant, not a silent break of an
// assumed request/response ordering: `packages/core/src/protocol/
// sidecar-client.ts`'s `SidecarClient` already correlates every response to
// its request purely by JSON-RPC `id` in a `Map` (`handleResponse`), with no
// assumption that responses arrive in the order requests were sent — see
// contracts/sidecar-protocol.md, which does not document (and per that
// client's implementation, does not require) strict one-request-at-a-time
// semantics. `CaptureSessionManager.shared`'s session dictionary is already
// `NSLock`-protected (`CaptureService.swift`) specifically because SCStream's
// own delegate callbacks already arrive concurrently with the RPC thread
// today, so dispatching RPC handling concurrently introduces no new class of
// hazard there; `VideoAssetWriter`'s diagnostic counters gained their own
// lock in this same session for the same reason (see that file). `writeLine`
// was already serialized via `stdoutLock` for exactly this kind of
// multi-writer scenario (SCStream's `captureEnded` notification vs. this
// loop), so concurrent responses interleave safely on stdout.
let rpcQueue = DispatchQueue(
    label: "windower.rpc.dispatch", qos: .userInitiated, attributes: .concurrent)

/// Tracks requests dispatched to `rpcQueue` that haven't finished yet, so the
/// process doesn't exit (falling off the end of this file after stdin EOF)
/// while a response is still in flight and hasn't been written to stdout.
let inFlightRequests = DispatchGroup()

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
        // `id` and `method` are guaranteed non-nil by `classify`. Capture
        // them by value before dispatching — `parsedLine` itself is a local
        // that doesn't outlive this call, but its fields are simple value
        // types so this is just an ordinary async closure capture.
        let id = parsedLine.id!
        let method = parsedLine.method!
        let params = parsedLine.params
        inFlightRequests.enter()
        rpcQueue.async {
            handleRequest(id: id, method: method, params: params)
            inFlightRequests.leave()
        }
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
// This loop's ONLY job now is reading/framing lines and handing requests off
// to `rpcQueue` (see the doc comment above `rpcQueue`) — it must never itself
// call anything that can block on ScreenCaptureKit/AVFoundation completion
// handlers.
while let line = readLine(strippingNewline: true) {
    if line.isEmpty { continue }
    handle(line: line)
}

// stdin closed (EOF) — the daemon closes/kills the sidecar process itself
// per contracts/sidecar-protocol.md's lifecycle, but if that ever happens
// via stdin EOF while requests are still dispatched on `rpcQueue`, wait for
// them to finish (and write their responses) rather than letting the process
// fall off the end of this file mid-flight.
inFlightRequests.wait()

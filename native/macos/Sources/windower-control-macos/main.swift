import Foundation
import WindowerControlCore
import WindowerSidecarShared

// windower-control-macos — the CONTROL surface
// (contracts/sidecar-protocol.md §Method-ownership surfaces).
//
// Synthetic input (`performInput`) and window geometry (`resizeWindow`), plus
// the two always-available permission methods and `describe`. Nothing else.
//
// Phase 21's governing invariant is that exactly one process on the machine
// may hold ScreenCaptureKit state; this binary's contribution to that
// invariant is being structurally incapable of holding any. It depends only
// on `WindowerControlCore` (CGEvent + AXUIElement) and `WindowerSidecarShared`
// (wire types, permissions, display geometry) — neither imports
// ScreenCaptureKit, so the framework is not on this executable's link line at
// all. That is asserted mechanically by
// `scripts/check-no-screencapturekit.sh`, not by convention.
//
// Same newline-delimited JSON-RPC 2.0 framing as the capture binary, matching
// packages/core/src/protocol/jsonrpc.ts. stderr is free-form logs only, never
// protocol data.

let sidecarVersion = "0.1.0"

/// Capabilities this binary serves — and only these. Per
/// contracts/sidecar-protocol.md §Handshake, each implementation reports its
/// own capabilities and never the other surface's; a caller holding both a
/// capture and a control connection takes the union, and a caller holding only
/// one MUST NOT infer anything about the capabilities it did not see.
///
/// `input.*` needs the Accessibility grant and `window-control` needs it too
/// (`AXUIElement*`). They are advertised statically for the same reason every
/// other capability in this codebase is: `describe` is a one-shot handshake
/// with no mechanism to report a per-call outcome. The genuinely per-call
/// fact is reported truthfully by `getPermissions`, and each method returns
/// `PERMISSION_DENIED` when the grant is missing rather than being silently
/// absent from this list.
let supportedCapabilities: [String] = [
    "input.mouse",
    "input.keyboard",
    "window-control",
]

func logStderr(_ message: String) {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
}

/// This binary has no background stream delegates writing to stdout the way
/// the capture binary does, but responses are still produced concurrently on
/// `rpcQueue` (below), so every write is serialized for the same reason:
/// interleaved partial writes would corrupt the newline-delimited framing.
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

        case "getPermissions":
            // The control-relevant subset: `accessibility` only. This binary
            // can neither capture the screen nor open a microphone, so it has
            // no opinion on those kinds and omits them rather than guessing —
            // an absent kind means "unknown", never "denied"
            // (contracts/sidecar-protocol.md §Method-ownership surfaces).
            let report = PermissionsService.controlReport(sidecarVersion: sidecarVersion)
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

        case "performInput":
            // `sessionId` is a plain correlation hint here and is deliberately
            // never validated: the control surface owns no sessions and MUST
            // NOT return SESSION_NOT_FOUND (contracts/sidecar-protocol.md).
            let decodedParams = try decodeParams(PerformInputParams.self, from: params)
            let result = try InputSynthesisService.perform(params: decodedParams)
            resultValue = try JSONCodec.encode(result)

        case "resizeWindow":
            let decodedParams = try decodeParams(ResizeWindowParams.self, from: params)
            let result = try WindowControlService.resizeWindow(
                targetId: decodedParams.targetId, bounds: decodedParams.bounds)
            resultValue = try JSONCodec.encode(result)

        default:
            // Includes every capture-surface method. Answering
            // UNSUPPORTED_CAPABILITY is the protocol-correct response for a
            // method this implementation does not advertise in `describe`.
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

// Same concurrent-dispatch structure as the capture binary (see the long
// `rpcQueue` note in windower-capture-macos/main.swift for the full
// bugs.spec.md #6 reasoning). It matters here for a different but analogous
// reason: `performInput` blocks for the real duration of what it synthesizes —
// a `wait` action, a drag interpolated over its `durationMs`, a long
// `type_text` — and `resizeWindow`'s `AXUIElement` calls block on the target
// app's main run loop, which an unresponsive app can stall for seconds. If
// handling ran inline on the `readLine()` thread, an abort/second command sent
// specifically to interrupt a long input sequence would queue up behind it and
// arrive only after it finished, which is exactly the failure mode the caller
// was trying to escape. Out-of-order responses are explicitly permitted by
// contracts/sidecar-protocol.md §Transport and already handled by
// `SidecarClient`'s id-keyed pending-call map.
let rpcQueue = DispatchQueue(
    label: "windower.control.rpc.dispatch", qos: .userInitiated, attributes: .concurrent)

/// Tracks requests dispatched to `rpcQueue` that haven't finished yet, so the
/// process doesn't exit (falling off the end of this file after stdin EOF)
/// while a response is still in flight and hasn't been written to stdout.
let inFlightRequests = DispatchGroup()

func handle(line: String) {
    guard let data = line.data(using: .utf8) else {
        logStderr("windower-control-macos: received non-UTF8 line, ignoring")
        return
    }
    let parsedLine: JsonRpcLine
    do {
        parsedLine = try JSONDecoder().decode(JsonRpcLine.self, from: data)
    } catch {
        logStderr("windower-control-macos: failed to parse JSON-RPC line: \(error)")
        return
    }

    switch classify(parsedLine) {
    case .request:
        // `id` and `method` are guaranteed non-nil by `classify`.
        let id = parsedLine.id!
        let method = parsedLine.method!
        let params = parsedLine.params
        inFlightRequests.enter()
        rpcQueue.async {
            handleRequest(id: id, method: method, params: params)
            inFlightRequests.leave()
        }
    case .notification:
        logStderr(
            "windower-control-macos: ignoring unexpected notification: \(parsedLine.method ?? "?")")
    case .other:
        logStderr("windower-control-macos: ignoring line that is neither request nor notification")
    }
}

// Newline-delimited JSON-RPC 2.0 over stdio — contracts/sidecar-protocol.md
// §Transport. stdout carries protocol data ONLY; all logs go to stderr.
while let line = readLine(strippingNewline: true) {
    if line.isEmpty { continue }
    handle(line: line)
}

// stdin closed (EOF). The daemon owns this process's lifecycle, but if it goes
// away mid-flight, finish and flush anything already dispatched rather than
// dropping a response.
//
// contracts/screen-capture-exclusivity.md §Process ownership: the same
// ownership semantics the capture binary follows apply here — EOF (which is
// how a dead parent announces itself, since the OS closes the pipe) means
// exit. The control surface holds no capture state, no `SCStream` and no
// `AVAssetWriter`, so unlike `windower-capture-macos` there is nothing to
// finalize first: this is a plain exit, and it must stay one.
inFlightRequests.wait()

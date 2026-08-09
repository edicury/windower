import Foundation
import WindowerSidecarCore

// windower-sidecar-macos — Phase 2: enumeration & permissions.
//
// Real newline-delimited JSON-RPC 2.0 stdio loop matching the Phase 1
// envelope in packages/core/src/protocol/jsonrpc.ts exactly. stderr is
// free-form logs only, never protocol data (contracts/sidecar-protocol.md
// §Transport).

let sidecarVersion = "0.1.0"

/// Capabilities this backend actually implements at this phase. Window
/// control (Phase 3), capture.* (Phase 4/5), audio.* (Phase 5), and
/// eventTimeline.* (Phase 10) are deliberately NOT advertised yet — the
/// daemon gates on `describe().capabilities` before calling anything, per
/// CLAUDE.md "protocol before platform".
let supportedCapabilities: [String] = [
    "enumerate.displays",
    "enumerate.windows",
    "enumerate.apps",
]

func logStderr(_ message: String) {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
}

func writeLine(_ s: String) {
    FileHandle.standardOutput.write((s + "\n").data(using: .utf8)!)
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

        case "resizeWindow", "startCapture", "stopCapture", "cancelCapture":
            throw SidecarRpcError.unsupportedCapability(
                "\(method) is not implemented by this backend at this phase")

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

// Newline-delimited JSON-RPC 2.0 over stdio — contracts/sidecar-protocol.md
// §Transport. stdout carries protocol data ONLY; all logs go to stderr.
while let line = readLine(strippingNewline: true) {
    if line.isEmpty { continue }
    handle(line: line)
}

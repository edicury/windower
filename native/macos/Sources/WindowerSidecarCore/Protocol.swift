import Foundation

/// JSON-RPC 2.0 envelope types matching
/// `packages/core/src/protocol/jsonrpc.ts` exactly (field names, envelope
/// shape, error `data.code` taxonomy). This is the wire contract frozen in
/// `contracts/sidecar-protocol.md` — do not drift from those field names.

/// Permissive line shape used to classify an incoming line before routing
/// it, mirroring `JsonRpcLineSchema` in the TS package.
public struct JsonRpcLine: Codable {
    public let jsonrpc: String
    public let id: JSONValue?
    public let method: String?
    public let params: JSONValue?
    public let result: JSONValue?
    public let error: JSONValue?
}

/// Sidecar → daemon notification (`event`, `log`, `captureEnded`) — a
/// JSON-RPC 2.0 notification carries `method`/`params` and deliberately no
/// `id`, so the daemon knows no response is expected
/// (contracts/sidecar-protocol.md §Notifications).
public struct JsonRpcNotification: Encodable {
    public let jsonrpc: String = "2.0"
    public let method: String
    public let params: JSONValue

    public init(method: String, params: JSONValue) {
        self.method = method
        self.params = params
    }
}

public struct JsonRpcSuccessResponse: Encodable {
    public let jsonrpc: String = "2.0"
    public let id: JSONValue
    public let result: JSONValue

    public init(id: JSONValue, result: JSONValue) {
        self.id = id
        self.result = result
    }
}

/// Error taxonomy — see contracts/sidecar-protocol.md §Error taxonomy.
/// Values MUST match `SidecarErrorCodeSchema` in
/// packages/core/src/protocol/jsonrpc.ts exactly.
public enum SidecarErrorCode: String, Encodable, Equatable {
    case permissionDenied = "PERMISSION_DENIED"
    case targetNotFound = "TARGET_NOT_FOUND"
    case resizeUnsupported = "RESIZE_UNSUPPORTED"
    case captureFailed = "CAPTURE_FAILED"
    case unsupportedCapability = "UNSUPPORTED_CAPABILITY"
    case sessionNotFound = "SESSION_NOT_FOUND"
    case internalError = "INTERNAL_ERROR"
}

public struct JsonRpcErrorData: Encodable {
    public let code: SidecarErrorCode

    public init(code: SidecarErrorCode) {
        self.code = code
    }
}

public struct JsonRpcErrorObject: Encodable {
    public let code: Int
    public let message: String
    public let data: JsonRpcErrorData?

    public init(code: Int, message: String, data: JsonRpcErrorData?) {
        self.code = code
        self.message = message
        self.data = data
    }
}

public struct JsonRpcErrorResponse: Encodable {
    public let jsonrpc: String = "2.0"
    public let id: JSONValue
    public let error: JsonRpcErrorObject

    public init(id: JSONValue, error: JsonRpcErrorObject) {
        self.id = id
        self.error = error
    }
}

/// Thrown by method handlers; carries both the JSON-RPC numeric `code` and
/// the structured taxonomy `data.code` the daemon branches on.
public struct SidecarRpcError: Error {
    public let rpcCode: Int
    public let message: String
    public let taxonomyCode: SidecarErrorCode

    public init(rpcCode: Int, message: String, taxonomyCode: SidecarErrorCode) {
        self.rpcCode = rpcCode
        self.message = message
        self.taxonomyCode = taxonomyCode
    }

    /// -32601 "Method not found" is JSON-RPC's own convention for "this
    /// server doesn't implement that method" — a good fit for
    /// UNSUPPORTED_CAPABILITY, whether the method name is genuinely unknown
    /// or just not-yet-implemented at this backend/phase.
    public static func unsupportedCapability(_ message: String) -> SidecarRpcError {
        SidecarRpcError(rpcCode: -32601, message: message, taxonomyCode: .unsupportedCapability)
    }

    /// -32602 "Invalid params" per JSON-RPC convention.
    public static func invalidParams(_ message: String) -> SidecarRpcError {
        SidecarRpcError(rpcCode: -32602, message: message, taxonomyCode: .internalError)
    }

    /// -32000 is in JSON-RPC's reserved-for-implementation-defined-server-errors
    /// range (-32000 to -32099); used here for all other taxonomy codes.
    public static func serverError(_ message: String, code: SidecarErrorCode) -> SidecarRpcError {
        SidecarRpcError(rpcCode: -32000, message: message, taxonomyCode: code)
    }
}

/// Encodes a response envelope to a single compact JSON line (no embedded
/// newlines), matching the newline-delimited stdio framing in
/// contracts/sidecar-protocol.md §Transport.
public enum EnvelopeCodec {
    public static func encodeLine<T: Encodable>(_ value: T) -> String? {
        guard let data = try? JSONEncoder().encode(value),
            let string = String(data: data, encoding: .utf8)
        else {
            return nil
        }
        return string
    }
}

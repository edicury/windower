import XCTest

import WindowerSidecarCore

/// Pure encode/decode tests for the JSON-RPC 2.0 envelope types in
/// Protocol.swift / JSONValue.swift. No screen-capture permission or GUI
/// needed — these must run headlessly in CI.
final class EnvelopeTests: XCTestCase {
    func testDecodeRequestLine() throws {
        let json = """
            {"jsonrpc":"2.0","id":1,"method":"describe","params":{}}
            """
        let line = try JSONDecoder().decode(JsonRpcLine.self, from: Data(json.utf8))
        XCTAssertEqual(line.jsonrpc, "2.0")
        XCTAssertEqual(line.method, "describe")
        XCTAssertNotNil(line.id)
        XCTAssertNil(line.result)
        XCTAssertNil(line.error)
    }

    func testDecodeNotificationLineHasNoId() throws {
        let json = """
            {"jsonrpc":"2.0","method":"log","params":{"level":"info","message":"hi"}}
            """
        let line = try JSONDecoder().decode(JsonRpcLine.self, from: Data(json.utf8))
        XCTAssertNil(line.id)
        XCTAssertEqual(line.method, "log")
    }

    func testEncodeSuccessResponseRoundTrips() throws {
        let response = JsonRpcSuccessResponse(
            id: .number(1),
            result: .object(["ok": .bool(true)])
        )
        guard let line = EnvelopeCodec.encodeLine(response) else {
            return XCTFail("expected a non-nil encoded line")
        }
        // No embedded newlines — required by the newline-delimited framing.
        XCTAssertFalse(line.contains("\n"))

        let decoded = try JSONDecoder().decode(JsonRpcLine.self, from: Data(line.utf8))
        XCTAssertEqual(decoded.id, .number(1))
        XCTAssertNotNil(decoded.result)
        XCTAssertNil(decoded.error)
    }

    func testEncodeErrorResponseCarriesTaxonomyCode() throws {
        let response = JsonRpcErrorResponse(
            id: .number(2),
            error: JsonRpcErrorObject(
                code: -32601,
                message: "Unknown method: bogus",
                data: JsonRpcErrorData(code: .unsupportedCapability)
            )
        )
        guard let line = EnvelopeCodec.encodeLine(response) else {
            return XCTFail("expected a non-nil encoded line")
        }
        let decoded = try JSONDecoder().decode(JsonRpcLine.self, from: Data(line.utf8))

        // `error` decodes generically as a JSONValue object here (JsonRpcLine
        // is intentionally permissive — see Protocol.swift); pick apart the
        // nested `code` and `data.code` fields by hand.
        guard case .object(let errorObj)? = decoded.error else {
            return XCTFail("expected decoded.error to be a JSON object, got \(String(describing: decoded.error))")
        }
        XCTAssertEqual(errorObj["code"], .number(-32601))

        guard case .object(let dataObj)? = errorObj["data"] else {
            return XCTFail("expected error.data to be a JSON object")
        }
        XCTAssertEqual(dataObj["code"], .string("UNSUPPORTED_CAPABILITY"))
    }

    func testUnsupportedCapabilityErrorUsesJsonRpcMethodNotFoundCode() {
        let error = SidecarRpcError.unsupportedCapability("nope")
        XCTAssertEqual(error.rpcCode, -32601)
        XCTAssertEqual(error.taxonomyCode, .unsupportedCapability)
    }
}

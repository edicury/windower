import Foundation

// windower-sidecar-macos — Phase 0 scaffolding only.
//
// Proves the stdio plumbing between the TS daemon and a native per-OS
// sidecar: reads one line of JSON-RPC-ish input from stdin, and if it's a
// `describe` request, hand-writes a JSON-RPC-ish response to stdout.
//
// This is intentionally NOT the real contracts/sidecar-protocol.md contract
// (no framing, no JSON-RPC library, no other methods). That's Phase 1.

let version = "0.0.0"

func writeLine(_ s: String) {
    FileHandle.standardOutput.write((s + "\n").data(using: .utf8)!)
}

/// Extremely small, hand-rolled extraction of the top-level "id" and
/// "method" fields from a JSON-RPC-ish request line, without pulling in a
/// JSON library dependency yet (deliberately deferred to Phase 1).
func handle(line: String) {
    guard let data = line.data(using: .utf8),
        let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else {
        return
    }

    let id = obj["id"] ?? NSNull()
    let method = obj["method"] as? String

    switch method {
    case "describe":
        let result: [String: Any] = [
            "platform": "macos",
            "version": version,
            "capabilities": [],
        ]
        let response: [String: Any] = [
            "jsonrpc": "2.0",
            "id": id,
            "result": result,
        ]
        if let out = try? JSONSerialization.data(withJSONObject: response),
            let str = String(data: out, encoding: .utf8)
        {
            writeLine(str)
        }
    default:
        let response: [String: Any] = [
            "jsonrpc": "2.0",
            "id": id,
            "error": [
                "code": -32601,
                "message": "Method not found (Phase 0 sidecar only implements describe)",
            ],
        ]
        if let out = try? JSONSerialization.data(withJSONObject: response),
            let str = String(data: out, encoding: .utf8)
        {
            writeLine(str)
        }
    }
}

while let line = readLine(strippingNewline: true) {
    if line.isEmpty { continue }
    handle(line: line)
}

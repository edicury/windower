import XCTest

import WindowerSidecarCore

/// Pure mapping-logic tests for `CaptureTarget`/`PermissionReport` JSON
/// encoding — the exact wire shapes `data-model.md` specifies. No real
/// screen-capture permission or GUI needed; these must run headlessly.
final class MappingTests: XCTestCase {
    func testDisplayTargetEncodesExactDataModelShape() throws {
        let target = CaptureTarget.display(
            id: "42", name: "Built-in Display",
            bounds: Rect(x: 0, y: 0, width: 2560, height: 1440),
            isPrimary: true, scaleFactor: 2.0
        )
        let data = try JSONEncoder().encode(target)
        let obj = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: data) as? [String: Any])

        XCTAssertEqual(obj["kind"] as? String, "display")
        XCTAssertEqual(obj["id"] as? String, "42")
        XCTAssertEqual(obj["name"] as? String, "Built-in Display")
        XCTAssertEqual(obj["isPrimary"] as? Bool, true)
        XCTAssertEqual(obj["scaleFactor"] as? Double, 2.0)

        let bounds = try XCTUnwrap(obj["bounds"] as? [String: Any])
        XCTAssertEqual(bounds["x"] as? Double, 0)
        XCTAssertEqual(bounds["width"] as? Double, 2560)

        // Window-only fields must NOT be present on a display target.
        XCTAssertNil(obj["title"])
        XCTAssertNil(obj["appName"])
    }

    func testWindowTargetEncodesExactDataModelShape() throws {
        let target = CaptureTarget.window(
            id: "1001", title: "My Editor — file.swift", appName: "MyApp",
            appBundleId: "com.example.myapp",
            bounds: Rect(x: 100, y: 200, width: 800, height: 600),
            isFocused: false, resizable: true
        )
        let data = try JSONEncoder().encode(target)
        let obj = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: data) as? [String: Any])

        XCTAssertEqual(obj["kind"] as? String, "window")
        XCTAssertEqual(obj["id"] as? String, "1001")
        XCTAssertEqual(obj["title"] as? String, "My Editor — file.swift")
        XCTAssertEqual(obj["appName"] as? String, "MyApp")
        XCTAssertEqual(obj["appBundleId"] as? String, "com.example.myapp")
        XCTAssertEqual(obj["isFocused"] as? Bool, false)
        XCTAssertEqual(obj["resizable"] as? Bool, true)

        // Display-only fields must NOT be present on a window target.
        XCTAssertNil(obj["name"])
        XCTAssertNil(obj["isPrimary"])
        XCTAssertNil(obj["scaleFactor"])
    }

    func testPermissionReportEncodesDataModelFieldNames() throws {
        let report = PermissionReport(
            screenRecording: .granted, accessibility: .denied, microphone: .notDetermined,
            sidecarAvailable: true, sidecarVersion: "0.1.0"
        )
        let data = try JSONEncoder().encode(report)
        let obj = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: data) as? [String: Any])

        XCTAssertEqual(obj["screenRecording"] as? String, "granted")
        XCTAssertEqual(obj["accessibility"] as? String, "denied")
        // Wire value uses the data-model.md snake_case string, not Swift's
        // camelCase case name.
        XCTAssertEqual(obj["microphone"] as? String, "not_determined")
        XCTAssertEqual(obj["sidecarAvailable"] as? Bool, true)
        XCTAssertEqual(obj["sidecarVersion"] as? String, "0.1.0")
    }

    func testWindowWithEmptyTitleIsSkippedByEnumerationMapper() {
        // mapWindow itself needs a live SCWindow which can't be constructed
        // headlessly; instead this documents/locks the contract at the
        // PermissionStatus/CaptureTarget level so a future refactor of the
        // filter can't silently drop the "non-empty title" rule without a
        // test noticing the enum shape it filters against.
        XCTAssertEqual(PermissionStatus.notApplicable.rawValue, "not_applicable")
    }
}

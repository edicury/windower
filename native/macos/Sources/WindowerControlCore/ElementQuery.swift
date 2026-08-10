import ApplicationServices
import AppKit
import CoreGraphics
import Foundation
import WindowerSidecarShared

// Phase 22 — Operator: AX-first observation (`enumerateElements`).
//
// Imports ONLY ApplicationServices (plus AppKit/CoreGraphics/Foundation,
// none of which pull in ScreenCaptureKit) — this file must never gain a
// ScreenCaptureKit dependency, direct or transitive. That is enforced
// mechanically by scripts/check-no-screencapturekit.sh, not by convention;
// see the long comment at the top of Package.swift for the invariant this
// protects.
//
// `enumerateElements` is a sensor, never an actuator: it reads
// `kAXChildrenAttribute`/role/name/geometry and never calls
// `AXUIElementPerformAction` (no `AXPress`, no `AXSetValue`). See
// tasks/phase-22-operator-ax-first.md's "settled decisions" §1 — clicking
// still goes through `InputSynthesisService.perform` at the rect this file
// hands back, so a recording shows real cursor travel and real keystrokes.

// MARK: - Wire shapes (mirror contracts/sidecar-protocol.md / data-model.md §UIElement)

/// Decodable view of `CaptureTargetSchema`'s discriminated union, scoped to
/// what `enumerateElements` needs to resolve an AX window. Mirrors
/// `CaptureTargetInput` in WindowerCaptureCore/CaptureService.swift, which
/// documents why a *decoding* view is a separate, more permissive type from
/// the Encodable-only `CaptureTarget` enum in CaptureTarget.swift (that enum
/// is shaped for `enumerateTargets`' output, not for decoding arbitrary
/// input) — the control surface needs its own copy because it cannot import
/// WindowerCaptureCore (that would pull in ScreenCaptureKit transitively).
public struct ElementQueryTargetInput: Decodable, Equatable {
    public let kind: String
    public let id: String?

    public init(kind: String, id: String? = nil) {
        self.kind = kind
        self.id = id
    }
}

public struct EnumerateElementsParams: Decodable {
    public let target: ElementQueryTargetInput
    public let refs: [String]?
    public let filter: String?
    public let maxDepth: Int?
    public let maxElements: Int?

    public init(
        target: ElementQueryTargetInput, refs: [String]? = nil, filter: String? = nil,
        maxDepth: Int? = nil, maxElements: Int? = nil
    ) {
        self.target = target
        self.refs = refs
        self.filter = filter
        self.maxDepth = maxDepth
        self.maxElements = maxElements
    }
}

/// Mirrors `UIElement` in data-model.md exactly. `bounds` is **pixels**,
/// global top-left-origin Quartz space — the same space `InputAction`
/// coordinates use, so a caller feeds this rect's center straight into
/// `performInput` with no conversion (CLAUDE.md's units rule).
public struct UIElementWire: Encodable, Equatable {
    public let ref: String
    public let role: String
    public let subrole: String?
    public let label: String?
    public let value: String?
    public let bounds: Rect
    public let enabled: Bool
    public let focused: Bool?
    public let actions: [String]?
    public let parentRef: String?

    public init(
        ref: String, role: String, subrole: String? = nil, label: String? = nil,
        value: String? = nil, bounds: Rect, enabled: Bool, focused: Bool? = nil,
        actions: [String]? = nil, parentRef: String? = nil
    ) {
        self.ref = ref
        self.role = role
        self.subrole = subrole
        self.label = label
        self.value = value
        self.bounds = bounds
        self.enabled = enabled
        self.focused = focused
        self.actions = actions
        self.parentRef = parentRef
    }
}

public struct EnumerateElementsResult: Encodable, Equatable {
    public let elements: [UIElementWire]
    public let generation: String
    public let truncated: Bool

    public init(elements: [UIElementWire], generation: String, truncated: Bool) {
        self.elements = elements
        self.generation = generation
        self.truncated = truncated
    }
}

// MARK: - Ref generation store

/// Backs `ref`/`generation`/`AX_ELEMENT_STALE` (contracts/sidecar-protocol.md
/// §Element enumeration). Each full walk mints a `generation` token and
/// retains the walked `AXUIElement` handles, index-addressable, so a later
/// `refs` request can re-read exactly those elements without a second walk.
/// At most the two most recent generations are retained — a long-running
/// operator loop must not accumulate handles across dozens of steps.
public final class ElementGenerationStore {
    public static let shared = ElementGenerationStore()

    private let lock = NSLock()
    /// Oldest first. Capped at `maxRetainedGenerations`.
    private var generations: [(id: String, elements: [AXUIElement])] = []

    public static let maxRetainedGenerations = 2

    public init() {}

    /// Test-only: reset between tests so generation lookups in one test
    /// can't accidentally resolve against state a previous test left behind.
    public func reset() {
        lock.lock()
        generations.removeAll()
        lock.unlock()
    }

    public func newGeneration(elements: [AXUIElement]) -> String {
        let id = UUID().uuidString
        lock.lock()
        generations.append((id, elements))
        if generations.count > Self.maxRetainedGenerations {
            generations.removeFirst(generations.count - Self.maxRetainedGenerations)
        }
        lock.unlock()
        return id
    }

    public func element(generation: String, index: Int) -> AXUIElement? {
        lock.lock()
        defer { lock.unlock() }
        guard let entry = generations.first(where: { $0.id == generation }) else { return nil }
        guard index >= 0, index < entry.elements.count else { return nil }
        return entry.elements[index]
    }

    /// Test-only accessor: number of generations currently retained.
    public var retainedGenerationCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return generations.count
    }
}

// MARK: - Service

public enum ElementQueryService {
    public static let defaultMaxDepth = 12
    public static let defaultMaxElements = 200
    public static let hardCapMaxElements = 500

    /// Safety valve on total AX nodes *visited* (not just kept) during a
    /// filtered walk — a web view or Electron chrome can hand back
    /// thousands of `AXStaticText`/`AXGroup` nodes that the "interactable"
    /// filter drops, and without this the walk would still pay the AX IPC
    /// cost of visiting every one of them before naturally finishing.
    public static let maxVisitedNodes = 4000

    public static func enumerateElements(
        params: EnumerateElementsParams,
        accessibility: PermissionStatus = PermissionsService.accessibilityStatus(),
        displays: [DisplayGeometry] = InputCoordinateSpace.activeDisplays(),
        store: ElementGenerationStore = .shared
    ) throws -> EnumerateElementsResult {
        // Same fail-fast shape as InputSynthesisService.perform
        // (InputSynthesis.swift:387-399): PERMISSION_DENIED before any AX
        // call, not a generic failure once one fails.
        guard accessibility == .granted else {
            throw SidecarRpcError.serverError(
                "enumerateElements requires the Accessibility permission (AXUIElementCopyAttributeValue is blocked without it)",
                code: .permissionDenied)
        }

        if let refs = params.refs, !refs.isEmpty {
            return try resolveRefs(refs, displays: displays, store: store)
        }

        guard params.target.kind == "window" else {
            throw SidecarRpcError.serverError(
                "enumerateElements requires a window target (kind '\(params.target.kind)' has no AX tree of its own)",
                code: .targetNotFound)
        }
        guard let id = params.target.id, let windowIDValue = UInt32(id) else {
            throw SidecarRpcError.serverError(
                "target.id is missing or not a valid window id", code: .targetNotFound)
        }
        let windowID = CGWindowID(windowIDValue)

        let snapshot = try WindowControlService.lookupCGWindowSnapshot(windowID: windowID)
        let axWindow = try WindowControlService.findAXWindow(pid: snapshot.pid, matching: snapshot)

        let requestedMaxDepth = params.maxDepth ?? defaultMaxDepth
        let maxDepth = max(0, requestedMaxDepth)
        let requestedMaxElements = params.maxElements ?? defaultMaxElements
        let maxElements = min(max(0, requestedMaxElements), hardCapMaxElements)
        let filterMode = params.filter ?? "interactable"

        let (walked, truncated) = breadthFirstWalk(
            root: axWindow, maxDepth: maxDepth, maxElements: maxElements, filterMode: filterMode,
            children: axChildren, info: readElementInfo)

        let generation = store.newGeneration(elements: walked.map { $0.handle })

        let elements = walked.enumerated().map { index, node -> UIElementWire in
            wireElement(
                for: node.info, ref: "\(generation):\(index)", displays: displays,
                parentRef: node.parentIndex.map { "\(generation):\($0)" })
        }

        return EnumerateElementsResult(elements: elements, generation: generation, truncated: truncated)
    }

    // MARK: - `refs` freshness path

    private static func resolveRefs(
        _ refs: [String], displays: [DisplayGeometry], store: ElementGenerationStore
    ) throws -> EnumerateElementsResult {
        var elements: [UIElementWire] = []
        var generationToken: String?
        for ref in refs {
            let parts = ref.split(separator: ":", maxSplits: 1)
            guard parts.count == 2, let index = Int(parts[1]) else {
                throw SidecarRpcError.serverError(
                    "ref '\(ref)' is not a valid <generation>:<index> ref", code: .axElementStale)
            }
            let generation = String(parts[0])
            guard let handle = store.element(generation: generation, index: index) else {
                throw SidecarRpcError.serverError(
                    "ref '\(ref)' does not resolve to a live element (stale generation)",
                    code: .axElementStale)
            }
            guard let info = readElementInfo(handle) else {
                throw SidecarRpcError.serverError(
                    "ref '\(ref)' no longer resolves to a live element", code: .axElementStale)
            }
            generationToken = generation
            elements.append(
                wireElement(for: info, ref: ref, displays: displays, parentRef: nil))
        }
        // refs is documented non-empty here (caller checked above), so
        // generationToken is always set by the loop above.
        return EnumerateElementsResult(
            elements: elements, generation: generationToken ?? "", truncated: false)
    }

    // MARK: - Breadth-first walk

    struct ElementInfo {
        let role: String
        let nativeRole: String
        let subrole: String?
        let label: String?
        let value: String?
        let positionPoints: CGPoint?
        let sizePoints: CGSize?
        let enabled: Bool
        let focused: Bool?
        let actions: [String]
    }

    struct WalkedElement<Node> {
        let handle: Node
        let info: ElementInfo
        /// Index into the *results* array (not the raw queue) of the
        /// nearest kept ancestor, if any. Flat-list-plus-parent-pointer,
        /// per data-model.md §UIElement — an unkept intermediate ancestor
        /// (filtered out by "interactable") is skipped over, not linked to.
        let parentIndex: Int?
    }

    private struct QueueItem<Node> {
        let element: Node
        let depth: Int
        let ancestorIndex: Int?
    }

    /// Breadth-first (not depth-first) so a walk truncated by `maxElements`
    /// keeps the shallow, usually-more-actionable elements rather than
    /// exhausting the budget on one deeply nested branch.
    ///
    /// Generic over `Node` — in production `Node == AXUIElement` and
    /// `children`/`info` are `axChildren`/`readElementInfo` (see
    /// `enumerateElements` below), but genericizing lets
    /// `WindowerControlCoreTests` exercise maxDepth/maxElements truncation
    /// and BFS ordering against a synthetic in-memory tree, with no real
    /// `AXUIElement`/TCC grant involved — the same "pure logic, headlessly
    /// testable" split `WindowControlService.bestMatchIndex` already uses.
    static func breadthFirstWalk<Node>(
        root: Node, maxDepth: Int, maxElements: Int, filterMode: String,
        children: (Node) -> [Node], info infoOf: (Node) -> ElementInfo?
    ) -> (elements: [WalkedElement<Node>], truncated: Bool) {
        var results: [WalkedElement<Node>] = []
        var truncated = false
        var visited = 0

        var queue: [QueueItem<Node>] = [QueueItem(element: root, depth: 0, ancestorIndex: nil)]
        var head = 0

        while head < queue.count {
            let item = queue[head]
            head += 1
            visited += 1
            if visited > maxVisitedNodes {
                truncated = true
                break
            }

            var ancestorIndexForChildren = item.ancestorIndex
            // depth 0 is the resolved AX window itself — never emitted as
            // an element, only its descendants are.
            if item.depth > 0, let info = infoOf(item.element) {
                let keep = filterMode == "all" || isInteractable(info)
                if keep {
                    if results.count >= maxElements {
                        truncated = true
                        break
                    }
                    results.append(
                        WalkedElement(handle: item.element, info: info, parentIndex: item.ancestorIndex))
                    ancestorIndexForChildren = results.count - 1
                }
            }

            let nodeChildren = children(item.element)
            guard item.depth < maxDepth else {
                if !nodeChildren.isEmpty { truncated = true }
                continue
            }

            for child in nodeChildren {
                queue.append(
                    QueueItem(element: child, depth: item.depth + 1, ancestorIndex: ancestorIndexForChildren))
            }
        }

        if head < queue.count { truncated = true }
        return (results, truncated)
    }

    // MARK: - Filter

    /// "interactable" (the default) keeps elements that are either
    /// actionable — a non-empty `AXActions` list, or a role this backend
    /// considers interactable — or carry a non-empty accessible name.
    /// Purely-decorative groups, splitters, and unlabeled static text fall
    /// out (contracts/sidecar-protocol.md §Element enumeration).
    static func isInteractable(_ info: ElementInfo) -> Bool {
        if !info.actions.isEmpty { return true }
        if interactableRoles.contains(info.role) { return true }
        if let label = info.label, !label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return true
        }
        return false
    }

    static let interactableRoles: Set<String> = [
        "button", "textfield", "link", "menuitem", "checkbox", "radio", "combobox", "tab",
        "slider", "switch", "menu", "row", "stepper", "disclosuretriangle",
    ]

    // MARK: - Role normalization

    /// `AXRole` (native) → Windower's normalized cross-platform vocabulary.
    /// Below the stdio line, per CLAUDE.md — no TS code ever sees a raw
    /// `AXRole` string. Unmapped roles pass through as `"other"` with the
    /// native role recorded in `subrole`, so nothing is silently dropped.
    static let roleMap: [String: String] = [
        "AXButton": "button",
        "AXPopUpButton": "button",
        "AXMenuButton": "button",
        "AXCheckBox": "checkbox",
        "AXRadioButton": "radio",
        "AXTextField": "textfield",
        "AXTextArea": "textfield",
        "AXComboBox": "combobox",
        "AXLink": "link",
        "AXMenuItem": "menuitem",
        "AXMenu": "menu",
        "AXMenuBar": "menubar",
        "AXMenuBarItem": "menuitem",
        "AXRow": "row",
        "AXCell": "cell",
        "AXColumn": "column",
        "AXTable": "table",
        "AXOutline": "list",
        "AXOutlineRow": "row",
        "AXList": "list",
        "AXTabGroup": "tablist",
        "AXTab": "tab",
        "AXImage": "image",
        "AXStaticText": "text",
        "AXGroup": "group",
        "AXScrollArea": "group",
        "AXScrollBar": "scrollbar",
        "AXToolbar": "toolbar",
        "AXSlider": "slider",
        "AXIncrementor": "stepper",
        "AXDisclosureTriangle": "disclosuretriangle",
        "AXWindow": "window",
        "AXSheet": "sheet",
        "AXHeading": "heading",
        "AXWebArea": "webarea",
        "AXApplication": "application",
        "AXToolbarButton": "button",
    ]

    static func normalizedRole(for nativeRole: String) -> String {
        roleMap[nativeRole] ?? "other"
    }

    /// Mapped roles: `subrole` carries the native `AXSubrole` refinement,
    /// when present (e.g. macOS "AXSearchField" on an `AXTextField`).
    /// Unmapped roles: `subrole` carries the native role itself, per
    /// data-model.md §UIElement's "unmapped native role surfaces as role
    /// 'other' with the native role here" — pulled out as a pure function
    /// (no AX call) so it's directly testable without a live element.
    static func subroleValue(normalizedRole: String, nativeRole: String, nativeSubrole: String?)
        -> String?
    {
        if normalizedRole == "other" { return nativeRole }
        return nativeSubrole?.isEmpty == false ? nativeSubrole : nil
    }

    // MARK: - Element info extraction (pure AX attribute reads)

    static func readElementInfo(_ element: AXUIElement) -> ElementInfo? {
        guard let nativeRole = axStringAttribute(element, kAXRoleAttribute) else { return nil }
        let normalizedRoleValue = normalizedRole(for: nativeRole)
        let nativeSubrole = axStringAttribute(element, kAXSubroleAttribute)
        let subrole = subroleValue(
            normalizedRole: normalizedRoleValue, nativeRole: nativeRole, nativeSubrole: nativeSubrole)

        let title = axStringAttribute(element, kAXTitleAttribute)
        let description = axStringAttribute(element, kAXDescriptionAttribute)
        let label: String? =
            (title?.isEmpty == false ? title : nil) ?? (description?.isEmpty == false ? description : nil)

        let value = axValueDescription(element)
        let enabled = axBoolAttribute(element, kAXEnabledAttribute) ?? true
        let focused = axBoolAttribute(element, kAXFocusedAttribute)
        let actions = axActionNames(element)

        var position: CGPoint?
        var size: CGSize?
        var posValue: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &posValue) == .success,
            let posValue
        {
            var point = CGPoint.zero
            if AXValueGetValue((posValue as! AXValue), .cgPoint, &point) { position = point }
        }
        var sizeValue: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeValue) == .success,
            let sizeValue
        {
            var s = CGSize.zero
            if AXValueGetValue((sizeValue as! AXValue), .cgSize, &s) { size = s }
        }

        return ElementInfo(
            role: normalizedRoleValue, nativeRole: nativeRole, subrole: subrole, label: label,
            value: value, positionPoints: position, sizePoints: size, enabled: enabled,
            focused: focused, actions: actions)
    }

    /// Value length is capped rather than left unbounded — a text area's
    /// `AXValue` can be an entire document, and this observation is meant
    /// to be a few KB, not a second copy of the document (per this phase's
    /// "compact element list" goal).
    static let maxValueLength = 500

    static func axValueDescription(_ element: AXUIElement) -> String? {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &raw) == .success,
            let raw
        else { return nil }
        let description: String?
        switch raw {
        case let s as String:
            description = s
        case let n as NSNumber:
            description = n.stringValue
        default:
            description = nil
        }
        guard let description, !description.isEmpty else { return nil }
        if description.count > maxValueLength {
            return String(description.prefix(maxValueLength))
        }
        return description
    }

    static func axStringAttribute(_ element: AXUIElement, _ attribute: String) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success
        else { return nil }
        return value as? String
    }

    static func axBoolAttribute(_ element: AXUIElement, _ attribute: String) -> Bool? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
            let number = value as? NSNumber
        else { return nil }
        return number.boolValue
    }

    static func axActionNames(_ element: AXUIElement) -> [String] {
        var namesRef: CFArray?
        guard AXUIElementCopyActionNames(element, &namesRef) == .success,
            let names = namesRef as? [String]
        else { return [] }
        return names
    }

    static func axChildren(_ element: AXUIElement) -> [AXUIElement] {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value) == .success,
            let children = value as? [AXUIElement]
        else { return [] }
        return children
    }

    static func axChildCount(_ element: AXUIElement) -> Int {
        axChildren(element).count
    }

    // MARK: - Wire assembly (points → pixels)

    /// Converts an element's AX geometry (points) to the protocol's pixel
    /// space using the SAME per-display scale math `InputCoordinateSpace`
    /// already implements for `performInput` (InputSynthesis.swift:266-339)
    /// — reused here, not re-derived, per this phase's task file and
    /// CLAUDE.md's units rule.
    static func wireElement(
        for info: ElementInfo, ref: String, displays: [DisplayGeometry], parentRef: String?
    ) -> UIElementWire {
        let positionPoints = info.positionPoints ?? .zero
        let sizePoints = info.sizePoints ?? .zero
        let pointsRect = Rect(
            x: positionPoints.x, y: positionPoints.y, width: sizePoints.width,
            height: sizePoints.height)
        let scaleFactor = displayScaleFactor(forPointPosition: positionPoints, displays: displays)
        let pixelsRect = WindowControlService.pointsToPixels(pointsRect, scaleFactor: scaleFactor)

        return UIElementWire(
            ref: ref, role: info.role, subrole: info.subrole, label: info.label, value: info.value,
            bounds: pixelsRect, enabled: info.enabled, focused: info.focused,
            actions: info.actions.isEmpty ? nil : info.actions, parentRef: parentRef)
    }

    /// Finds the scale factor of the display whose **points** bounds
    /// contain `position`, by inverting each `DisplayGeometry`'s pixel
    /// bounds (`InputCoordinateSpace.activeDisplays()` already reports
    /// pixels = points × scaleFactor, no axis flip — see that function's
    /// doc comment) rather than re-deriving display geometry from scratch.
    /// Falls back to the first known display's scale, then to `1.0`, if no
    /// display contains the point (e.g. a window straddling a boundary by a
    /// point or two due to independent-query skew).
    static func displayScaleFactor(forPointPosition position: CGPoint, displays: [DisplayGeometry])
        -> Double
    {
        for display in displays {
            let scale = display.scaleFactor == 0 ? 1 : display.scaleFactor
            let pointsBounds = WindowControlService.pixelsToPoints(display.bounds, scaleFactor: scale)
            if position.x >= pointsBounds.x, position.x < pointsBounds.x + pointsBounds.width,
                position.y >= pointsBounds.y, position.y < pointsBounds.y + pointsBounds.height
            {
                return scale
            }
        }
        return displays.first?.scaleFactor ?? 1.0
    }
}

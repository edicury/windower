import CoreGraphics
import XCTest

@testable import WindowerControlCore
import WindowerSidecarShared

/// Phase 22 (Operator: AX-first observation) — pure-logic tests for
/// `enumerateElements`'s supporting machinery: role normalization, the
/// "interactable" filter, points→pixels conversion on a scale-2 display,
/// BFS truncation semantics, and ref-generation staleness.
///
/// None of this exercises a live `AXUIElementCopyAttributeValue` call —
/// that needs a real window and the Accessibility TCC grant, which can't be
/// granted non-interactively on a CI runner (CLAUDE.md's "TCC permissions
/// gate CI" note), so it's e2e-gated exactly like `WindowControlTests`'
/// live-resize gap. `breadthFirstWalk` is generic over its node type
/// specifically so its truncation/ordering logic can be driven by a
/// synthetic in-memory tree here, with real `AXUIElement`/`readElementInfo`
/// substituted only at the `enumerateElements` call site.
final class ElementQueryTests: XCTestCase {

    // MARK: - Test fixtures

    private func makeInfo(
        role: String = "button", nativeRole: String = "AXButton", subrole: String? = nil,
        label: String? = nil, value: String? = nil, actions: [String] = ["AXPress"],
        enabled: Bool = true, focused: Bool? = nil,
        position: CGPoint = .zero, size: CGSize = CGSize(width: 10, height: 10)
    ) -> ElementQueryService.ElementInfo {
        ElementQueryService.ElementInfo(
            role: role, nativeRole: nativeRole, subrole: subrole, label: label, value: value,
            positionPoints: position, sizePoints: size, enabled: enabled, focused: focused,
            actions: actions)
    }

    // MARK: - Role normalization

    func testNormalizesCommonAXRoles() {
        XCTAssertEqual(ElementQueryService.normalizedRole(for: "AXButton"), "button")
        XCTAssertEqual(ElementQueryService.normalizedRole(for: "AXTextField"), "textfield")
        XCTAssertEqual(ElementQueryService.normalizedRole(for: "AXTextArea"), "textfield")
        XCTAssertEqual(ElementQueryService.normalizedRole(for: "AXLink"), "link")
        XCTAssertEqual(ElementQueryService.normalizedRole(for: "AXMenuItem"), "menuitem")
        XCTAssertEqual(ElementQueryService.normalizedRole(for: "AXRow"), "row")
        XCTAssertEqual(ElementQueryService.normalizedRole(for: "AXCheckBox"), "checkbox")
    }

    func testUnmappedRoleFallsBackToOther() {
        XCTAssertEqual(ElementQueryService.normalizedRole(for: "AXSomeFutureWidgetKind"), "other")
    }

    func testUnmappedRoleCarriesNativeRoleInSubrole() {
        let subrole = ElementQueryService.subroleValue(
            normalizedRole: "other", nativeRole: "AXSomeFutureWidgetKind", nativeSubrole: nil)
        XCTAssertEqual(subrole, "AXSomeFutureWidgetKind")
    }

    func testMappedRoleUsesNativeSubroleWhenPresent() {
        let subrole = ElementQueryService.subroleValue(
            normalizedRole: "textfield", nativeRole: "AXTextField", nativeSubrole: "AXSearchField")
        XCTAssertEqual(subrole, "AXSearchField")
    }

    func testMappedRoleOmitsSubroleWhenNativeSubroleIsAbsentOrEmpty() {
        XCTAssertNil(
            ElementQueryService.subroleValue(
                normalizedRole: "button", nativeRole: "AXButton", nativeSubrole: nil))
        XCTAssertNil(
            ElementQueryService.subroleValue(
                normalizedRole: "button", nativeRole: "AXButton", nativeSubrole: ""))
    }

    // MARK: - Interactable filter

    func testInteractableKeepsElementWithActions() {
        let info = makeInfo(role: "group", label: nil, actions: ["AXPress"])
        XCTAssertTrue(ElementQueryService.isInteractable(info))
    }

    func testInteractableKeepsElementWithInteractableRoleEvenWithoutActionsOrLabel() {
        let info = makeInfo(role: "textfield", label: nil, actions: [])
        XCTAssertTrue(ElementQueryService.isInteractable(info))
    }

    func testInteractableKeepsElementWithNonEmptyLabel() {
        let info = makeInfo(role: "group", label: "Create Incident", actions: [])
        XCTAssertTrue(ElementQueryService.isInteractable(info))
    }

    func testInteractableDropsDecorativeGroupWithNoActionsRoleOrLabel() {
        let info = makeInfo(role: "group", label: nil, actions: [])
        XCTAssertFalse(ElementQueryService.isInteractable(info))
    }

    func testInteractableDropsWhitespaceOnlyLabel() {
        let info = makeInfo(role: "group", label: "   ", actions: [])
        XCTAssertFalse(ElementQueryService.isInteractable(info))
    }

    func testInteractableDropsStaticTextWithNoLabel() {
        let info = makeInfo(role: "text", nativeRole: "AXStaticText", label: nil, actions: [])
        XCTAssertFalse(ElementQueryService.isInteractable(info))
    }

    // MARK: - Points -> pixels conversion on a scale-2 display

    func testDisplayScaleFactorSelectsContainingDisplayScale2() {
        // A 2560x1440 px display at scale 2 is 1280x720 points, top-left
        // origin — same convention InputSynthesisTests' DisplayGeometry
        // fixtures use.
        let scale2Display = DisplayGeometry(
            bounds: Rect(x: 0, y: 0, width: 2560, height: 1440), scaleFactor: 2.0)
        let pointInsideDisplay = CGPoint(x: 200, y: 100)  // within 1280x720 points
        let scale = ElementQueryService.displayScaleFactor(
            forPointPosition: pointInsideDisplay, displays: [scale2Display])
        XCTAssertEqual(scale, 2.0)
    }

    func testElementBoundsConvertPointsToPixelsOnScale2Display() {
        let scale2Display = DisplayGeometry(
            bounds: Rect(x: 0, y: 0, width: 2560, height: 1440), scaleFactor: 2.0)
        let info = makeInfo(position: CGPoint(x: 100, y: 50), size: CGSize(width: 120, height: 40))
        let wire = ElementQueryService.wireElement(
            for: info, ref: "gen1:0", displays: [scale2Display], parentRef: nil)
        XCTAssertEqual(wire.bounds, Rect(x: 200, y: 100, width: 240, height: 80))
    }

    func testDisplayScaleFactorFallsBackToFirstDisplayWhenPointOutsideAllDisplays() {
        let display = DisplayGeometry(
            bounds: Rect(x: 0, y: 0, width: 1000, height: 1000), scaleFactor: 1.5)
        let farAwayPoint = CGPoint(x: 100_000, y: 100_000)
        let scale = ElementQueryService.displayScaleFactor(
            forPointPosition: farAwayPoint, displays: [display])
        XCTAssertEqual(scale, 1.5)
    }

    func testDisplayScaleFactorDefaultsToOneWithNoKnownDisplays() {
        let scale = ElementQueryService.displayScaleFactor(
            forPointPosition: CGPoint(x: 1, y: 1), displays: [])
        XCTAssertEqual(scale, 1.0)
    }

    // MARK: - Synthetic-tree BFS: maxDepth / maxElements truncation

    /// Minimal in-memory tree node so `breadthFirstWalk`'s generic BFS core
    /// can run with no `AXUIElement` at all. `id` doubles as a label so
    /// assertions can check *which* nodes were kept.
    private final class TreeNode {
        let id: String
        var children: [TreeNode] = []
        let keep: Bool  // whether this node should pass the "interactable" filter

        init(_ id: String, keep: Bool = true) {
            self.id = id
            self.keep = keep
        }
    }

    private func infoFor(_ node: TreeNode) -> ElementQueryService.ElementInfo {
        makeInfo(
            role: node.keep ? "button" : "group", label: nil,
            actions: node.keep ? ["AXPress"] : [])
    }

    func testBreadthFirstWalkVisitsShallowNodesBeforeDeepOnesWhenTruncated() {
        // root -> a, b (depth 1); a -> a1 (depth 2); b -> b1 (depth 2).
        let root = TreeNode("root")
        let a = TreeNode("a")
        let b = TreeNode("b")
        let a1 = TreeNode("a1")
        let b1 = TreeNode("b1")
        root.children = [a, b]
        a.children = [a1]
        b.children = [b1]

        let (elements, truncated) = ElementQueryService.breadthFirstWalk(
            root: root, maxDepth: 10, maxElements: 2, filterMode: "all",
            children: { $0.children }, info: infoFor)

        XCTAssertTrue(truncated)
        // BFS order: both depth-1 siblings (a, b) are captured by
        // maxElements=2 before either depth-2 child is visited — a
        // depth-first walk would instead capture a and a1 (or b and b1).
        XCTAssertEqual(elements.count, 2)
    }

    func testBreadthFirstWalkSetsTruncatedWhenMaxElementsCutsResults() {
        let root = TreeNode("root")
        root.children = (0..<5).map { TreeNode("child\($0)") }

        let (elements, truncated) = ElementQueryService.breadthFirstWalk(
            root: root, maxDepth: 10, maxElements: 3, filterMode: "all",
            children: { $0.children }, info: infoFor)

        XCTAssertEqual(elements.count, 3)
        XCTAssertTrue(truncated)
    }

    func testBreadthFirstWalkNotTruncatedWhenEverythingFits() {
        let root = TreeNode("root")
        root.children = (0..<3).map { TreeNode("child\($0)") }

        let (elements, truncated) = ElementQueryService.breadthFirstWalk(
            root: root, maxDepth: 10, maxElements: 100, filterMode: "all",
            children: { $0.children }, info: infoFor)

        XCTAssertEqual(elements.count, 3)
        XCTAssertFalse(truncated)
    }

    func testBreadthFirstWalkSetsTruncatedWhenMaxDepthCutsADeeperSubtree() {
        let root = TreeNode("root")
        let child = TreeNode("child")
        let grandchild = TreeNode("grandchild")
        root.children = [child]
        child.children = [grandchild]

        // maxDepth: 1 means only depth-1 nodes ("child") are visited/kept;
        // "grandchild" at depth 2 is beyond the bound.
        let (elements, truncated) = ElementQueryService.breadthFirstWalk(
            root: root, maxDepth: 1, maxElements: 100, filterMode: "all",
            children: { $0.children }, info: infoFor)

        XCTAssertEqual(elements.count, 1)
        XCTAssertTrue(truncated)
    }

    func testBreadthFirstWalkNotTruncatedWhenMaxDepthExactlyCoversTheTree() {
        let root = TreeNode("root")
        let child = TreeNode("child")
        root.children = [child]

        let (elements, truncated) = ElementQueryService.breadthFirstWalk(
            root: root, maxDepth: 5, maxElements: 100, filterMode: "all",
            children: { $0.children }, info: infoFor)

        XCTAssertEqual(elements.count, 1)
        XCTAssertFalse(truncated)
    }

    func testBreadthFirstWalkSkipsFilteredElementsUnderInteractableFilter() {
        let root = TreeNode("root")
        let decorative = TreeNode("decorative", keep: false)
        let button = TreeNode("button", keep: true)
        root.children = [decorative, button]

        let (elements, truncated) = ElementQueryService.breadthFirstWalk(
            root: root, maxDepth: 10, maxElements: 100, filterMode: "interactable",
            children: { $0.children }, info: infoFor)

        XCTAssertFalse(truncated)
        XCTAssertEqual(elements.count, 1)
        XCTAssertEqual(elements.first?.info.role, "button")
    }

    func testBreadthFirstWalkParentRefSkipsOverFilteredOutAncestor() {
        // root -> group(filtered out) -> button(kept). The button's
        // ancestor index should be nil (no kept ancestor), not pointing at
        // an index that was never added to results.
        let root = TreeNode("root")
        let group = TreeNode("group", keep: false)
        let button = TreeNode("button", keep: true)
        root.children = [group]
        group.children = [button]

        let (elements, _) = ElementQueryService.breadthFirstWalk(
            root: root, maxDepth: 10, maxElements: 100, filterMode: "interactable",
            children: { $0.children }, info: infoFor)

        XCTAssertEqual(elements.count, 1)
        XCTAssertNil(elements.first?.parentIndex)
    }

    func testBreadthFirstWalkParentRefPointsAtNearestKeptAncestor() {
        let root = TreeNode("root")
        let container = TreeNode("container", keep: true)
        let button = TreeNode("button", keep: true)
        root.children = [container]
        container.children = [button]

        let (elements, _) = ElementQueryService.breadthFirstWalk(
            root: root, maxDepth: 10, maxElements: 100, filterMode: "all",
            children: { $0.children }, info: infoFor)

        XCTAssertEqual(elements.count, 2)
        XCTAssertNil(elements[0].parentIndex)
        XCTAssertEqual(elements[1].parentIndex, 0)
    }

    // MARK: - Ref generation / staleness

    /// `AXUIElementCreateApplication` always returns a valid opaque
    /// `AXUIElement` reference for the given pid — even a fabricated,
    /// nonexistent one — because constructing the reference does no IPC and
    /// needs no TCC grant; only later attribute queries against it would.
    /// That makes it a safe, permission-free stand-in "handle" for
    /// `ElementGenerationStore` tests, which never dereference the handle,
    /// only store and retrieve it by (generation, index).
    private func dummyHandle(_ pid: Int32) -> AXUIElement {
        AXUIElementCreateApplication(pid)
    }

    func testGenerationStoreResolvesElementWithinItsGeneration() {
        let store = ElementGenerationStore()
        let handles = [dummyHandle(1), dummyHandle(2)]
        let generation = store.newGeneration(elements: handles)

        XCTAssertNotNil(store.element(generation: generation, index: 0))
        XCTAssertNotNil(store.element(generation: generation, index: 1))
    }

    func testGenerationStoreReturnsNilForOutOfRangeIndex() {
        let store = ElementGenerationStore()
        let generation = store.newGeneration(elements: [dummyHandle(1)])
        XCTAssertNil(store.element(generation: generation, index: 5))
        XCTAssertNil(store.element(generation: generation, index: -1))
    }

    func testGenerationStoreReturnsNilForUnknownGeneration() {
        let store = ElementGenerationStore()
        _ = store.newGeneration(elements: [dummyHandle(1)])
        XCTAssertNil(store.element(generation: "not-a-real-generation", index: 0))
    }

    func testGenerationStoreRetainsAtMostTwoGenerations() {
        let store = ElementGenerationStore()
        let gen1 = store.newGeneration(elements: [dummyHandle(1)])
        let gen2 = store.newGeneration(elements: [dummyHandle(2)])
        XCTAssertEqual(store.retainedGenerationCount, 2)

        let gen3 = store.newGeneration(elements: [dummyHandle(3)])
        XCTAssertEqual(store.retainedGenerationCount, 2)

        // Oldest generation (gen1) evicted; the two most recent still resolve.
        XCTAssertNil(store.element(generation: gen1, index: 0))
        XCTAssertNotNil(store.element(generation: gen2, index: 0))
        XCTAssertNotNil(store.element(generation: gen3, index: 0))
    }

    // MARK: - `enumerateElements` param-level guardrails (no live AX call reached)

    func testEnumerateElementsFailsFastWithPermissionDeniedBeforeAnyAXCall() {
        let params = EnumerateElementsParams(
            target: ElementQueryTargetInput(kind: "window", id: "123"))
        XCTAssertThrowsError(
            try ElementQueryService.enumerateElements(params: params, accessibility: .denied)
        ) { error in
            guard let rpcError = error as? SidecarRpcError else {
                return XCTFail("expected SidecarRpcError, got \(error)")
            }
            XCTAssertEqual(rpcError.taxonomyCode, .permissionDenied)
        }
    }

    func testEnumerateElementsRejectsNonWindowTarget() {
        let params = EnumerateElementsParams(
            target: ElementQueryTargetInput(kind: "display", id: "1"))
        XCTAssertThrowsError(
            try ElementQueryService.enumerateElements(params: params, accessibility: .granted)
        ) { error in
            guard let rpcError = error as? SidecarRpcError else {
                return XCTFail("expected SidecarRpcError, got \(error)")
            }
            XCTAssertEqual(rpcError.taxonomyCode, .targetNotFound)
        }
    }

    func testEnumerateElementsRefsAgainstUnknownGenerationIsStale() {
        let params = EnumerateElementsParams(
            target: ElementQueryTargetInput(kind: "window", id: "123"),
            refs: ["nonexistent-generation:0"])
        XCTAssertThrowsError(
            try ElementQueryService.enumerateElements(
                params: params, accessibility: .granted, store: ElementGenerationStore())
        ) { error in
            guard let rpcError = error as? SidecarRpcError else {
                return XCTFail("expected SidecarRpcError, got \(error)")
            }
            XCTAssertEqual(rpcError.taxonomyCode, .axElementStale)
        }
    }

    func testEnumerateElementsRefsWithMalformedRefIsStale() {
        let params = EnumerateElementsParams(
            target: ElementQueryTargetInput(kind: "window", id: "123"), refs: ["not-a-ref"])
        XCTAssertThrowsError(
            try ElementQueryService.enumerateElements(
                params: params, accessibility: .granted, store: ElementGenerationStore())
        ) { error in
            guard let rpcError = error as? SidecarRpcError else {
                return XCTFail("expected SidecarRpcError, got \(error)")
            }
            XCTAssertEqual(rpcError.taxonomyCode, .axElementStale)
        }
    }

    func testEnumerateElementsRefsAgainstStaleHandleWithinKnownGenerationIsStale() {
        // A known generation whose handle no longer resolves to a live
        // element (closed window, re-rendered view) — dummyHandle points at
        // a nonexistent pid, so readElementInfo's kAXRoleAttribute read
        // fails, exactly like a real closed-window handle would.
        let store = ElementGenerationStore()
        let generation = store.newGeneration(elements: [dummyHandle(999_999)])
        let params = EnumerateElementsParams(
            target: ElementQueryTargetInput(kind: "window", id: "123"),
            refs: ["\(generation):0"])
        XCTAssertThrowsError(
            try ElementQueryService.enumerateElements(
                params: params, accessibility: .granted, store: store)
        ) { error in
            guard let rpcError = error as? SidecarRpcError else {
                return XCTFail("expected SidecarRpcError, got \(error)")
            }
            XCTAssertEqual(rpcError.taxonomyCode, .axElementStale)
        }
    }
}

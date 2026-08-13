import Foundation

// Phase 21 — capture/control process split (historical).
//
// Phase 24 removed the Operator, and with it the only path that ever
// synthesized input (`InputSynthesisService`, `native/macos/Sources/
// WindowerControlCore/InputSynthesis.swift`, now deleted). There is nothing
// left below the stdio line that can distinguish Windower-synthesized input
// from real human input, so `TimelineEvent.source` collapses to the single
// literal `"user"` (settled decision 4, tasks/phase-24-remove-operator.md) —
// every event `EventTapSource` captures is tagged this way now. This
// constant remains the single source of truth for that literal rather than
// inlining the string at each call site.

public enum WindowerEventTag {
    public static let userSource = "user"
}

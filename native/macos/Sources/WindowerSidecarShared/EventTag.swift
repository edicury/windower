import CoreGraphics
import Foundation

// Phase 21 — capture/control process split.
//
// This tag is the one genuinely shared piece of vocabulary between the two
// surfaces: the control surface (`InputSynthesisService`) *writes* it onto
// every event it posts, and the capture surface (`EventTapSource`) *reads* it
// back off tapped events to decide `TimelineEvent.source`. Neither side can
// own it without the other importing it, so it lives in the shared module.
// It touches only CoreGraphics — no ScreenCaptureKit.

/// The single shared marker that distinguishes Windower-synthesized events
/// from real user input. `InputSynthesisService` stamps it onto every event
/// it posts (both on the `CGEventSource` and on each individual `CGEvent`);
/// `EventTapSource` reads it back off tapped events to decide
/// `TimelineEvent.source`.
///
/// The value is the ASCII bytes of "WINDOWER" packed into an `Int64`
/// (0x57 'W', 0x49 'I', 0x4E 'N', 0x44 'D', 0x4F 'O', 0x57 'W', 0x45 'E',
/// 0x52 'R'). The high byte is < 0x80 so the constant is positive and fits
/// `Int64` without wrapping. It is deliberately not 0/1 — `eventSourceUserData`
/// defaults to 0 on ordinary events, and small values are plausible
/// collisions with other tools that tag their own synthetic input.
public enum WindowerEventTag {
    public static let magic: Int64 = 0x5749_4E44_4F57_4552

    /// `TimelineEvent.source` values (see data-model.md §EventTimeline /
    /// phase-19's `source` discriminator).
    public static let operatorSource = "operator"
    public static let userSource = "user"

    /// Pure classification of a tapped event's `eventSourceUserData` value —
    /// extracted so it's testable without posting real events.
    public static func source(forUserData userData: Int64) -> String {
        userData == magic ? operatorSource : userSource
    }

    /// Classification straight off a `CGEvent`. Reading a field off an event
    /// requires no TCC grant (only *posting* does), so this is testable
    /// headlessly.
    public static func source(for event: CGEvent) -> String {
        source(forUserData: event.getIntegerValueField(.eventSourceUserData))
    }
}

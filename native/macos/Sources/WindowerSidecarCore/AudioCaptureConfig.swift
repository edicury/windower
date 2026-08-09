import AVFoundation
import Foundation

/// Wire-shape decoding and pure config math for `AudioSettings`/
/// `AudioTrackConfig` (data-model.md §AudioSettings). No `SCStream`,
/// `AVCaptureSession`, or `AVAssetWriter` capture wiring lives here — this
/// mirrors `CaptureConfig.swift`'s split between pure, headlessly-testable
/// config logic and the capture-session pieces that consume it.
///
/// `AudioTrackConfigInput`/`AudioSettingsInput` are the typed replacement
/// for the opaque `JSONValue?` `audio` param currently decoded in
/// `StartCaptureParams` (Protocol.swift) — wiring them into
/// `StartCaptureParams` itself is left to a later integration step so this
/// file stays a self-contained, independently-testable unit.

/// Decodes one element of `AudioSettings.tracks` — a discriminated union
/// keyed on `source` (`"system" | "microphone" | "narration"`, exactly the
/// TS shape in data-model.md). Modeled as a flat, permissive struct (the
/// same pattern `CaptureTargetInput` in Protocol.swift uses for its own
/// discriminated union) rather than a Swift enum with associated values, so
/// unrecognized/forward-compatible fields on a given variant don't need a
/// bespoke `CodingKeys` per case.
public struct AudioTrackConfigInput: Decodable, Equatable {
    public let source: String
    /// `system`/`microphone` only.
    public let enabled: Bool?
    /// `microphone` only; `nil` means "use the default device".
    public let deviceId: String?
    /// `narration` only. Decoded for forward-compatibility even though
    /// narration muxing is out of scope for Phase 5 — data-model.md notes
    /// narration is "supplied at stop-time" (see `Session.narration`), so a
    /// `narration` track present in `StartCaptureParams.audio` today is
    /// inert, but the shape still round-trips cleanly.
    public let filePath: String?
    /// `narration` only, milliseconds.
    public let offsetMs: Double?

    public init(
        source: String, enabled: Bool? = nil, deviceId: String? = nil,
        filePath: String? = nil, offsetMs: Double? = nil
    ) {
        self.source = source
        self.enabled = enabled
        self.deviceId = deviceId
        self.filePath = filePath
        self.offsetMs = offsetMs
    }
}

/// Mirrors `AudioSettings` (data-model.md) exactly: the list of track
/// configs plus the mux strategy (`separateTracks: true` → distinct output
/// tracks, `false` → mixed to one).
public struct AudioSettingsInput: Decodable, Equatable {
    public let tracks: [AudioTrackConfigInput]
    public let separateTracks: Bool

    public init(tracks: [AudioTrackConfigInput], separateTracks: Bool) {
        self.tracks = tracks
        self.separateTracks = separateTracks
    }
}

/// The meaningful audio-track combinations a capture session needs to
/// branch on. Deliberately does not encode narration — narration is
/// supplied at stop-time (data-model.md) and out of scope for what this
/// phase's capture wiring does with `AudioSettings.tracks` at start time.
public enum AudioTrackPlan: Equatable {
    /// No enabled `system` or `microphone` track — record video only.
    case none
    /// Only system audio requested.
    case systemOnly
    /// Only microphone audio requested, from the given device (`nil` =
    /// default device).
    case microphoneOnly(deviceId: String?)
    /// Both system and microphone requested, muxed as two distinct
    /// `AVAssetWriterInput` audio tracks (`separateTracks: true`).
    case bothSeparate(microphoneDeviceId: String?)
    /// Both system and microphone requested, mixed down to a single audio
    /// track (`separateTracks: false`). The integration step is
    /// responsible for actually performing the mix (e.g. an intermediate
    /// `AVAudioMixerNode`/manual sample-buffer summing feeding one
    /// `AVAssetWriterInput`) — this case only records that a mix is
    /// required, not how.
    case bothMixed(microphoneDeviceId: String?)
}

/// Pure inspection/config-math functions over `AudioSettingsInput`. No
/// device I/O, no `SCStream`/`AVAssetWriter` — just deciding what the
/// capture-session layer needs to build from the decoded settings.
public enum AudioCaptureConfigService {
    /// Whether an *enabled* `system` track is present. `enabled: false` or
    /// a missing `system` entry both mean "no system audio".
    public static func isSystemAudioRequested(_ settings: AudioSettingsInput) -> Bool {
        settings.tracks.contains { $0.source == "system" && ($0.enabled ?? false) }
    }

    /// Whether an *enabled* `microphone` track is present, and if so which
    /// device it names. Returns `nil` when microphone audio isn't
    /// requested at all; returns `.some(nil)` semantics via the tuple's
    /// `requested`/`deviceId` split so "requested, default device" and "not
    /// requested" aren't both representable as `nil`.
    public static func microphoneRequest(_ settings: AudioSettingsInput) -> (
        requested: Bool, deviceId: String?
    ) {
        guard
            let track = settings.tracks.first(where: {
                $0.source == "microphone" && ($0.enabled ?? false)
            })
        else {
            return (requested: false, deviceId: nil)
        }
        return (requested: true, deviceId: track.deviceId)
    }

    /// Reduces `AudioSettingsInput` to the four meaningful combinations
    /// (further split by `separateTracks`) a capture session branches on.
    public static func trackPlan(for settings: AudioSettingsInput) -> AudioTrackPlan {
        let systemRequested = isSystemAudioRequested(settings)
        let mic = microphoneRequest(settings)

        switch (systemRequested, mic.requested) {
        case (false, false):
            return .none
        case (true, false):
            return .systemOnly
        case (false, true):
            return .microphoneOnly(deviceId: mic.deviceId)
        case (true, true):
            return settings.separateTracks
                ? .bothSeparate(microphoneDeviceId: mic.deviceId)
                : .bothMixed(microphoneDeviceId: mic.deviceId)
        }
    }

    /// Standard AAC `AVAssetWriterInput` audio settings dictionary.
    /// Defaults (44.1kHz stereo) match the common denominator both system
    /// audio (`SCStreamConfiguration` reports 48kHz, but AAC encoders
    /// happily resample) and typical microphone hardware can supply.
    /// 128 kbps is the standard "transparent enough for speech/narration,
    /// small enough not to dominate file size next to the video track"
    /// AAC bitrate — screen recordings are not music production, so a
    /// higher bitrate buys negligible perceptual quality for real cost in
    /// output size.
    public static func aacOutputSettings(
        sampleRate: Double = 44_100, channels: Int = 2
    ) -> [String: Any] {
        [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: sampleRate,
            AVNumberOfChannelsKey: channels,
            AVEncoderBitRateKey: 128_000,
        ]
    }
}

/// Microphone device enumeration for `AudioTrackConfig.deviceId` selection
/// (Phase 7's `--mic-device` CLI flag consumes this indirectly via
/// `listAudioDevices`/`getPermissions`). Kept separate from
/// `AudioCaptureConfigService` because it talks to `AVCaptureDevice`
/// (real I/O), unlike the pure functions above.
public enum AudioDeviceService {
    /// `id` is `AVCaptureDevice.uniqueID` — stable across relaunches and
    /// the identifier `AudioTrackConfig.deviceId` is defined in terms of.
    public struct AudioDeviceInfo: Codable, Equatable {
        public let id: String
        public let name: String
        public let isDefault: Bool

        public init(id: String, name: String, isDefault: Bool) {
            self.id = id
            self.name = name
            self.isDefault = isDefault
        }
    }

    /// Enumerates available microphone/audio-input devices.
    ///
    /// Deviation from the newer `.microphone`/`.external` `DeviceType`
    /// cases: those were introduced in macOS 14.0, but this package's
    /// platform floor (`Package.swift`) is macOS 12.3. `.builtInMicrophone`
    /// and `.externalUnknown` are the audio-input device types available
    /// since macOS 10.15 and cover the same hardware (built-in mic, plus
    /// any USB/external audio input) without requiring an `@available`
    /// gate or dropping support for 12.3–13.x.
    public static func listMicrophoneDevices() -> [AudioDeviceInfo] {
        let discovery = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInMicrophone, .externalUnknown],
            mediaType: .audio,
            position: .unspecified
        )
        let defaultDeviceId = AVCaptureDevice.default(for: .audio)?.uniqueID
        return discovery.devices.map { device in
            AudioDeviceInfo(
                id: device.uniqueID,
                name: device.localizedName,
                isDefault: device.uniqueID == defaultDeviceId
            )
        }
    }

    /// Resolves a `deviceId` (as stored in `AudioTrackConfig.deviceId`) to
    /// a concrete `AVCaptureDevice`. `nil` input resolves to the system
    /// default audio input device. Returns `nil` when neither resolves —
    /// e.g. a `deviceId` naming a device that's been unplugged/removed
    /// since it was selected; the integration step maps that to a
    /// `TARGET_NOT_FOUND`-shaped error.
    public static func resolveDevice(deviceId: String?) -> AVCaptureDevice? {
        guard let deviceId else {
            return AVCaptureDevice.default(for: .audio)
        }
        return AVCaptureDevice(uniqueID: deviceId)
    }
}

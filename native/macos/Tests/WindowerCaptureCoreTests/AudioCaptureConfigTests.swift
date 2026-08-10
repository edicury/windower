import AVFoundation
import XCTest

import WindowerCaptureCore
import WindowerSidecarShared

/// Decode + pure config-math tests for `AudioSettingsInput`/
/// `AudioTrackConfigInput` and `AudioCaptureConfigService`, plus
/// structural-only smoke tests for `AudioDeviceService` (no real audio
/// hardware on CI runners, so device enumeration is only asserted not to
/// crash and to return well-formed entries — never specific counts/content).
final class AudioCaptureConfigTests: XCTestCase {

    // MARK: - AudioTrackConfigInput / AudioSettingsInput decoding

    func testDecodesSystemTrackEnabled() throws {
        let json = """
            { "source": "system", "enabled": true }
            """
        let track = try decode(AudioTrackConfigInput.self, from: json)
        XCTAssertEqual(track.source, "system")
        XCTAssertEqual(track.enabled, true)
        XCTAssertNil(track.deviceId)
        XCTAssertNil(track.filePath)
        XCTAssertNil(track.offsetMs)
    }

    func testDecodesSystemTrackDisabled() throws {
        let json = """
            { "source": "system", "enabled": false }
            """
        let track = try decode(AudioTrackConfigInput.self, from: json)
        XCTAssertEqual(track.source, "system")
        XCTAssertEqual(track.enabled, false)
    }

    func testDecodesMicrophoneTrackWithDeviceId() throws {
        let json = """
            { "source": "microphone", "enabled": true, "deviceId": "BuiltInMicrophoneDevice" }
            """
        let track = try decode(AudioTrackConfigInput.self, from: json)
        XCTAssertEqual(track.source, "microphone")
        XCTAssertEqual(track.enabled, true)
        XCTAssertEqual(track.deviceId, "BuiltInMicrophoneDevice")
    }

    func testDecodesMicrophoneTrackWithoutDeviceId() throws {
        let json = """
            { "source": "microphone", "enabled": true }
            """
        let track = try decode(AudioTrackConfigInput.self, from: json)
        XCTAssertEqual(track.source, "microphone")
        XCTAssertEqual(track.enabled, true)
        XCTAssertNil(track.deviceId)
    }

    func testDecodesNarrationTrack() throws {
        let json = """
            { "source": "narration", "filePath": "/tmp/narration.m4a", "offsetMs": 250 }
            """
        let track = try decode(AudioTrackConfigInput.self, from: json)
        XCTAssertEqual(track.source, "narration")
        XCTAssertEqual(track.filePath, "/tmp/narration.m4a")
        XCTAssertEqual(track.offsetMs, 250)
        XCTAssertNil(track.enabled)
        XCTAssertNil(track.deviceId)
    }

    func testDecodesAudioSettingsWithMultipleTracks() throws {
        let json = """
            {
              "tracks": [
                { "source": "system", "enabled": true },
                { "source": "microphone", "enabled": true, "deviceId": "abc" }
              ],
              "separateTracks": true
            }
            """
        let settings = try decode(AudioSettingsInput.self, from: json)
        XCTAssertEqual(settings.tracks.count, 2)
        XCTAssertTrue(settings.separateTracks)
    }

    func testDecodesAudioSettingsWithEmptyTracks() throws {
        let json = """
            { "tracks": [], "separateTracks": false }
            """
        let settings = try decode(AudioSettingsInput.self, from: json)
        XCTAssertTrue(settings.tracks.isEmpty)
        XCTAssertFalse(settings.separateTracks)
    }

    // MARK: - isSystemAudioRequested / microphoneRequest

    func testIsSystemAudioRequestedTrueWhenEnabled() {
        let settings = AudioSettingsInput(
            tracks: [AudioTrackConfigInput(source: "system", enabled: true)],
            separateTracks: false
        )
        XCTAssertTrue(AudioCaptureConfigService.isSystemAudioRequested(settings))
    }

    func testIsSystemAudioRequestedFalseWhenDisabled() {
        let settings = AudioSettingsInput(
            tracks: [AudioTrackConfigInput(source: "system", enabled: false)],
            separateTracks: false
        )
        XCTAssertFalse(AudioCaptureConfigService.isSystemAudioRequested(settings))
    }

    func testIsSystemAudioRequestedFalseWhenAbsent() {
        let settings = AudioSettingsInput(tracks: [], separateTracks: false)
        XCTAssertFalse(AudioCaptureConfigService.isSystemAudioRequested(settings))
    }

    func testMicrophoneRequestReportsDeviceId() {
        let settings = AudioSettingsInput(
            tracks: [AudioTrackConfigInput(source: "microphone", enabled: true, deviceId: "mic-1")],
            separateTracks: false
        )
        let result = AudioCaptureConfigService.microphoneRequest(settings)
        XCTAssertTrue(result.requested)
        XCTAssertEqual(result.deviceId, "mic-1")
    }

    func testMicrophoneRequestNilDeviceIdMeansDefault() {
        let settings = AudioSettingsInput(
            tracks: [AudioTrackConfigInput(source: "microphone", enabled: true)],
            separateTracks: false
        )
        let result = AudioCaptureConfigService.microphoneRequest(settings)
        XCTAssertTrue(result.requested)
        XCTAssertNil(result.deviceId)
    }

    func testMicrophoneRequestFalseWhenDisabled() {
        let settings = AudioSettingsInput(
            tracks: [AudioTrackConfigInput(source: "microphone", enabled: false, deviceId: "mic-1")],
            separateTracks: false
        )
        let result = AudioCaptureConfigService.microphoneRequest(settings)
        XCTAssertFalse(result.requested)
        XCTAssertNil(result.deviceId)
    }

    // MARK: - trackPlan(for:)

    func testTrackPlanNoneWhenNoEnabledTracks() {
        let settings = AudioSettingsInput(
            tracks: [
                AudioTrackConfigInput(source: "system", enabled: false),
                AudioTrackConfigInput(source: "microphone", enabled: false),
            ],
            separateTracks: true
        )
        XCTAssertEqual(AudioCaptureConfigService.trackPlan(for: settings), .none)
    }

    func testTrackPlanNoneWhenEmptyTracks() {
        let settings = AudioSettingsInput(tracks: [], separateTracks: true)
        XCTAssertEqual(AudioCaptureConfigService.trackPlan(for: settings), .none)
    }

    func testTrackPlanSystemOnly() {
        let settings = AudioSettingsInput(
            tracks: [AudioTrackConfigInput(source: "system", enabled: true)],
            separateTracks: true
        )
        XCTAssertEqual(AudioCaptureConfigService.trackPlan(for: settings), .systemOnly)
    }

    func testTrackPlanMicrophoneOnly() {
        let settings = AudioSettingsInput(
            tracks: [AudioTrackConfigInput(source: "microphone", enabled: true, deviceId: "mic-2")],
            separateTracks: true
        )
        XCTAssertEqual(
            AudioCaptureConfigService.trackPlan(for: settings),
            .microphoneOnly(deviceId: "mic-2")
        )
    }

    func testTrackPlanBothSeparate() {
        let settings = AudioSettingsInput(
            tracks: [
                AudioTrackConfigInput(source: "system", enabled: true),
                AudioTrackConfigInput(source: "microphone", enabled: true, deviceId: "mic-3"),
            ],
            separateTracks: true
        )
        XCTAssertEqual(
            AudioCaptureConfigService.trackPlan(for: settings),
            .bothSeparate(microphoneDeviceId: "mic-3")
        )
    }

    func testTrackPlanBothMixed() {
        let settings = AudioSettingsInput(
            tracks: [
                AudioTrackConfigInput(source: "system", enabled: true),
                AudioTrackConfigInput(source: "microphone", enabled: true, deviceId: nil),
            ],
            separateTracks: false
        )
        XCTAssertEqual(
            AudioCaptureConfigService.trackPlan(for: settings),
            .bothMixed(microphoneDeviceId: nil)
        )
    }

    // MARK: - aacOutputSettings

    func testAacOutputSettingsDefaults() {
        let settings = AudioCaptureConfigService.aacOutputSettings()
        XCTAssertEqual(settings[AVFormatIDKey] as? UInt32, kAudioFormatMPEG4AAC)
        XCTAssertEqual(settings[AVSampleRateKey] as? Double, 44_100)
        XCTAssertEqual(settings[AVNumberOfChannelsKey] as? Int, 2)
        XCTAssertEqual(settings[AVEncoderBitRateKey] as? Int, 128_000)
    }

    func testAacOutputSettingsCustomValues() {
        let settings = AudioCaptureConfigService.aacOutputSettings(sampleRate: 48_000, channels: 1)
        XCTAssertEqual(settings[AVFormatIDKey] as? UInt32, kAudioFormatMPEG4AAC)
        XCTAssertEqual(settings[AVSampleRateKey] as? Double, 48_000)
        XCTAssertEqual(settings[AVNumberOfChannelsKey] as? Int, 1)
        XCTAssertEqual(settings[AVEncoderBitRateKey] as? Int, 128_000)
    }

    // MARK: - AudioDeviceService (structural-only, no hardware assumptions)

    func testListMicrophoneDevicesDoesNotCrashAndReturnsWellFormedEntries() {
        let devices = AudioDeviceService.listMicrophoneDevices()
        for device in devices {
            XCTAssertFalse(device.id.isEmpty)
            XCTAssertFalse(device.name.isEmpty)
        }
        // At most one device may claim to be the default.
        XCTAssertLessThanOrEqual(devices.filter(\.isDefault).count, 1)
    }

    func testResolveDeviceWithNilDeviceIdDoesNotCrash() {
        // Hardware-dependent: either there's a default audio input device
        // or there isn't. Just assert this doesn't crash and, if it
        // returns something, that something is a real device.
        let device = AudioDeviceService.resolveDevice(deviceId: nil)
        if let device {
            XCTAssertFalse(device.uniqueID.isEmpty)
        }
    }

    func testResolveDeviceWithUnknownDeviceIdReturnsNil() {
        let device = AudioDeviceService.resolveDevice(deviceId: "definitely-not-a-real-device-id")
        XCTAssertNil(device)
    }

    // MARK: - helpers

    private func decode<T: Decodable>(_ type: T.Type, from json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }
}

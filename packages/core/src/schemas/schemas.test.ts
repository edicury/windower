import { describe, expect, it } from "vitest";
import { AudioSettingsSchema, AudioTrackConfigSchema } from "./audio-settings.js";
import { CaptureTargetSchema } from "./capture-target.js";
import { EventTimelineSchema, TimelineEventSchema } from "./event-timeline.js";
import { OutputManifestSchema } from "./manifest.js";
import { PermissionReportSchema, PermissionStatusSchema } from "./permissions.js";
import { RectSchema } from "./rect.js";
import { RecordingSessionSchema, SessionStateSchema } from "./session.js";
import { VideoSettingsSchema } from "./video-settings.js";

const validRect = { x: 0, y: 0, width: 1920, height: 1080 };

const validDisplayTarget = {
  kind: "display",
  id: "1",
  name: "Built-in Display",
  bounds: validRect,
  isPrimary: true,
  scaleFactor: 2,
};

const validWindowTarget = {
  kind: "window",
  id: "42",
  title: "Terminal",
  appName: "Terminal",
  appBundleId: "com.apple.Terminal",
  bounds: validRect,
  isFocused: true,
  resizable: true,
};

const validRegionTarget = {
  kind: "region",
  displayId: "1",
  bounds: validRect,
};

const validVideoSettings = {
  fps: 30,
  codec: "h264",
  container: "mp4",
  quality: "high",
  showCursor: true,
};

const validAudioSettings = {
  tracks: [
    { source: "system", enabled: true },
    { source: "microphone", enabled: false, deviceId: "abc" },
    { source: "narration", filePath: "/tmp/narration.wav", offsetMs: 0 },
  ],
  separateTracks: true,
};

const validSession = {
  id: "11111111-1111-1111-1111-111111111111",
  state: "recording",
  target: validDisplayTarget,
  video: validVideoSettings,
  audio: validAudioSettings,
  startedAt: "2026-08-09T00:00:00.000Z",
};

const validManifest = {
  windowerVersion: "0.0.0",
  sessionId: "11111111-1111-1111-1111-111111111111",
  target: validDisplayTarget,
  video: {
    ...validVideoSettings,
    actualResolution: { width: 1920, height: 1080 },
    durationMs: 5000,
  },
  audio: { tracks: [{ source: "system", trackIndex: 0 }] },
  createdAt: "2026-08-09T00:00:00.000Z",
  file: {
    path: "/tmp/out.mp4",
    sizeBytes: 1024,
    codec: "h264",
    container: "mp4",
  },
};

const validTimeline = {
  sessionId: "11111111-1111-1111-1111-111111111111",
  events: [
    { t: 0, type: "cursor_move", x: 10, y: 20 },
    { t: 5, type: "mouse_down", x: 10, y: 20, button: "left" },
    { t: 6, type: "mouse_up", x: 10, y: 20, button: "left" },
    { t: 7, type: "key_down", key: "a" },
    { t: 8, type: "key_up", key: "a" },
  ],
  capabilities: { keystrokes: true },
};

const validPermissionReport = {
  screenRecording: "granted",
  accessibility: "denied",
  microphone: "not_determined",
  daemonRunning: true,
  sidecarAvailable: true,
  sidecarVersion: "0.0.1",
};

describe("RectSchema", () => {
  it("parses a valid rect", () => {
    expect(RectSchema.parse(validRect)).toEqual(validRect);
  });

  it("rejects a rect missing a field", () => {
    expect(() => RectSchema.parse({ x: 0, y: 0, width: 10 })).toThrow();
  });
});

describe("CaptureTargetSchema", () => {
  it("parses a valid display target", () => {
    expect(CaptureTargetSchema.parse(validDisplayTarget)).toEqual(validDisplayTarget);
  });

  it("parses a valid window target", () => {
    expect(CaptureTargetSchema.parse(validWindowTarget)).toEqual(validWindowTarget);
  });

  it("parses a valid region target", () => {
    expect(CaptureTargetSchema.parse(validRegionTarget)).toEqual(validRegionTarget);
  });

  it("rejects an unknown kind literal", () => {
    expect(() => CaptureTargetSchema.parse({ ...validDisplayTarget, kind: "screen" })).toThrow();
  });

  it("rejects a window target missing a required field", () => {
    const { appBundleId, ...rest } = validWindowTarget;
    expect(() => CaptureTargetSchema.parse(rest)).toThrow();
  });
});

describe("VideoSettingsSchema", () => {
  it("parses valid video settings", () => {
    expect(VideoSettingsSchema.parse(validVideoSettings)).toEqual(validVideoSettings);
  });

  it("parses valid video settings with optional resolution", () => {
    const withRes = { ...validVideoSettings, resolution: { width: 1280, height: 720 } };
    expect(VideoSettingsSchema.parse(withRes)).toEqual(withRes);
  });

  it("rejects an invalid fps literal", () => {
    expect(() => VideoSettingsSchema.parse({ ...validVideoSettings, fps: 25 })).toThrow();
  });

  it("rejects an invalid codec", () => {
    expect(() => VideoSettingsSchema.parse({ ...validVideoSettings, codec: "vp9" })).toThrow();
  });
});

describe("AudioTrackConfigSchema / AudioSettingsSchema", () => {
  it("parses each audio track variant", () => {
    for (const track of validAudioSettings.tracks) {
      expect(AudioTrackConfigSchema.parse(track)).toEqual(track);
    }
  });

  it("parses valid audio settings", () => {
    expect(AudioSettingsSchema.parse(validAudioSettings)).toEqual(validAudioSettings);
  });

  it("rejects a narration track missing offsetMs", () => {
    expect(() =>
      AudioTrackConfigSchema.parse({ source: "narration", filePath: "/tmp/x.wav" }),
    ).toThrow();
  });

  it("rejects an unknown source discriminant", () => {
    expect(() => AudioTrackConfigSchema.parse({ source: "bluetooth", enabled: true })).toThrow();
  });
});

describe("SessionStateSchema / RecordingSessionSchema", () => {
  it("parses all known session states", () => {
    for (const state of ["pending", "recording", "stopping", "finalized", "canceled", "failed"]) {
      expect(SessionStateSchema.parse(state)).toBe(state);
    }
  });

  it("parses a valid recording session", () => {
    expect(RecordingSessionSchema.parse(validSession)).toEqual(validSession);
  });

  it("parses a finalized session with all optional fields", () => {
    const finalized = {
      ...validSession,
      state: "finalized",
      stoppedAt: "2026-08-09T00:01:00.000Z",
      outputPath: "/tmp/out.mp4",
      manifestPath: "/tmp/manifest.json",
      eventTimelinePath: "/tmp/out.events.json",
    };
    expect(RecordingSessionSchema.parse(finalized)).toEqual(finalized);
  });

  it("rejects an invalid session state", () => {
    expect(() => RecordingSessionSchema.parse({ ...validSession, state: "bogus" })).toThrow();
  });

  it("rejects a session missing a required field", () => {
    const { startedAt, ...rest } = validSession;
    expect(() => RecordingSessionSchema.parse(rest)).toThrow();
  });

  // Phase 21 — an on-disk session JSON written by an older build may carry
  // keys this schema no longer declares (e.g. the reverted
  // `operatorAttachedRunEnded`). Parsing must never fail on one; the unknown
  // key is simply stripped.
  it("parses an on-disk session JSON carrying an unknown extra key", () => {
    const onDisk = JSON.parse(
      JSON.stringify({
        ...validSession,
        state: "finalized",
        stoppedAt: "2026-08-09T00:01:00.000Z",
        outputPath: "/tmp/out.mp4",
        manifestPath: "/tmp/manifest.json",
        owner: { pid: 4821, startedAt: "2026-08-09T00:00:00.000Z" },
        operatorAttachedRunEnded: "018f2c00-0000-7000-8000-000000000000",
        someFutureField: { anything: true },
      }),
    );
    const parsed = RecordingSessionSchema.parse(onDisk);
    expect(parsed.id).toBe(validSession.id);
    expect(parsed.state).toBe("finalized");
    expect(parsed).not.toHaveProperty("operatorAttachedRunEnded");
    expect(parsed).not.toHaveProperty("someFutureField");
  });

  // Phase 21 invariant: the Capture plane never depends on the Reasoning
  // plane. `RecordingSession` carries no operator-derived field at all — and
  // there is no relationship field in either direction, since `OperatorRun`
  // carries no session identifier either.
  it("declares no operator-derived field", () => {
    const keys = Object.keys(RecordingSessionSchema.shape);
    expect(keys).not.toContain("operatorAttachedRunEnded");
    for (const key of keys) {
      expect(key.toLowerCase()).not.toContain("operator");
      expect(key.toLowerCase()).not.toContain("agent");
    }
  });
});

describe("OutputManifestSchema", () => {
  it("parses a valid manifest", () => {
    expect(OutputManifestSchema.parse(validManifest)).toEqual(validManifest);
  });

  it("parses a manifest with narration", () => {
    const withNarration = {
      ...validManifest,
      narration: { filePath: "/tmp/narration.wav", offsetMs: 100, trackIndex: 1 },
      eventTimelinePath: "out.events.json",
    };
    expect(OutputManifestSchema.parse(withNarration)).toEqual(withNarration);
  });

  it("rejects a manifest missing file info", () => {
    const { file, ...rest } = validManifest;
    expect(() => OutputManifestSchema.parse(rest)).toThrow();
  });
});

describe("TimelineEventSchema / EventTimelineSchema", () => {
  // Phase 19 added `source`, defaulted to "user" on parse so pre-Phase-19
  // `.events.json` files (like `validTimeline` here) still parse unchanged.
  it("parses each timeline event variant", () => {
    for (const event of validTimeline.events) {
      expect(TimelineEventSchema.parse(event)).toEqual({ ...event, source: "user" });
    }
  });

  it("parses a valid event timeline", () => {
    expect(EventTimelineSchema.parse(validTimeline)).toEqual({
      ...validTimeline,
      events: validTimeline.events.map((event) => ({ ...event, source: "user" })),
    });
  });

  it("rejects a mouse event with an invalid button", () => {
    expect(() =>
      TimelineEventSchema.parse({ t: 0, type: "mouse_down", x: 0, y: 0, button: "middle" }),
    ).toThrow();
  });

  it("rejects an unknown event type", () => {
    expect(() => TimelineEventSchema.parse({ t: 0, type: "scroll", x: 0, y: 0 })).toThrow();
  });
});

describe("PermissionStatusSchema / PermissionReportSchema", () => {
  it("parses all known permission statuses", () => {
    for (const status of ["granted", "denied", "not_determined", "not_applicable"]) {
      expect(PermissionStatusSchema.parse(status)).toBe(status);
    }
  });

  it("parses a valid permission report", () => {
    expect(PermissionReportSchema.parse(validPermissionReport)).toEqual(validPermissionReport);
  });

  it("rejects an invalid permission status", () => {
    expect(() =>
      PermissionReportSchema.parse({ ...validPermissionReport, screenRecording: "maybe" }),
    ).toThrow();
  });

  it("rejects a report missing daemonRunning", () => {
    const { daemonRunning, ...rest } = validPermissionReport;
    expect(() => PermissionReportSchema.parse(rest)).toThrow();
  });
});

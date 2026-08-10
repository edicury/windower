# Screen Capture Exclusivity (macOS)

`~/.windower/capture.lock` (Phase 21, v1.4). The smallest mechanism that makes one invalid state impossible: two Windower processes concurrently owning ScreenCaptureKit.

This is a **low-level macOS platform safety mechanism**, not a component, not a service, not a domain concept. Nothing in `contracts/sidecar-protocol.md` changes; no new process role exists; no new orchestration layer exists. It is **macOS-specific** — Windows/Linux backends (Phases 16/17) MAY need no such mechanism at all and are free to ignore this document entirely, provided they satisfy the same method contracts (`research.md` §2).

## The invariant

> **Windower MUST NOT allow two processes to concurrently hold live ScreenCaptureKit ownership** (`SCShareableContent` / `SCStream` / `SCScreenshotManager` state).

`replayd`, ScreenCaptureKit's system daemon, is a shared stateful singleton: a second process's `SCShareableContent.getWithCompletionHandler` call can destabilize it badly enough to kill an unrelated live `SCStream` in a *different* process (`bugs.spec.md` #6). Apple documents no supported way to avoid the contention other than not contending.

Conceptually, every caller does exactly this and nothing more:

> needs ScreenCaptureKit → try to acquire exclusivity → **acquired**: proceed · **busy**: wait briefly, then fail cleanly.

## Enforcement, in two tiers

1. **Inside the daemon — ordinary bookkeeping.** The daemon knows which capture sidecar processes it has spawned. It simply does not start a second one; concurrent in-daemon capture work (`list_targets`, `captureFrame`, the operator's proxied calls) reuses the capture sidecar process the daemon already has. No lock mediation is involved between in-daemon callers, because none is needed.
2. **Across processes — a global file mutex.** Daemon-optional execution (Phase 20) means a daemon-free `windower record` / `windower targets` can run with no shared parent, so in-process bookkeeping is not sufficient. Any process about to spawn `windower-capture-macos` MUST first acquire `~/.windower/capture.lock`, and MUST hold it for that capture sidecar process's entire lifetime. The daemon takes it too, even though its own callers never need it, so the invariant stays honest against daemon-free processes.

By construction, only `windower-capture-macos` links `WindowerCaptureCore`; `windower-control-macos` cannot `import ScreenCaptureKit` even transitively (verified via `otool -L`).

## Lock file

`~/.windower/capture.lock`, backed by the existing `FileLock` primitive (`packages/core/src/fs/file-lock.ts`) already used for `~/.windower/daemon.lock` and the per-target lock (`packages/engine/src/target-lock.ts`): `O_EXCL` create for mutual exclusion, pid-liveness check for stale-steal, `unlink` for release. Same shape as `FileTargetLock`, one global key instead of a `sha1(targetKey)`-derived path. Mode `0600`.

The payload is the minimum for stale detection and diagnostics:

```jsonc
{
  "pid": 4821,                                  // the process that spawned the capture sidecar — FileLock's liveness pid
  "acquiredAt": "2026-08-10T14:02:11.000Z",     // ISO 8601, FileLock-required, diagnostics only
  "windowerHome": "/Users/x/.windower"          // split-brain guard, same as `hello`
}
```

| Field | Type | Meaning |
|---|---|---|
| `pid` | `number` | The process holding exclusivity. `FileLock.acquire()` liveness-checks it; a dead `pid` makes the lock stealable. |
| `acquiredAt` | `string` | ISO 8601. Diagnostics only (`windower doctor`, `SCREEN_CAPTURE_BUSY` messages). |
| `windowerHome` | `string` | The holder's resolved `WINDOWER_HOME`. A caller whose own resolution disagrees treats the lock as belonging to a different install and MUST NOT steal it — same split-brain guard `hello` applies in `contracts/daemon-rpc.md`. |

Nothing else belongs in this payload. There is no holder kind, no capture-child pid, no socket path, and no `sessionId` — a machine-global lock file is the wrong place to publish a session identity, and no decision below branches on any of them.

Because the payload names no capture child, the lock holder MUST own its child's lifetime directly. That ownership is specified next.

## Process ownership

Orphan prevention is a property of **process ownership**, not of bookkeeping. The rules:

- `windower-capture-macos` is spawned as a **child of the lock holder** and is owned by it for its entire lifetime.
- It MUST exit when stdin reaches EOF — i.e. when its RPC channel closes.
- Before exiting on EOF it MUST **stop any active capture and finalize any in-progress output** (`SCStream` stopped, `AVAssetWriter` finalized), then exit. EOF arriving mid-recording MUST NOT leave a truncated or unfinalized file behind.
- If the parent dies, the OS closes the pipe, and the child terminates by that same EOF path. **This is the only orphan-prevention mechanism.** There is no pid tracking, no reaper, and no supervision process.
- The stale-holder mechanism remains keyed on the **lock owner pid**, never the child pid. The payload is exactly `{ pid, acquiredAt, windowerHome }` and MUST NOT grow a child pid — a dead holder is detected by liveness-checking `pid`, and its child is already gone by the rule above.
- Extra pid tracking or orphan-reaping infrastructure MAY be introduced **only if this ownership model demonstrably cannot work**, with a stated, observed reason recorded here. "Defense in depth" is not such a reason.

The same ownership semantics apply to `windower-control-macos`: it MUST also exit on stdin EOF. It simply has no capture state to clean up first, so the EOF path is a plain exit.

**Verification finding (Phase 21, recorded so it is not re-investigated):** `native/macos/Sources/windower-capture-macos/main.swift:335-345` — the `while let line = readLine(...)` loop terminates on EOF, `inFlightRequests.wait()` drains dispatched RPCs, and the process then falls off the end of `main.swift` and exits. **The process DOES exit on stdin EOF today.** That path performs **no capture cleanup**, however: nothing stops an active `SCStream` or finalizes the `AVAssetWriter`. The ownership model is sound; the cleanup half is missing and MUST be implemented.

## Acquire-or-wait

Every code path about to spawn a `windower-capture-macos` process runs this, in order. No path skips it, and no path spawns a second capture process because the first was inconvenient.

| # | Condition | Action |
|---|---|---|
| 1 | This process already has a capture sidecar running (in-memory record) | Reuse it. No file I/O, no spawn. This is the daemon's normal path. |
| 2 | Lock file absent, or holder `pid` dead | `FileLock.acquire()` (which unlinks-and-recreates on a dead holder), spawn the capture sidecar under the lock, proceed. |
| 3 | Lock held by a live holder with the same `windowerHome` | **Wait, bounded** (below). If it frees within the budget, re-run from row 1. On expiry, `SCREEN_CAPTURE_BUSY`. Never spawn. |
| 4 | Lock held by a live holder whose `windowerHome` differs | `SCREEN_CAPTURE_BUSY` immediately, `message` naming both paths. Never wait, never steal, never spawn — two installs contending for `replayd` is exactly the hazard. |

`EPERM` from `kill(pid, 0)` means a live process owned by another user: not stealable, treated as row 3/4.

### Bounded wait

`FileLock` has no wait-for-release facility, and adding one (kqueue watches, a futex-shaped scheme) would be a new mechanism for a case that is usually microseconds long. So row 3 polls:

- Re-read the holder via `readHolder()` on a backoff of **5 ms, doubling to a 100 ms ceiling**.
- Total budget default **2000 ms**, measured from the first failed acquire. Hosts MAY override it, and it MUST be finite — an unbounded wait turns a live-but-wedged holder into a hang.
- Each poll re-runs the table, so a holder that dies mid-wait is picked up as row 2 (stale steal) rather than waited out.
- On expiry the caller MUST surface `SCREEN_CAPTURE_BUSY` and MUST NOT spawn a capture process. That is the terminal outcome — not a retry-forever loop, not a crash.

Session state is untouched by lock recovery: the daemon's existing `recoverCrashedSessions()` pass marks a crashed session `failed` on next start. Lock recovery runs in contexts (a daemon-free `list_targets`) that have no business finalizing someone else's recording.

## Deliberately not specified

So nobody rebuilds it: there is **no** capture-process discovery, **no** routing of a capture call to the lock holder, **no** IPC socket published by the holder, **no** cross-process RPC between Windower processes for capture, and **no** holder lifecycle/promotion semantics. A caller that finds the lock held waits or fails — it does not connect to the holder and ask it to capture on its behalf.

This is a deferral, not an oversight. The invariant only requires that a second ScreenCaptureKit process never exists, and waiting satisfies that completely. Routing would only serve *concurrent independent daemon-free ScreenCaptureKit consumers*, which no current product requirement asks for. If one later does, it gets designed then.

## What never takes this lock

- `windower-control-macos` — it implements only `describe` / `performInput` / `resizeWindow`, backed by `CGEventPost`/`CGEventSource` (`InputSynthesis.swift`) and `AXUIElement*` + `CGWindowListCopyWindowInfo` (`WindowControl.swift`). None of those touch ScreenCaptureKit, `replayd`, or any shared capture state. Consequently: any number of control-surface processes MAY run concurrently, with each other and with a capture process; `performInput`/`resizeWindow` are **never** serialized against a recording or a `captureFrame`; a wedged or `kill -9`'d control surface cannot affect a recording. Code that takes this lock before spawning a control-surface process is a bug.
- The operator loop child (`packages/operator`), which holds no native handles and proxies screen-facing calls through the daemon (`contracts/operator-loop-protocol.md`).
- Post-processing (Phase 15), which reads finished files off disk.
- Per-target recording contention, which remains `target-lock.ts`'s job and returns `TARGET_ALREADY_RECORDING`. This lock arbitrates *the ScreenCaptureKit resource*; the target lock arbitrates *what is being recorded*.

## Error code

Added to `DaemonErrorCodeSchema` (`packages/core/src/daemon/methods.ts`), same `data.code` shape as the rest of the taxonomy.

| Code | Meaning |
|---|---|
| `SCREEN_CAPTURE_BUSY` | ScreenCaptureKit is owned by another live process — a same-home holder that outlived the wait budget (row 3), or any holder from a different `WINDOWER_HOME` (row 4). `message` names the holder's `pid`, `acquiredAt`, and the elapsed budget. Remediation: stop the holding recording, or run both callers through the same daemon/home. |

`CAPTURE_FAILED`, `PERMISSION_DENIED`, and the rest of `contracts/sidecar-protocol.md`'s taxonomy are unchanged.

## Verification

Per Phase 21's exit criteria (`specs/001-windower-mvp/tasks/`): a real 3-minute `windower operate` run produces **zero** `replayd`-invalidation lines in `log stream` output across at least three repetitions, and a `kill -9` of a lock-holding capture process is followed by a clean stale-steal on the very next `list_targets` rather than a wedged capture surface.

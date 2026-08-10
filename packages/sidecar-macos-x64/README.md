# @windower/sidecar-macos-x64

Platform-specific optional dependency of `@windower/cli` / `@windower/mcp-server` (esbuild/swc-style
pattern): npm resolves this package only on `darwin`/`x64` hosts via its `os`/`cpu` fields, and
`packages/core`'s `resolveSidecarBinaryPath(surface)` finds the binaries at runtime via
`require.resolve("@windower/sidecar-macos-x64/bin/<binary>")`.

Since Phase 21 the macOS sidecar is **two** binaries, one per protocol surface
(`contracts/sidecar-protocol.md`), and this package ships both:

| Surface | Binary | Methods |
| --- | --- | --- |
| capture | `bin/windower-capture-macos` | `describe`, `getPermissions`, `requestPermission`, `enumerateTargets`, `startCapture`, `stopCapture`, `cancelCapture`, `captureFrame` |
| control | `bin/windower-control-macos` | `describe`, `getPermissions`, `requestPermission`, `performInput`, `resizeWindow` |

Both must be present: a package shipping only one leaves either recording or input synthesis
broken at runtime, with nothing at install time to catch it.

## Release-build step (not done by this package's own build)

This package ships **binary artifacts, not source** — there is no build step here that produces
`bin/`. Before `pnpm publish` (or `pnpm -r publish`) is run for a release, the release process must
copy the codesigned + notarized release binaries into place:

```sh
mkdir -p packages/sidecar-macos-x64/bin
cp native/macos/.build/release/windower-capture-macos packages/sidecar-macos-x64/bin/windower-capture-macos
cp native/macos/.build/release/windower-control-macos packages/sidecar-macos-x64/bin/windower-control-macos
chmod +x packages/sidecar-macos-x64/bin/windower-capture-macos packages/sidecar-macos-x64/bin/windower-control-macos
```

(`native/macos/.build/release/...` is produced by `swift build -c release --arch x86_64` on an
Apple Developer ID–signed/notarized build machine — `native/macos`'s `codesign` script signs both
binaries; see `native/macos/CODESIGNING.md` and
`specs/001-windower-mvp/tasks/phase-14-packaging.md`.)

Publishing this package without that copy step produces a package with no `bin/` payload — CLI
users on x64 would fail sidecar resolution at runtime with a clear "optional dependency not
installed" style error rather than a silent wrong binary.

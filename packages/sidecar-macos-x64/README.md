# @windower/sidecar-macos-x64

Platform-specific optional dependency of `@windower/cli` / `@windower/mcp-server` (esbuild/swc-style
pattern): npm resolves this package only on `darwin`/`x64` hosts via its `os`/`cpu` fields, and
`packages/core`'s `resolveSidecarBinaryPath()` finds the binary at runtime via
`require.resolve("@windower/sidecar-macos-x64/bin/windower-sidecar-macos")`.

## Release-build step (not done by this package's own build)

This package ships a **binary artifact, not source** — there is no build step here that produces
`bin/windower-sidecar-macos`. Before `pnpm publish` (or `pnpm -r publish`) is run for a release, the
release process must copy the codesigned + notarized release binary into place:

```sh
cp native/macos/.build/release/windower-sidecar-macos packages/sidecar-macos-x64/bin/windower-sidecar-macos
chmod +x packages/sidecar-macos-x64/bin/windower-sidecar-macos
```

(`native/macos/.build/release/...` is produced by `swift build -c release --arch x86_64` on an
Apple Developer ID–signed/notarized build machine — see
`specs/001-windower-mvp/tasks/phase-14-packaging.md`.)

Publishing this package without that copy step produces a package with no `bin/` payload — CLI
users on x64 would fail sidecar resolution at runtime with a clear "optional dependency not
installed" style error rather than a silent wrong binary.

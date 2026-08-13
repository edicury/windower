# Codesigning + Notarization — `windower-capture-macos` / `windower-control-macos`

> Phase 21 split the single `windower-sidecar-macos` executable into two:
> `windower-capture-macos` (the ScreenCaptureKit-owning capture sidecar) and
> `windower-control-macos` (synthetic input + window control). BOTH ship, so
> both must be signed and notarized — `scripts/codesign-notarize.sh` handles
> one binary per invocation and the `codesign` npm script calls it twice.

**Status: wired into CI, still awaiting its first real run.** This
scaffolding (`scripts/codesign-notarize.sh` + the `codesign` npm script) is
now called for real by `native/macos/scripts/ci-build-and-sign.sh`, which
Phase 23 wired into `.github/workflows/release.yml` (Job 1 — build + sign +
notarize). No real macOS codesigning identity or Apple credentials have been
exercised against it in *this* environment either, so this is not a claim
that it now works end-to-end — only that the plumbing from "release
triggered" to "this script runs with real secrets" now exists. Treat this as
a documented, believed correct implementation that still needs its first
real CI run against production secrets (`DEVELOPER_ID_CERT_P12`,
`NOTARY_API_KEY_P8`, etc. — see the secrets table below) to confirm
end-to-end before Phase 14's exit criteria ("sidecar binary is codesigned +
notarized") can be marked done.

## Why this is needed

Gatekeeper on a clean macOS machine blocks execution of an unsigned/
unnotarized binary downloaded from the internet (quarantine attribute) unless
the user manually overrides it via System Settings. Phase 14's exit criteria
require `npm install -g @windower/cli` → `windower start` to work with **zero
manual steps**, so each shipped sidecar binary must be:

1. Signed with a **Developer ID Application** certificate (`codesign`).
2. **Notarized** by Apple (`notarytool submit ... --wait`).
3. Have Apple's notarization ticket **stapled** to the artifact where
   possible (`stapler staple`), so Gatekeeper's checks work offline too.

## Required environment variables

| Variable | Purpose |
|---|---|
| `DEVELOPER_ID_APPLICATION` | Exact codesigning identity string, e.g. `"Developer ID Application: Example Inc (TEAMID1234)"`. Must match an identity in your keychain (`security find-identity -v -p codesigning`). |
| `NOTARY_API_KEY_ID` | App Store Connect API key ID (short alphanumeric string shown when you create the key). |
| `NOTARY_API_ISSUER_ID` | App Store Connect API issuer ID (a UUID, shared across all your keys). |
| `NOTARY_API_KEY_PATH` | Filesystem path to the downloaded `.p8` private key file for the API key. |

`NOTARY_API_KEY_PATH` is a **local filesystem path** and is the right shape
for running the script by hand or from a machine that already has the `.p8`
file on disk. CI has no persistent filesystem to keep a `.p8` file on, so
`ci-build-and-sign.sh` instead takes a base64-encoded secret,
`NOTARY_API_KEY_P8`, decodes it to a tempfile at job runtime, and sets
`NOTARY_API_KEY_PATH` to point at that tempfile before calling this script —
this script itself is unchanged either way, it always just wants a working
`NOTARY_API_KEY_PATH`. Keep using `NOTARY_API_KEY_PATH` directly for local/
manual runs; use `NOTARY_API_KEY_P8` only when adding or editing CI secrets.

This uses **App Store Connect API key authentication** for `notarytool`
(`--key`/`--key-id`/`--issuer`), not the deprecated Apple ID + app-specific
password flow (`--apple-id`/`--password`/`--team-id`). API keys don't expire
on password rotation/2FA changes and are Apple's recommended non-interactive
path for CI.

## Obtaining the credentials

### 1. Developer ID Application certificate

Requires an active Apple Developer Program membership (paid, $99/yr).

1. Sign in at https://developer.apple.com/account.
2. **Certificates, IDs & Profiles → Certificates → +**.
3. Choose **Developer ID Application** (not "Apple Distribution" or
   "Developer ID Installer" — those are for the Mac App Store / installer
   packages respectively; the sidecar is a bare CLI binary).
4. Generate a CSR from Keychain Access (**Keychain Access → Certificate
   Assistant → Request a Certificate From a Certificate Authority**) and
   upload it.
5. Download the issued certificate and double-click to install it into your
   login keychain (it must come with its private key — either generated
   locally via the CSR flow above, or exported as a `.p12` from the machine
   that generated it).
6. Confirm it's usable: `security find-identity -v -p codesigning` should
   list `"Developer ID Application: <Your Org> (<TEAMID>)"`. That exact
   string (including the team ID suffix) is the value for
   `DEVELOPER_ID_APPLICATION`.

For CI (GitHub Actions), the `.p12` (cert + private key) is typically
base64-encoded into a secret, imported into a temporary keychain at job
start via `security import` / `security create-keychain`, and the identity
string exported as another secret or env var.

### 2. App Store Connect API key (for notarization)

1. Sign in at https://appstoreconnect.apple.com.
2. **Users and Access → Integrations → App Store Connect API → Team Keys**
   (note: notarization needs a key with at least the **Developer** role;
   it does not require Admin).
3. **Generate API Key**, name it (e.g. "windower-notarization"), pick a role.
4. Download the `.p8` file **immediately** — Apple only lets you download it
   once. Store it securely (e.g. a CI secret store), not in the repo.
5. Note the **Key ID** and the **Issuer ID** (the issuer ID is shown once at
   the top of the Team Keys page and is the same across all your keys).

These map directly to `NOTARY_API_KEY_ID`, `NOTARY_API_ISSUER_ID`, and the
`.p8` file's path to `NOTARY_API_KEY_PATH`.

## Running it locally

```sh
cd native/macos
swift build -c release
export DEVELOPER_ID_APPLICATION="Developer ID Application: Example Inc (TEAMID1234)"
export NOTARY_API_KEY_ID="ABC123DEFG"
export NOTARY_API_ISSUER_ID="00000000-0000-0000-0000-000000000000"
export NOTARY_API_KEY_PATH="$HOME/secrets/AuthKey_ABC123DEFG.p8"
./scripts/codesign-notarize.sh
# or: npm run codesign / pnpm run codesign (same script, same env vars;
# no-ops with a clear skip message if DEVELOPER_ID_APPLICATION is unset)
```

The script:

1. Validates the binary exists and all four env vars are set (fails loudly,
   does not silently no-op, if invoked directly with missing vars).
2. `codesign --sign "$DEVELOPER_ID_APPLICATION" --options runtime --timestamp <binary>`
3. Zips the binary (`ditto`) since `notarytool submit` requires a
   zip/dmg/pkg, not a bare executable.
4. `xcrun notarytool submit ... --wait` (blocks until Apple's notarization
   service returns Accepted/Invalid). **Turnaround varies a lot and "a few
   minutes" is optimistic — plan for worse.** Observed range: ~45 minutes
   for a first-ever submission from a given account/session, dropping to
   under 2 minutes for a second binary submitted immediately after in the
   same session. There's no visible signal ahead of time for which regime
   you're in. Because of this, `ci-build-and-sign.sh`'s CI job step budgets
   **60+ minutes** rather than a tight timeout, and relies on `notarytool
   --wait`'s own internal polling rather than a hand-rolled poll loop on
   top of it. If you're running this locally and it seems to hang, this is
   almost certainly why — let it run rather than assuming it's stuck.
5. `xcrun stapler staple <binary>` — best-effort; stapling a ticket directly
   onto a loose (non-bundled) Mach-O executable is not guaranteed to work
   the same way it does for `.app`/`.pkg`/`.dmg` since there's no resource
   fork to attach to. If it fails, that's expected for this artifact shape
   and Gatekeeper falls back to its online notarization check at launch
   time, so it still isn't blocked. If Phase 14 ends up shipping the sidecar
   inside a `.pkg` installer instead of a bare binary, stapling would apply
   more cleanly there.
6. Verifies with `codesign --verify --verbose` and `spctl --assess --type
   execute --verbose`, printing PASS/FAIL for each.

## How this fits into the release pipeline

There is now a real release workflow: `.github/workflows/release.yml`,
triggered by a git tag push matching `v*` or a manual `workflow_dispatch`.
It runs three jobs:

```
Job 1 — build + sign + notarize (runs-on: macos-14, timeout >= 60 minutes)
  swift build -c release for arm64 (native) and an x64 build/cross-compile attempt
  -> import DEVELOPER_ID_CERT_P12 into a temporary CI keychain
  -> native/macos/scripts/ci-build-and-sign.sh
       (wraps this script — scripts/codesign-notarize.sh — per binary/arch)
  -> copy signed binaries into packages/sidecar-macos-{arm64,x64}/bin/

Job 2 — sidecar permissions regression check
  scripts/release/check-sidecar-permissions.sh
  packs each sidecar package and asserts the shipped bin/ entries are
  executable, so a repeat of the @windower/core@0.1.3 chmod bug fails the
  build before anything publishes

Job 3 — version bump + dependency-graph-ordered publish (gated on 1-2)
  node scripts/release/release.mjs bump
  node scripts/release/release.mjs publish
  publishes core -> (engine, engine-narration) -> daemon -> cli
  -> mcp-server -> (sidecar-macos-arm64, sidecar-macos-x64), authenticated
  via NPM_TOKEN, hard-stopping (never retrying) on an "already exists"
  registry error
```

Versioning/publish ordering uses a custom script
(`scripts/release/{graph,lib,bump,publish,release}.mjs`), not `changesets` —
changesets' changelog-per-package/release-PR model didn't fit this repo's
binary-artifact sidecar packages well (a rebuilt binary isn't a diffable
change), so a small script that knows the exact 9-package dependency graph
was built instead.

## GitHub Actions secrets used by `release.yml`

| Secret | Purpose |
|---|---|
| `DEVELOPER_ID_APPLICATION` | Same codesigning identity string as the local env var above. |
| `NOTARY_API_KEY_ID` | Same App Store Connect API key ID as the local env var above. |
| `NOTARY_API_ISSUER_ID` | Same App Store Connect API issuer ID as the local env var above. |
| `NOTARY_API_KEY_P8` | Base64-encoded contents of the `.p8` notarization key. `ci-build-and-sign.sh` decodes this to a tempfile and points `NOTARY_API_KEY_PATH` at it — the CI counterpart of the local, file-path-based `NOTARY_API_KEY_PATH` above. |
| `DEVELOPER_ID_CERT_P12` | Base64-encoded `.p12` export (certificate + private key) of the Developer ID Application identity. Imported into a temporary CI keychain at job start (`security create-keychain` / `security import`), per the standard GitHub Actions macOS codesigning pattern. |
| `DEVELOPER_ID_CERT_PASSWORD` | The export password used when the `.p12` above was created. Required to import it into the temporary keychain. |
| `NPM_TOKEN` | An npm **Automation**-type access token (bypasses interactive OTP/webauthn, which every manual `pnpm publish` this project has done so far required). Consumed by `scripts/release/publish.mjs` for Job 3's publish steps. |

## Verifying a signed/notarized binary manually

```sh
codesign --verify --verbose /path/to/windower-capture-macos
codesign -dv --verbose=4 /path/to/windower-capture-macos   # inspect signing details
spctl --assess --type execute --verbose /path/to/windower-capture-macos
xcrun stapler validate /path/to/windower-capture-macos      # only meaningful if stapling succeeded
```

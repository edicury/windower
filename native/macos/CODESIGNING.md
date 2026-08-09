# Codesigning + Notarization — `windower-sidecar-macos`

**Status: UNVERIFIED.** This scaffolding (`scripts/codesign-notarize.sh` +
the `codesign` npm script) has never been run against a real Developer ID
certificate or App Store Connect API key in this repo. No such credentials
exist in this sandbox/dev environment. Treat this as a documented, believed
correct implementation that still needs a first real run (ideally in CI with
secrets, or manually by someone holding an Apple Developer account) before
Phase 14's exit criteria ("sidecar binary is codesigned + notarized") can be
marked done.

## Why this is needed

Gatekeeper on a clean macOS machine blocks execution of an unsigned/
unnotarized binary downloaded from the internet (quarantine attribute) unless
the user manually overrides it via System Settings. Phase 14's exit criteria
require `npm install -g @windower/cli` → `windower start` to work with **zero
manual steps**, so the shipped `windower-sidecar-macos` binary must be:

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
   service returns Accepted/Invalid — can take a few minutes).
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

There is currently **no release/publish workflow** in this repo —
`.github/workflows/ci.yml` only runs lint/typecheck/build/test on every push
and PR to `main`, and does not build a distributable artifact. There is
nothing to wire live secrets into yet, and no real Apple credentials exist to
test this script against in this environment.

When a release workflow is added (per Phase 14's npm-packaging bullets —
`@windower/sidecar-macos-arm64`/`-x64` optional-dependency packages), the
intended slot for this step is:

```
swift build -c release   # per architecture (arm64 native; x64 via cross/Rosetta CI runner or a second job)
  -> npm run codesign     # this script; requires the 4 secrets below in the job env
  -> package the signed, notarized binary into @windower/sidecar-macos-<arch>
  -> npm publish
```

Suggested (not yet configured) GitHub Actions secrets for that future job:
`DEVELOPER_ID_APPLICATION`, `NOTARY_API_KEY_ID`, `NOTARY_API_ISSUER_ID`, and
a base64'd `NOTARY_API_KEY_P8` (decoded to a temp file at job start to
populate `NOTARY_API_KEY_PATH`), plus a base64'd `DEVELOPER_ID_CERT_P12` +
`DEVELOPER_ID_CERT_PASSWORD` to import the signing certificate into a
temporary CI keychain. None of this is wired into `ci.yml` — deliberately
left as a future addition once real credentials exist, rather than adding
secret references that would just fail or be no-ops today.

## Verifying a signed/notarized binary manually

```sh
codesign --verify --verbose /path/to/windower-sidecar-macos
codesign -dv --verbose=4 /path/to/windower-sidecar-macos   # inspect signing details
spctl --assess --type execute --verbose /path/to/windower-sidecar-macos
xcrun stapler validate /path/to/windower-sidecar-macos      # only meaningful if stapling succeeded
```

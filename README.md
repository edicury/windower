# windower

A Claude Code plugin that turns a slice of a software system (a module, feature, PR, ticket or doc) into a captioned explainer video: about 30 seconds in `quick` mode, 70-90 seconds by default (`normal`), or a 2-6 minute `deep` dive. Claude reads the code, git history and any connected MCP source (Notion, Linear, Slack, ...), writes a cited brief and a validated storyboard, waits for your explicit approval, then renders an mp4 with captions using framekit, a programmatic React video renderer (headless Chromium capture, ffmpeg encode).

[![Watch windower explain itself (about 2 minutes, with narration)](https://media.windower.io/explainer-poster.jpg)](https://media.windower.io/explainer.mp4)

_The video above was made with windower itself, narrated with a text-to-speech voice._

## Install

From the Claude Code marketplace:

```
/plugin marketplace add edicury/windower
/plugin install windower@windower
```

Or from git (a plain checkout, also what you want for development):

```
git clone https://github.com/edicury/windower.git
cd windower
pnpm install
```

For a git checkout, point Claude Code at it with `claude --plugin-dir /path/to/windower`.

## Prerequisites

- Node.js 18 or newer and [pnpm](https://pnpm.io/).
- `ffmpeg` and `ffprobe` on your `PATH`.
- Disk space: the first render needs a Chrome Headless Shell (found automatically, or installed once with `framekit browsers install`; `WINDOWER_BROWSER_CACHE` points windower at a shared cache), plus room for the rendered video.
- Network access on the first render for that download.

`pnpm ve:doctor` checks all of this and prints a fix for anything missing.

## Quickstart

1. Install the plugin (see Install above). With the marketplace it lives under `~/.claude/plugins/cache/windower/windower/<version>`; Claude resolves it as `$WINDOWER` (`${CLAUDE_PLUGIN_ROOT}`, or two directories above `skills/windower`). Run `pnpm install --dir "$WINDOWER"` once if its `node_modules` is missing (the skill does this for you). framekit, the renderer, comes from npm (`@windower/framekit`); no sibling checkout is needed. The Chrome Headless Shell is downloaded on the first render (or reused from `WINDOWER_BROWSER_CACHE`, default `~/.cache/windower`).
2. Open Claude Code, ideally in a scratch or working directory, and pass the repository you want to explain:

```
/explain-video the checkout retry logic --audience onboarding
```

The slice can be paths, a symbol, a feature description, a PR number or URL, or a link to a ticket or doc. The audience is one of `onboarding`, `pr-review`, `stakeholder`, `docs`. Runs are written under the current working directory as `.windower/<slug>/`, so starting Claude Code inside the repo being explained writes there. The repo being explained is only read (it is referenced by an absolute `repoRoot`), so running from a scratch directory keeps it untouched. The video is at the video at `out/video.mp4` and captions as `out/captions.srt` and `out/captions.vtt`.

`/explain-video` is a Claude Code slash command. Other harnesses use a plain request, for example "use the windower skill to explain the checkout retry logic".

## How it works

1. Scope the slice, audience and length (default 90 s).
2. Gather evidence: code, git/PR history, connected MCP sources. Every fact carries a citation.
3. Write `brief.md` and lint its provenance.
4. Redact secrets and personal data from the brief.
5. Write and validate `storyboard.json` (schema, rules, limits, citations).
6. **Approval gate.** Claude shows the scene outline, estimated length, narration voice and model, characters billed and what data leaves your machine, then stops. Nothing renders until you explicitly approve. Silence, a question or an edit request is not approval.
7. Synthesize narration (if voiced), prepare captions, render.

Runs are resumable: re-running `/explain-video` on the same slice continues at the next unfinished stage and keeps your edits to `brief.md` and `storyboard.json`.

## Sources

- Code in the current repository.
- Git history and pull requests.
- Any MCP server you have connected, such as Notion, Linear or Slack, plus URLs. The gate lists which external sources were used.

## Voice

Narration providers:

| Provider     | Credentials                                         |
| ------------ | --------------------------------------------------- |
| `elevenlabs` | `ELEVENLABS_API_KEY`                                |
| `openai`     | `OPENAI_API_KEY`                                    |
| `piper`      | local binary: `PIPER_BIN` (optional), `PIPER_MODEL` |
| `null`       | none (silent, captions only; same as `--no-voice`)  |

- Keys come from your shell environment only. They are never read from `.windower.json` and never written to disk.
- The provider is resolved from `.windower.json`, then available keys, then falls back to silent.
- `pnpm ve:voices` lists the voices on your ElevenLabs account; pass the chosen id with `--voice <id>` (and `--provider`, `--model`) to `ve:gate` and `ve:synth`, or persist it in `.windower.json`.
- Cost is driven by the number of characters in the narration. The gate shows the character count; windower makes no price claim, so check your provider's current pricing.
- Changing voice or model bills again.

## Other harnesses (Codex, opencode)

Claude Code is the primary supported harness. The engine (`scripts/`, `ve:*`) and the `skills/windower/SKILL.md` format are portable, but only the following has been tried:

- Claude Code: supported.
- Codex CLI 0.154.0: run end to end under `workspace-write` with network access enabled. It reached the approval gate, relayed the gate summary, and after approval ran gate --approve, timing and ElevenLabs synth successfully. `prepare` needed a writable copy of the plugin directory (the sandbox makes the windower repo read-only). `render` cannot run inside the macOS Codex sandbox (Chromium cannot start, no local port), but rendering the same prepared run outside the sandbox worked (1920x1080 with audio).
- opencode: untested.

Codex install:

1. `git clone https://github.com/edicury/windower.git && pnpm install --dir windower`.
2. Copy or symlink `skills/windower` into Codex's skills directory, and/or add an `AGENTS.md` to your project that points at the `SKILL.md` absolute path (start from [skills/windower/AGENTS.example.md](skills/windower/AGENTS.example.md)).
3. `export WINDOWER_HOME=/absolute/path/to/windower` so the skill finds the scripts when `${CLAUDE_PLUGIN_ROOT}` is not set.
4. Ask in plain words: "use the windower skill to explain ...".

If `pnpm ve:*` fails with `EPERM` or an IPC pipe error inside a sandbox, use `sh "$WINDOWER_HOME/scripts/ve.sh" <name> <args>` (for example `ve.sh gate "$RUN" --no-voice`). It points `TMPDIR` at `${WINDOWER_TMPDIR:-$WINDOWER_HOME/.tmp}`. A `ve:doctor` failure only on a sandboxed port or network probe is non-fatal with `--no-voice`.

`ve:render` (and `ve:snapshots`) need Chrome and a local port. Under a sandboxed harness such as Codex `workspace-write` on macOS (seatbelt: Chromium bootstrap permission denied, listen on 127.0.0.1 EPERM), run render outside the sandbox or via the harness's escalation request. `ve:synth` needs network access.

`ve:prepare` writes narration audio into `$WINDOWER_HOME/template/public/audio`. When the windower directory is read-only (sandbox), use a writable copy of the plugin and point `WINDOWER_HOME` at it.

## Privacy

- Only the narration text is sent to the TTS provider you approve. Code, briefs, images and everything else stay on your machine. With `null` (silent) or `piper`, nothing leaves at all.
- The approval gate states this and names the provider before anything is sent.
- Briefs are scanned for secrets, key-shaped strings, `.env` values and emails/phone numbers before the storyboard is written; `.env*`, `*.pem` and `id_rsa*` files are never quoted in code scenes.
- Generated artifacts live in `.windower/` under the directory you run from (your repo, or a scratch directory if you chose one). In a repo, add it to `.gitignore`. windower never commits anything.
- MCP sources you connect are read by Claude as part of the normal Claude Code session, under that tool's own data terms.

## Configuration

Optional `.windower.json` at the root of the repository you are explaining (the storyboard `repoRoot`), not in the windower directory. The logo and brand colors are read from that file, so a run against a repo without one renders unbranded. Put it next to that repo's `package.json`:

```json
{
  "provider": "openai",
  "voice": "alloy",
  "model": "tts-1",
  "defaultMode": "normal",
  "brand": {
    "primary": "#0A84FF",
    "background": "#0B0D12",
    "accent": "#FFB020",
    "text": "#F5F7FA",
    "font": "Inter",
    "logo": "./assets/logo.svg"
  }
}
```

Every key is optional. The full option reference is in [Customizing the video](#customizing-the-video) below.

Never put API keys here; a field that looks like a secret is rejected. Unknown keys give a warning; invalid values stop with the field path.

### Customizing the video

Everything you can change lives in `.windower.json` at the repository root (the directory you run from), plus a few flags per run. Nothing else in the output is configurable. Here is a complete example with every key, annotated (JSON has no comments, so remove the `//` notes before saving):

```jsonc
{
  "provider": "elevenlabs", // elevenlabs | openai | piper | null (silent)
  "providers": ["./my-provider.js"], // validated as string[], but not loaded yet
  "voice": "EXAVITQu4vr4xnSDxMaL", // provider-specific voice id
  "model": "eleven_multilingual_v2", // provider-specific model id
  "defaultMode": "normal", // quick | normal | deep, used when the request names no mode
  "brand": {
    "primary": "#0A84FF", // required, hex
    "background": "#0B0D12", // required, hex
    "accent": "#FFB020", // optional, hex
    "text": "#F5F7FA", // optional, hex
    "font": "Inter", // optional, family name
    "logo": "./assets/logo.svg", // optional, .svg or .png, max 256 KB
    "logoPosition": "top-right", // optional corner
  },
}
```

| Key                  | Type     | Default                                                  | Notes                                                                                                                             |
| -------------------- | -------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `provider`           | string   | first available key, else `null` (silent)                | `elevenlabs`, `openai`, `piper` or `null` (silent). Flag `--provider` overrides; `--no-voice` forces `null`.                      |
| `providers`          | string[] | none                                                     | Must be an array of strings; accepted but not loaded by any script yet.                                                           |
| `voice`              | string   | `EXAVITQu4vr4xnSDxMaL` / `alloy` / `en_US-lessac-medium` | Per-provider default shown for elevenlabs / openai / piper. Flag `--voice` overrides.                                             |
| `model`              | string   | `eleven_multilingual_v2` / `gpt-4o-mini-tts` / `piper`   | Same order as above. Flag `--model` overrides.                                                                                    |
| `defaultMode`        | string   | `normal`                                                 | `quick`, `normal` or `deep`; used when the request names no mode. `defaultLengthSec` is deprecated and ignored in favour of this. |
| `brand.primary`      | hex      | built-in palette (no brand)                              | Required if `brand` is present. Accent color of the scenes.                                                                       |
| `brand.background`   | hex      | `#0b1020`                                                | Required if `brand` is present.                                                                                                   |
| `brand.accent`       | hex      | none                                                     | Secondary accent.                                                                                                                 |
| `brand.text`         | hex      | `#e8ecff`                                                | Text color. Panels, borders, muted text and the captions bar are derived by mixing it with the background.                        |
| `brand.font`         | string   | Inter, then system fonts                                 | Family name only: letters, digits, spaces and hyphens, up to 64 characters.                                                       |
| `brand.logo`         | path     | none                                                     | `.svg` or `.png`, at most 256 KB, path relative to the repo root, file must exist.                                                |
| `brand.logoPosition` | string   | `top-right`                                              | `top-left`, `top-right`, `bottom-left` or `bottom-right`.                                                                         |

Colors are hex only: `#rgb` or `#rrggbb`.

**Colors.** Set `primary` and `background` (both required); add `text` and `accent` as needed. When preparing, windower prints a warning if text on background is below 4.5:1 contrast, or if `primary` on `background` is below 3:1. It is a warning, not an error, but low contrast makes the captions and scenes hard to read.

**Font.** `font` is a family name such as `"Inter"` or `"IBM Plex Sans"`. windower never downloads fonts and bundles none: the video is rendered in headless Chromium, which uses the font only if it is installed on the machine that renders. If it is not installed, text falls back to the system stack (`-apple-system`, Segoe UI, Helvetica, Arial, sans-serif). Install the font locally before rendering. Font file paths and URLs are rejected.

**Logo.** Point `brand.logo` at an svg or png (at most 256 KB, path relative to the repo root). It is embedded in the video and drawn on every scene in one corner, scaled to fit a box of at most 360 px wide by 96 px high (1080p frame), aspect ratio kept. To replace it, change the file or the path; to move it, set `logoPosition`; to remove it, delete the `logo` key. Bottom corners sit above the captions bar.

**Voice.** Pick the provider with `provider` (or `--provider`, or `--no-voice` for captions only). To choose a voice, run `pnpm ve:voices` (add `--search <text>`; it lists your ElevenLabs account; openai voices are alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer, verse, marin, cedar), then either pass `--voice <id>` to both `ve:gate` and `ve:synth`, or save it as `voice` in `.windower.json`. `--model <id>` works the same way. Precedence: flag, then `.windower.json`, then the provider default. Changing voice or model bills again. API keys come from the environment only, never from this file.

**Modes.** A mode controls only the output: length, scene count and detail. Research is identical in every mode, with no caps: `quick` still explores the slice fully and writes the full cited brief, then picks the highest-signal points at storyboard time.

| Mode     | Target length | Hard limits | Scenes | Narration words |
| -------- | ------------- | ----------- | ------ | --------------- |
| `quick`  | ~30 s         | 20-45 s     | 3-5    | 60-90           |
| `normal` | 70-90 s       | 55-110 s    | 6-10   | 180-240         |
| `deep`   | 120-360 s     | 90-600 s    | 10-40  | 330-1000        |

Pick one with `--mode quick|normal|deep` or words such as "quick" or "deep dive"; the default is `normal` (or `defaultMode` from `.windower.json`). The storyboard records it in an optional `mode` field (absent means `normal`). **Deep mode and credits:** with a voiced provider (elevenlabs or openai) a deep video consumes many API credits, so the approval gate warns and requires explicit confirmation (`ve:gate --approve --confirm-credits`). Silent and piper runs are unaffected.

**Chapters (deep videos).** Scenes take an optional `chapter` label (max 40 chars); consecutive scenes sharing a label form a chapter, and a label may not reappear later (validator error). The validator suggests chapters for deep videos over 150 s, and warns if they are used outside deep mode. The approval gate shows per-chapter scenes, seconds and narration characters, plus each chapter's credit share when voiced, and a frame-count note for videos over 150 s. Synthesis is cached per scene (provider, voice, model, text and neighboring narration), so editing one scene re-synthesizes only it and its two neighbors; other chapters reuse their audio and use no credits.

**Per run, in the request.** The audience (`onboarding`, `pr-review`, `stakeholder`, `docs`) and the mode are inferred from your request, so say them in plain words ("a quick stakeholder video", "a deep dive for onboarding") or pass `--mode quick|normal|deep` to `/explain-video`. With no signal the mode is `normal`. The storyboard is built from seven scene types (see `skills/windower/references/scene-catalog.md`) and you review it at the approval gate; ask for edits there before rendering.

**Not customizable.** Scene layout and design, caption style, transition duration (12 frames; only the per-scene `fade`, `slide` or `none` choice is set in the storyboard), fonts from files or URLs, background music (the only audio is narration), size (1920x1080, 16:9), frame rate (30 fps), and lengths outside the mode limits below.

## Troubleshooting

Run `pnpm ve:doctor` (from the plugin directory). It checks Node, ffmpeg/ffprobe, the Headless Shell cache, a free port, disk space and the chosen TTS provider, and prints a concrete fix per failure. A warning that port 3000 is in use is harmless: the render wrapper picks a free port. Use `--provider <id>` to check one provider, `--no-voice` to skip voice checks. `pnpm ve:render` exit 3 means run the doctor; exit 5 is a render error, see its output tail.

## Development

```
pnpm install
pnpm check          # typecheck, lint, format, tests
pnpm ve:doctor      # preflight the render environment
pnpm ve:render Hello  # first render of the sample composition, writes template/out/hello.mp4
```

`ve:render` uses the Headless Shell found by `ve:doctor`. Scripts live in `scripts/`, the framekit project in `template/`, the skill in `skills/windower/`.

## Limits

- 16:9 output only (9:16 is on the [backlog](BACKLOG.md)).
- Video length depends on the mode: about 30 s (`quick`), 70-90 s (`normal`), 120-360 s target and 600 s maximum (`deep`).
- No background music in v1.
- Narration timing uses reading-speed estimates, not word-level alignment.

## License

framekit is MIT licensed; windower renders with framekit only and installs no third-party renderer code.

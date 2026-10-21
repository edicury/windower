# windower

A Claude Code plugin that turns a slice of a software system (a module, feature, PR, ticket or doc) into a short, captioned explainer video of 60-120 seconds. Claude reads the code, git history and any connected MCP source (Notion, Linear, Slack, ...), writes a cited brief and a validated storyboard, waits for your explicit approval, then renders an mp4 with captions using framekit, a programmatic React video renderer (headless Chromium capture, ffmpeg encode).

[![Watch Windower explain itself (about 2 minutes, with narration)](https://media.windower.io/explainer-poster.jpg)](https://media.windower.io/explainer.mp4)

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

In the repository you want to explain:

```
/explain-video the checkout retry logic --audience onboarding
```

The slice can be paths, a symbol, a feature description, a PR number or URL, or a link to a ticket or doc. The audience is one of `onboarding`, `pr-review`, `stakeholder`, `docs`. Output lands in `.windower/<slug>/`, with the video at `out/video.mp4` and captions as `out/captions.srt` and `out/captions.vtt`.

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
| `silent`     | none (captions only)                                |

- Keys come from your shell environment only. They are never read from `.windower.json` and never written to disk.
- The provider is resolved from `.windower.json`, then available keys, then falls back to silent.
- `pnpm ve:voices` lists the voices on your ElevenLabs account; pass the chosen id with `--voice <id>` (and `--provider`, `--model`) to `ve:gate` and `ve:synth`, or persist it in `.windower.json`.
- Cost is driven by the number of characters in the narration. The gate shows the character count; windower makes no price claim, so check your provider's current pricing.
- Changing voice or model bills again.

## Privacy

- Only the narration text is sent to the TTS provider you approve. Code, briefs, images and everything else stay on your machine. With `silent` or `piper`, nothing leaves at all.
- The approval gate states this and names the provider before anything is sent.
- Briefs are scanned for secrets, key-shaped strings, `.env` values and emails/phone numbers before the storyboard is written; `.env*`, `*.pem` and `id_rsa*` files are never quoted in code scenes.
- Generated artifacts live in `.windower/` in your repo. Add it to `.gitignore`. Windower never commits anything.
- MCP sources you connect are read by Claude as part of the normal Claude Code session, under that tool's own data terms.

## Configuration

Optional `.windower.json` at the repository root:

```json
{
  "provider": "openai",
  "voice": "alloy",
  "model": "tts-1",
  "defaultLengthSec": 90,
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

- `provider`, `voice`, `model`: narration defaults (flags override the file, the file overrides provider defaults).
- `brand`: visual branding. `primary` and `background` (hex) are required; `accent`, `text` (hex), `font` (a family name, no network fetch, system fallback) and `logo` (svg or png up to 256 KB, path relative to the config file, shown on the title and outro scenes) are optional. A low text/background contrast prints a warning when preparing.
- `defaultLengthSec`: target length when the request does not specify one (60-120).

Never put API keys here; a field that looks like a secret is rejected. Unknown keys give a warning; invalid values stop with the field path.

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
- 60-120 seconds per video.
- No background music in v1.
- Narration timing uses reading-speed estimates, not word-level alignment.

## License

framekit is MIT licensed; windower renders with framekit only and installs no third-party renderer code.

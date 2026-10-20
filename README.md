# windower

Claude Code plugin: turn a slice of a software system (code plus Notion, Linear or GitHub context) into a 60-120 s captioned explainer video, rendered with Remotion, with optional ElevenLabs narration.

```
/plugin marketplace add edicury/windower
/plugin install windower@windower
```

Status: phase 0 (foundations) built; see `specs/001-windower-v1/STATUS.md`.

## Development

```
pnpm install
pnpm check        # typecheck, lint, format, tests
pnpm ve:doctor    # preflight the render environment
pnpm ve:render Hello
```

## Licensing

Remotion is free for individuals and companies of up to 3 people; larger companies need a Remotion company license (https://remotion.dev/license).

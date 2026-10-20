# Eval protocol (release gate G6-1)

Run `/explain-video` on three different repositories, score each run with `ve:eval`, and record the results.

## The three repos

1. This repo (windower): slice such as "how timing computes scene durations".
2. A small TypeScript service (an HTTP API or worker, a few thousand lines).
3. A small Python service (FastAPI, Flask or a CLI package).

For each, from inside the target repo, ask for a 60-120 s onboarding video of one feature, approve the storyboard at the gate, and let it render. The run lands in `.windower/<slug>/`.

## Score each run

```bash
pnpm --silent --dir "$WINDOWER" ve:eval "$PWD/.windower/<slug>" [--repo "$PWD"] [--json]
```

It exits 0 on pass and 2 on fail, with one line per check:

- brief lints clean (every fact cited)
- storyboard validates with the brief
- every `file` source resolves to an existing file and line range, and every code-scene snippet matches the file verbatim
- no unredacted secrets in brief or storyboard
- total duration within 60-120 s
- approved flag and `approvedAt` set (the gate was shown before render)
- video duration within 1 s of timing (when `out/video.mp4` exists)

`--repo` defaults to the storyboard's `repoRoot`.

## Fact check (human, 5 claims)

`ve:eval` writes `<run>/eval-factcheck.md` with 5 scenes picked deterministically from the slug. Each has the narration and the cited code. Read them, fill the "Supported?" column with `yes` or `no`, then:

```bash
pnpm --silent --dir "$WINDOWER" ve:eval "$PWD/.windower/<slug>" --factcheck "$PWD/.windower/<slug>/eval-factcheck.md"
```

At least 4 of 5 must be yes. Two runs per repo are allowed (the storyboard may need one fix).

## Record

Add one row per repo to `completed.md` for G6-1: repo, slug, date, `ve:eval` result, fact-check score, total seconds, and whether the storyboard validated on the first or second try. G6-1 passes when all three repos pass every check.

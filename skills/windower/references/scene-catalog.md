# Scene catalog

Payload fields are flat on the scene object (the shipped Zod schema in `template/src/schema.ts` is authoritative). Unknown fields are rejected, so a typo is an error. Every scene also has the envelope below.

## Envelope (all scenes)

| Field            | Rule                                                                                                                                                                                                                                               |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`             | `s01`, `s02`, ... unique, in order                                                                                                                                                                                                                 |
| `type`           | one of the seven below                                                                                                                                                                                                                             |
| `narration`      | 8-60 words, plain text (see narration-style.md)                                                                                                                                                                                                    |
| `sources`        | `[{"kind": "file"\|"url"\|"git", "ref": "..."}]`; at least 1 on every scene except the first `title` and an `outro` (may be `[]`). `file` refs are `path:line` or `path:start-end`, repo-relative, in bounds, and must appear verbatim in brief.md |
| `minDurationSec` | optional, 2-20; floor for the scene length                                                                                                                                                                                                         |
| `transition`     | optional `fade` (default), `slide`, `none`                                                                                                                                                                                                         |

Storyboard: scene count and length follow the `mode` field (quick 3-5 scenes, ~30 s; normal 6-10, 70-90 s, the default when `mode` is absent; deep 10-40, 120-360 s, hard max 600 s). First scene is `title`, last is `title`, `bullets` (recap) or `outro`.

## title

`headline` (1-90 chars), `subtitle?` (<= 80), `badge?` (<= 24). Opening card; may repeat at the end.

## bullets

`heading` (1-60), `items` (2-5 strings, each <= 110 chars). Revealed in order. Budget: at most 8 wrapped lines in total (about 68 chars per line), so 5 long items will not fit; use 3-4 concise ones.

## code

`file` (repo-relative path), `language` (e.g. `typescript`, `python`, `json`), `startLine` (>= 1), `code` (verbatim text, <= 16 lines, <= 100 chars per line), `mode` (`plain` default, or `diff`), `focus?` (`[{"lines": [a, b], "at": 0-1}]`, line numbers are file line numbers: `startLine` + row index, inside the snippet), `caption?` (<= 100).

- `plain`: the validator re-reads `file` and compares; the snippet must match the file text exactly from `startLine`.
- `diff`: exactly one hunk; each line starts with `+`, `-` or a space; rows include removed lines for numbering; use real hunks from `git diff`.
- Tab-indented source (Go, older JS) renders each tab as a wide indent, so deeply nested code can run past the frame edge visually even though it passes the 100-character limit; prefer ranges with shallow nesting, or switch to a spaces-indented range. Copy the tabs verbatim, do not convert them.
- Never use `.env*`, `*.pem`, `id_rsa*` or other secret files. Strip nothing silently: if a line must go, pick a different range. Real code often has a line over 100 chars (long comments, signatures): start the snippet below it. The brief and `sources[].ref` may still cite the wider range as long as the same text appears verbatim in the brief.

## architecture

`title` (1+), `nodes` (2-9: `id`, `label` <= 20, `sub?` <= 30, `kind` one of `service|db|queue|client|external|module`, `group?` <= 20), `edges` (1-12: `from`, `to` node ids, `label?` <= 24), `flow?` (`[{"path": [ids, at least 2], "at": 0-1}]`).
Layout is automatic, row-major on a grid: 2 nodes use 2 columns, 3 use 3 columns, 4 use a 2x2 grid, 5-9 use 3 columns. **Edges may only join orthogonally adjacent grid cells** (left/right/up/down). Order `nodes` so connected nodes are neighbours, or route through an intermediate node. Example: for 4 nodes `[a, b, c, d]` on a 2x2 grid, `a-b`, `c-d`, `a-c`, `b-d` are valid; `a-d` and `b-c` are not.

## sequence

`title` (<= 60), `participants` (2-5 names, each <= 18), `messages` (2-8: `from` and `to` are **participant indexes** (0-based, must differ: self-messages, a participant messaging itself, are unsupported; use a separate participant or a note on another message), `text` <= 40, `note?` <= 36). No `note` on a message that ends at the rightmost participant.

## timeline

`title` (<= 60), `items` (3-7: `label` <= 24, `detail?` <= 80, `when?` <= 20), `orientation?` (`horizontal`). Revealed left to right.

## outro

`headline` (<= 90), `subtitle?` (<= 80), `items?` (<= 3, each <= 60). Closing card with takeaway chips; `sources` may be empty.

## Choosing a type

- Concept list or recap: `bullets`. Exact behaviour in 16 lines or less: `code`. Who talks to whom: `architecture` (static structure) or `sequence` (order over time). History, rollout, or ordered steps: `timeline`.
- Do not use a code scene for config or secrets; summarise those in `bullets`.

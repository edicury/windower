# Storyboard authoring

Write `$RUN/storyboard.json` from the redacted brief. The shipped Zod schema is authoritative; payloads and limits are in scene-catalog.md, narration rules in narration-style.md.

## Principles (FR-SB-02)

1. **One idea per scene.** If a scene needs "and" to describe it, split it. A viewer should be able to state each scene's point in a sentence.
2. **Every scene is cited.** `sources` has at least one entry on every scene except the first `title` and an `outro`. Cite the narrowest range that supports the scene; the same range must appear in brief.md verbatim. A scene with no fact in the brief should not exist.
3. **Show, then say.** Pick the scene type that shows the idea (code for exact logic, sequence for order, architecture for structure, bullets for takeaways). Narration explains; it does not recite the screen.
4. **Arc.** Title (what and why you care), content scenes (count set by the mode) in the order a newcomer needs them (overview, core flow, one or two code close-ups, edge cases or gotchas), then a recap `bullets` or `outro`.
5. **Verbatim code.** Code scene text is copied from the file, not retyped from memory: re-read the lines just before writing. Do not "tidy" it.
6. **Name.** Write the product name lowercase, `windower`, in `title`, headlines, narration and captions (`ve:validate` warns on `Windower`).
7. **Do not invent.** Every claim traces to a brief fact. If you are unsure, leave it out or say so in "Open questions".

## Length budget

- Silent duration per scene: `max(words / 2.9 + 0.9 s, minDurationSec or 4 s)`, a scene above 20 s only draws a warning. Total = sum of scenes minus 0.4 s per fade/slide transition (none = hard cut, no overlap), and must be inside the mode's hard limits (error outside) and should be inside its target range (warning outside); see the table below.
- Mode budgets (authoritative values in `template/src/modes.ts`). Words per second is 2.9, so budget words = target seconds x 2.9, less a little for per-scene padding:

| Mode     | Target    | Hard limits | Scenes | Narration words | Per-scene soft cap |
| -------- | --------- | ----------- | ------ | --------------- | ------------------ |
| `quick`  | 25-35 s   | 20-45 s     | 3-5    | 60-90           | 10 s               |
| `normal` | 70-90 s   | 55-110 s    | 6-10   | 180-240         | 20 s               |
| `deep`   | 120-360 s | 90-600 s    | 10-40  | 330-1000        | 25 s               |

- Set `mode` explicitly, then compute the word budget before writing a scene. Research is the same in every mode; for `quick`, choose the few highest-signal facts from the full brief and drop the rest rather than cramming.
- Plan (normal): scenes x 25-45 words. Examples: 7 scenes at 35 words is about 90 s; 5 scenes at 40 words is about 70 s.
- Calibration from a real run: 8 scenes at 31-42 words each came to 112.6 s, because every scene costs 12-16 s. For a normal-mode 80 s target plan 6-7 scenes, and keep narration of title/outro scenes near 25 words.
- A scene `sources` ref must appear verbatim in brief.md, but need not be one brief fact's whole range: a code scene covering lines 71-85 may cite the three sub-ranges 71-75, 75-78 and 79-85 listed in the brief. Cite sub-ranges the brief already lists rather than adding a new one at the last minute.
- Too long: cut a scene or shorten narration. Too short: add a scene with a new cited idea, not filler. Use `minDurationSec` only to give a dense visual (large code or diagram) time to be read, up to 20.
- Scene count: set by the mode (quick 3-5, normal 6-10, deep 10-40).
- Chapters (optional, for deep videos over about 150 s): give scenes a `chapter` label (<= 40 chars). Consecutive scenes with the same label form one chapter; a label must not reappear after another chapter (error). Using chapters outside deep mode only warns. The gate lists per-chapter seconds, narration characters and credit share. Audio is cached per scene, so editing one scene re-synthesizes only it and its two neighbors (their narration is context); keep edits inside one chapter to avoid spending credits elsewhere.

## Top-level fields

`version: 1`, `slug` (use the run dir's basename, which `ve:status init` prints; the validator does not enforce it, but keep them equal, `^[a-z0-9-]{1,48}$`), `title` (<= 80), `audience` (`onboarding|pr-review|stakeholder|docs`), `repoRoot` (the repo being explained, relative to the run dir; for `.windower/<slug>/` in the repo root that is `"../.."`. When the repo you are explaining is somewhere else, for example a clone you were pointed at, use its absolute path; the validator accepts it), optional `mode` (`quick|normal|deep`; absent means normal), optional `targetSec`, `approved: false` (the gate sets it true; never set it yourself). Omit `fps` and `size`; defaults apply.

## Limits at a glance

| Scene         | Key limits                                                                                                                                                                                         |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| any           | narration 8-60 words, plain text; ids `s01..`; sources per rule above                                                                                                                              |
| title / outro | headline <= 90, subtitle <= 80; title badge <= 24; outro items <= 3 x 60                                                                                                                           |
| bullets       | heading <= 60; 2-5 items x <= 110; <= 8 wrapped lines total                                                                                                                                        |
| code          | <= 16 lines x <= 100 chars; one diff hunk; verbatim; focus inside snippet; caption <= 100                                                                                                          |
| architecture  | 2-9 nodes, 1-12 edges, label <= 20, sub <= 30, edge label <= 24, adjacent grid cells only                                                                                                          |
| sequence      | 2-5 participants x <= 18; 2-8 messages, text <= 40, note <= 36; indexes valid and `from` != `to` (no self-messages: use a separate participant or a note); no note ending at rightmost participant |
| timeline      | 3-7 items; label <= 24, detail <= 80, when <= 20                                                                                                                                                   |

## Fixing validator findings

Each finding is `scene <id> - <field>: <message> [<rule>]`. Fix exactly that field and rerun; do not rewrite unrelated scenes. After three failed automatic rounds stop and ask the user.

## Editing after the gate

If the user asks for changes, edit the JSON in place (keep their other edits), set `"approved": false`, validate, and show the gate again.

## Worked example

The brief for this storyboard is the example in workflow.md. It validates (7 scenes, about 78 s) against `fixtures/repos/sample` in the plugin repo; `test/skill-docs.test.ts` checks it on every run.

```json
{
  "version": 1,
  "slug": "greeter-tour",
  "title": "How the greeter module works",
  "audience": "onboarding",
  "repoRoot": "../..",
  "targetSec": 75,
  "approved": false,
  "scenes": [
    {
      "id": "s01",
      "type": "title",
      "headline": "How the greeter module works",
      "subtitle": "Three small functions in src/greeter.ts",
      "badge": "Onboarding",
      "narration": "This short video explains the greeter module: what it exports, how one greeting is built, and how the command line entry point ties it together.",
      "sources": []
    },
    {
      "id": "s02",
      "type": "bullets",
      "heading": "What the module exports",
      "items": [
        "greet builds one greeting line for a single person",
        "greetAll maps a list of names to a list of greetings",
        "main reads names from the command line and prints them"
      ],
      "narration": "The module exports three functions. The first builds a greeting for one person. The second applies it to a whole list of names. The third is a small entry point that prints the results.",
      "sources": [
        {
          "kind": "file",
          "ref": "src/greeter.ts:6-22"
        }
      ]
    },
    {
      "id": "s03",
      "type": "code",
      "file": "src/greeter.ts",
      "language": "typescript",
      "startLine": 6,
      "code": "/** Builds the greeting line for a person. */\nexport function greet({name, excited = false}: GreeterOptions): string {\n  const base = `Hello, ${name}`;\n  return excited ? `${base}!` : `${base}.`;\n}",
      "focus": [
        {
          "lines": [7, 8],
          "at": 0.2
        },
        {
          "lines": [9, 9],
          "at": 0.6
        }
      ],
      "mode": "plain",
      "caption": "The excited flag only changes the final punctuation.",
      "narration": "The greet function destructures its options. The name is required and the excited flag defaults to false. The last line picks an exclamation mark or a plain full stop.",
      "sources": [
        {
          "kind": "file",
          "ref": "src/greeter.ts:6-10"
        }
      ]
    },
    {
      "id": "s04",
      "type": "sequence",
      "title": "Running the command line entry point",
      "participants": ["Shell", "main", "greetAll", "greet"],
      "messages": [
        {
          "from": 0,
          "to": 1,
          "text": "node greeter Ada Linus"
        },
        {
          "from": 1,
          "to": 2,
          "text": "greetAll(names)"
        },
        {
          "from": 2,
          "to": 3,
          "text": "greet({name}) per name"
        },
        {
          "from": 3,
          "to": 2,
          "text": "greeting line"
        },
        {
          "from": 1,
          "to": 0,
          "text": "console.log each line"
        }
      ],
      "narration": "When you run the program with names, main passes them to greetAll. That calls greet once per name, collects the lines, and main prints each one to the console.",
      "sources": [
        {
          "kind": "file",
          "ref": "src/greeter.ts:13-22"
        }
      ]
    },
    {
      "id": "s05",
      "type": "architecture",
      "title": "How the pieces call each other",
      "nodes": [
        {
          "id": "main",
          "label": "main",
          "sub": "Command line entry",
          "kind": "module"
        },
        {
          "id": "all",
          "label": "greetAll",
          "sub": "Maps names to lines",
          "kind": "module"
        },
        {
          "id": "out",
          "label": "console",
          "sub": "Prints each line",
          "kind": "external"
        },
        {
          "id": "greet",
          "label": "greet",
          "sub": "Builds one greeting",
          "kind": "module"
        }
      ],
      "edges": [
        {
          "from": "main",
          "to": "all",
          "label": "names"
        },
        {
          "from": "all",
          "to": "greet",
          "label": "one name"
        },
        {
          "from": "main",
          "to": "out",
          "label": "lines"
        }
      ],
      "flow": [
        {
          "path": ["main", "all", "greet"],
          "at": 0.3
        }
      ],
      "narration": "Seen as a diagram, main sits at the edge. It hands names to greetAll, which delegates each one to greet, and main alone talks to the console. Nothing else has side effects.",
      "sources": [
        {
          "kind": "file",
          "ref": "src/greeter.ts:13-22"
        }
      ]
    },
    {
      "id": "s06",
      "type": "bullets",
      "heading": "Design choices worth noticing",
      "items": [
        "Options are an object, so new flags never break callers",
        "The excited flag defaults to false, so the plain form is the default",
        "greetAll uses map, so the input array is never modified",
        "Only main prints; the other functions return strings"
      ],
      "narration": "A few choices are worth noticing. Options are an object, so new flags will not break callers. The excited flag defaults to false. greetAll uses map, so it never changes its input, and only main prints.",
      "sources": [
        {
          "kind": "file",
          "ref": "src/greeter.ts:1-22"
        }
      ]
    },
    {
      "id": "s07",
      "type": "outro",
      "headline": "Small functions, one clear job each",
      "subtitle": "Start reading at src/greeter.ts",
      "items": ["greet builds one line", "greetAll maps over names", "main prints the result"],
      "narration": "That is the whole module. Each function does one job, so you can read it top to bottom in a couple of minutes. Start with greet and work outward from there.",
      "sources": [
        {
          "kind": "file",
          "ref": "src/greeter.ts:1-22"
        }
      ]
    }
  ]
}
```

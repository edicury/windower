---
description: Create a captioned explainer video for a slice of this repository (code, PR, or ticket)
argument-hint: <slice description> [--mode quick|normal|deep] [--audience onboarding|pr-review|stakeholder|docs]
---

Use the `windower` skill to create an explainer video.

Request: $ARGUMENTS

The request is a description of the slice to explain (paths, a symbol, a feature, a PR number or URL, or a ticket or doc link), optionally followed by the audience (`onboarding`, `pr-review`, `stakeholder` or `docs`, also accepted as `--audience <name>`), and optionally a mode: `--mode quick|normal|deep` or plain words ("quick", "deep dive"); if none is given and no `defaultMode` is configured, ask the one-line three-mode question from the skill (default `normal` if unanswered). The mode controls only the output length and detail; research is identical in every mode. In deep mode with a voiced provider, warn about API credit use and require explicit confirmation at the gate. If no slice was given, ask what to explain. Follow the skill's staged workflow: init or resume `.windower/<slug>/` (created under the current working directory; prefer a scratch directory and treat the repo being explained as a read-only source by absolute path), gather and cite, write the brief, redact, author and validate the storyboard, then stop at the approval gate and wait for an explicit approval before any render.

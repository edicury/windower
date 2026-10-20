---
description: Create a captioned explainer video for a slice of this repository (code, PR, or ticket)
argument-hint: <slice description> [--audience onboarding|pr-review|stakeholder|docs]
---

Use the `windower` skill to create an explainer video.

Request: $ARGUMENTS

The request is a description of the slice to explain (paths, a symbol, a feature, a PR number or URL, or a ticket or doc link), optionally followed by the audience (`onboarding`, `pr-review`, `stakeholder` or `docs`, also accepted as `--audience <name>`). If no slice was given, ask what to explain. Follow the skill's staged workflow: init or resume `.windower/<slug>/`, gather and cite, write the brief, redact, author and validate the storyboard, then stop at the approval gate and wait for an explicit approval before any render.

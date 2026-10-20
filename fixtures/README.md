# Fixtures

Storyboards and sample code used by tests. See `specs/001-windower-v1/testing.md` §2.

- `storyboards/minimal.json`: valid 8-scene title/bullets storyboard (about 101 s); the main render fixture.
- `storyboards/stress-over-limit.json`: over-limit scenes and referential negatives; `validate-storyboard` must reject every one naming the scene id and field.
- `storyboards/invalid-*.json`: one defect each (missing or empty sources, unknown type, bad version, unknown field, duplicate id, wrong first scene, short narration, missing source file, too short overall).
- `repos/sample/`: tiny repository the fixtures' `repoRoot` points at (`../repos/sample`, relative to the storyboard).

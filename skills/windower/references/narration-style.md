# Narration style

Narration is spoken text. It is also the caption source and the only text that can leave the machine for a TTS provider.

## Hard rules (validator rule R3)

- 8 to 60 words per scene (counted by whitespace). Aim for 25-45.
- Plain text only. No `<`, `>`, backticks, `*`, `#` or markdown links `](`. No code fences.
- Every scene has narration, including the title and outro.

## Spoken style

- Always write the product name lowercase, `windower`, in narration (and titles, headlines, captions). The validator warns on `Windower`.
- Write for the ear: short sentences, one idea per sentence, active voice, present tense ("greet builds the line").
- Say identifiers the way a person would read them: "greet all" is fine for `greetAll`; spell out symbols ("an exclamation mark", "a plain full stop"). Avoid reading long paths, line numbers, hashes or URLs aloud; they belong in `sources`.
- Narration and the on-screen text should agree but not duplicate: the screen shows the list, the voice explains why. Do not read bullets verbatim.
- Avoid abbreviations that read badly ("e.g.", "i.e.", "vs."), parentheses, and numerals with units where a word is clearer ("two", "a hundred").
- Signpost briefly ("First", "Next", "Finally") so scene transitions feel connected. Open scene 1 with what the viewer will learn; close with the takeaway.
- No marketing tone, no filler ("as you can see"), no claims that are not in the brief.

## Timing

Silent timing is `max(words / 2.9 + 0.9 s, 4 s)` per scene (a scene above 20 s only draws a validator warning; nothing caps it), so 8 words is about 4 s and 45 words about 16 s. The video length is the sum minus 12 frames (0.4 s) for every fade or slide into a scene, so it runs a few seconds shorter than the plain sum (7 scenes: about 2.4 s); keep it within the mode's target range (quick ~30 s, normal 70-90 s, deep 120-360 s). Word budget is target seconds x 2.9: quick 60-90 words, normal 180-240, deep 330-1000. In `quick` aim for the short end of the 8-60 per-scene range (about 15-25 words); a deep run's voiced narration consumes many API credits, so keep every sentence earning its place.

## Before and after

- Too markup-y: `The **greet** function returns a \`string\`.` (rejected: markup)
- Better: `The greet function returns one line of text, built from the name and the excited flag.`

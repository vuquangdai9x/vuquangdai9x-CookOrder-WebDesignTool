# UI & Visual Design Summary

Aesthetic hook craft (how visual/audio identity reinforces a core verb), key art composition, capsule/thumbnail design, UI readability at a glance (critical for short-session live-ops play).

**Used by:** `Skills/01-idea-refinement/anchor-concept-aesthetic-hook`, `Skills/01-idea-refinement/concurrent-prototyping`, `Skills/01-idea-refinement/market-research-premium`, `Skills/02-architecture/lean-gdd-store-optimization-premium`.

## Key Insights from Processed References

Reference chain for this topic: this summary → `../../../lookup/<slug>.md` (compact, section-cited) → `../../../learned/<slug>.md` (full detailed notes). Query with `node ../../../scripts/kb.js get <slug> "<query>"` rather than reading the files directly — see `../../../lookup/_SPEC.md`.

**CRAP, applied to a HUD.** Robin Williams's *Non-Designer's Design Book* reduces layout to four checkable principles. Proximity: group related readouts tightly, separate unrelated ones — equal spacing everywhere erases grouping cues. Alignment: build on an explicit shared grid; mixing several alignment schemes is the single most common cause of an amateurish layout. Repetition: enforce one consistent icon frame, color-coding, and type treatment across every screen so learned meaning transfers instantly. Contrast: make important states really different (stack multiple contrast axes at once) — weak contrast reads as a bug, not a signal. Two colors of similar tone will visually merge regardless of hue difference, which is why HUD text over busy backgrounds usually needs an outline or backing plate. → `../../../lookup/williams-non-designers-design-book.md`

**Weight and contrast beat size for hierarchy.** Wathan & Schoger's *Refactoring UI* argues font weight and color/contrast — not size — is the biggest hierarchy lever, directly applicable to HUD elements where weight/contrast should carry emphasis size alone can't. Build one shared system (fixed type scale, spacing scale, HSL color ramps with 8-10 shades each) across menu, HUD, and store screens rather than letting each screen invent its own values. Never use color alone to signal rarity or faction — always pair with an icon or shape for colorblind accessibility. Treat an empty inventory or unstarted quest log as a first impression worth designing, not an afterthought. → `../../../lookup/wathan-schoger-refactoring-ui.md`

**Light stacks and consistent value intervals for key art.** Gurney's *Color and Light* treats believable lighting as 2-3 subordinate systems (key + soft fill + weak bounce) rather than one flat light — the fastest diagnostic when a scene reads arbitrary. Keep the light/shadow value interval constant across surfaces; use contact shadows deliberately wherever forms meet (the equivalent of ambient occlusion). Model distance as lightening/desaturating/cooling (aerial perspective). Favor perceptually-familiar color over physically-correct color — "moonlight is blue" reads as more truthful than accurate. Color-script a full level or sequence in advance to keep spaces distinct and emotionally paced, and spend saturated color sparingly against a mostly neutral backdrop. → `../../../lookup/gurney-color-and-light.md`

**Blocked**: *Grid Systems in Graphic Design* (Josef Müller-Brockmann) — the local PDF is an image-only scan with zero extractable text (filename's own "no_OCR" flag was accurate) and no OCR tooling is available in this environment; not processed. See `../../../PROGRESS.md`.

## Recommended Reading

- ✅ *The Non-Designer's Design Book* — Robin Williams — processed, see above
- ✅ *Refactoring UI* — Adam Wathan & Steve Schoger — processed, see above
- ✅ *Color and Light: A Guide for the Realist Painter* — James Gurney — processed, see above
- 🚫 *Grid Systems in Graphic Design* — Josef Müller-Brockmann — blocked, OCR needed (see above)
- *Universal Principles of Design* — Lidwell, Holden, Butler — not locally available, see `../../../../../references/README.md`

## Glossary

- `crap` → `../../../dictionary/art/ui-visual-design.json`
- `contact-shadow` → `../../../dictionary/art/ui-visual-design.json`
- `aerial-perspective` → `../../../dictionary/art/ui-visual-design.json`
- `ambient-occlusion` → `../../../dictionary/art/ui-visual-design.json`
- `capsule` → `../../../dictionary/art/ui-visual-design.json`
- `key-art` → `../../../dictionary/art/ui-visual-design.json`
- `color-script` → `../../../dictionary/art/ui-visual-design.json`

## Local Reference

- [`../../../source/art.md`](../../../source/art.md) § **UI / Visual Design** — distilled core principles, working heuristics, common-case playbooks, and failure modes for this field. Read this before the reference books: it's the fast path for common cases.

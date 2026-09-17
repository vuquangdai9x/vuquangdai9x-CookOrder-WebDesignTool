# UX Summary

Onboarding/FTUE design, cognitive load management, readability at a glance (esp. short-session live-ops UI), accessibility standards, moment-to-moment feedback/juice.

**Used by:** `Skills/01-idea-refinement/anchor-concept-aesthetic-hook`, `Skills/01-idea-refinement/concurrent-prototyping`.

## Key Insights from Processed References

Reference chain for this topic: this summary → `../../../lookup/<slug>.md` (compact, section-cited) → `../../../learned/<slug>.md` (full detailed notes). Query with `node ../../../scripts/kb.js get <slug> "<query>"` rather than reading the files directly — see `../../../lookup/_SPEC.md`.

**Design for the felt experience, not the artifact.** Schell's *Art of Game Design* holds that every mechanic and screen is judged by the subjective feeling it produces, so UX work should name the target feeling before touching implementation. His "elemental tetrad" (mechanics, story, aesthetics, technology) is a fast holistic-audit tool for a flow that feels off — check whether one quadrant is starving the others. The "interest curve" (hook, rising peaks with rest dips, climax, resolution) applies fractally to a whole product, a single screen, or one micro-interaction. Indirect control — shaping behavior via constraints, goals, and framing rather than walls — lets players feel free while still being steered. Above all: prototype cheaply to test one risky assumption before investing in polish ("the Rule of the Loop" — no amount of upfront theorizing substitutes for watching real users). → `../../../lookup/schell-art-of-game-design.md`

**Self-evident beats explained, and the trunk test.** Krug's *Don't Make Me Think* argues every screen should be self-evident or self-explanatory because users scan rather than read and satisfice rather than optimize. This favors plain, scannable labels over clever in-fiction naming, and unambiguous affordances for anything interactive, especially without cursor-hover. The "trunk test" (dropped into any random deep screen, can you instantly tell what it is, its siblings, and how to get home?) is a ready-made menu-tree audit — third-level-and-deeper screens chronically get the least design attention despite carrying real traffic. His usability-testing philosophy (cheap, frequent, small tests) settles internal design arguments better than opinion debate: "do players like radial menus" versus "can players hit their intended item under time pressure with this radial menu." → `../../../lookup/krug-dont-make-me-think.md`

**Affordances, signifiers, and the seven stages of action.** Norman's *Design of Everyday Things* is the foundational text nearly all game UX principles trace back to: a control's *affordance* is what it physically permits, its *signifier* is the perceivable cue telling the player that; a control with an affordance but no signifier is invisible, and a signifier without a real affordance is a lie the player will eventually catch (a "button" that does nothing). His seven stages of action (goal → plan → specify → execute → perceive → interpret → compare) is a systematic tool for diagnosing exactly where a UI flow breaks down — slips (wrong action, right intent) and mistakes (wrong intent) need different fixes: slips need better signifiers/constraints, mistakes need better conceptual models. → `../../../lookup/norman-design-of-everyday-things.md`

**Blocked**: *A Theory of Fun for Game Design* (Raph Koster) — the local PDF is an image-only scan with zero extractable text and no OCR tooling is available in this environment; not processed. See `../../../PROGRESS.md`.

**Design for the player's mental and emotional state, including moments without input.** Better multiplayer reduces coordination and re-entry friction while making social causality visible. Glyph systems need discriminable form, consistent grammar, redundancy, and contextual teaching. Coziness combines safety, abundance, and softness; passive engagement separates interaction cadence from agency; companion attachment is strengthened chiefly through personhood, value, stakes, and credible shared experience. → `../../../lookup/project-horseshoe-2010-r04-making-online-multiplayer-better.md`, `../../../lookup/project-horseshoe-2013-r03-non-pictographic-symbologies.md`, `../../../lookup/project-horseshoe-2017-r03-coziness-in-games.md`, `../../../lookup/project-horseshoe-2018-r04-designing-for-passive-engagement.md`, `../../../lookup/project-horseshoe-2018-r05-npc-companionship.md`

## Recommended Reading

- ✅ *The Art of Game Design: A Book of Lenses* — Jesse Schell — processed, see above
- ✅ *Don't Make Me Think* — Steve Krug — processed, see above
- ✅ *The Design of Everyday Things* — Don Norman — processed, see above
- 🚫 *A Theory of Fun for Game Design* — Raph Koster — blocked, OCR needed (see above)
- *100 Things Every Designer Needs to Know About People* — Susan Weinschenk — not locally available, see `../../../../../references/README.md`
- *Level Up!* — Scott Rogers — not locally available

## Glossary

- `elemental-tetrad` → `../../../dictionary/game-design/UX.json`
- `interest-curve` → `../../../dictionary/game-design/UX.json`
- `indirect-control` → `../../../dictionary/game-design/UX.json`
- `rule-of-the-loop` → `../../../dictionary/game-design/UX.json`
- `trunk-test` → `../../../dictionary/game-design/UX.json`
- `affordance` → `../../../dictionary/game-design/UX.json`
- `signifier` → `../../../dictionary/game-design/UX.json`
- `seven-stages-of-action` → `../../../dictionary/game-design/UX.json`
- `slip-vs-mistake` → `../../../dictionary/game-design/UX.json`
- `onboarding` → `../../../dictionary/common.json`
- `live-ops` → `../../../dictionary/common.json`

## Local Reference

- [`../../../source/game-design.md`](../../../source/game-design.md) § **UX** — distilled core principles, working heuristics, common-case playbooks, and failure modes for this field. Read this before the reference books: it's the fast path for common cases.

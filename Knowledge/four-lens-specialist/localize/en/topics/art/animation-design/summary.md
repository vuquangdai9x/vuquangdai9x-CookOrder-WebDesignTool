# Animation Design Summary

The classical 12 principles of animation (squash/stretch, anticipation, follow-through, timing) as applied to game feel and "juice", cutscene vs. gameplay/procedural animation trade-offs, rigging and blend-tree considerations a designer should know even if not doing the rigging, readability of animation at gameplay speed vs. cinematic speed.

**Used by:** `Skills/01-idea-refinement/concurrent-prototyping` (ux-lens "immediate input feedback" is largely an animation-timing problem), `Skills/01-idea-refinement/anchor-concept-aesthetic-hook` (animation is a core part of how the aesthetic hook actually reads in motion, not just in a still frame).

## Key Insights from Processed References

Reference chain for this topic: this summary → `../../../lookup/<slug>.md` (compact, section-cited) → `../../../learned/<slug>.md` (full detailed notes). Query with `node ../../../scripts/kb.js get <slug> "<query>"` rather than reading the files directly — see `../../../lookup/_SPEC.md`.

**Timing and spacing over pose quality.** Richard Williams's *Animator's Survival Kit* teaches animation as "the art of timing and spacing" — identical poses read as heavy, sneaky, or shocking purely from how frames are distributed between them. This gives a two-axis QA model for procedural/ML-driven motion: pose correctness and timing correctness are separable failure modes, and generated motion frequently has valid poses with wrong spacing. Checkable rules: the bouncing-ball spacing pattern (bunched near apex, wide near impact) is a unit test for anything gravity-driven; walks decompose into contact/down/passing/up poses with hip bob and shoulder/hip counter-rotation that retargeting onto stylized rigs commonly flattens; jumps need a held apex hang and landing-overshoot; directional reversals need a gather/deceleration pose rather than a hard crossfade; end-effector trajectories should form smooth arcs, not zigzags. Structurally: automate inbetweens aggressively but keep breakdown placement under human review; build personality variants as parameterized deviations from a base cycle rather than fully separate clips. The load-bearing warning: naive linear/eased interpolation is software's default failure mode (the opposite of hand-drawn animation's problem) — engines must deliberately reintroduce ease, arcs, overlap, and asymmetric timing, and raw mocap usually needs an animator polish pass before shipping. → `../../../lookup/williams-animators-survival-kit.md`

**Pre-production discipline and staged technical ambition.** Tony White's *Animation from Pencils to Pixels* (source copy in this repo only covers Development and early Character Design — flagged, not a full read) frames the logline as a comprehension test: if a concept can't compress to 1-3 sentences, it isn't understood well enough to greenlight. Its account of Pixar's staged ambition (toys, then insects) argues for matching creative scope to what a pipeline can actually deliver convincingly rather than chasing spectacle, and its cost analysis of dialogue-heavy/crowd scenes has a direct game analogue: unique rigs, VO lines, and crowd agents are a game's expensive-per-frame content, reserved for a few high-value moments. → `../../../lookup/white-animation-pencils-to-pixels.md`

## Recommended Reading

- ✅ *The Animator's Survival Kit* — Richard Williams — processed, see above
- ✅ *Animation from Pencils to Pixels* — Tony White — processed, see above (source copy incomplete past early Character Design)
- *The Illusion of Life: Disney Animation* — Frank Thomas & Ollie Johnston — not locally available, see `../../../../../references/README.md`

## Glossary

- `timing-and-spacing` → `../../../dictionary/art/animation-design.json`
- `walk-cycle-poses` → `../../../dictionary/art/animation-design.json`
- `apex-hang` → `../../../dictionary/art/animation-design.json`
- `gather-deceleration-pose` → `../../../dictionary/art/animation-design.json`
- `end-effector` → `../../../dictionary/art/animation-design.json`
- `inbetweens-and-breakdowns` → `../../../dictionary/art/animation-design.json`
- `logline` → `../../../dictionary/art/animation-design.json`

## Local Reference

- [`../../../source/art.md`](../../../source/art.md) § **Animation Design** — distilled core principles, working heuristics, common-case playbooks, and failure modes for this field. Read this before the reference books: it's the fast path for common cases.

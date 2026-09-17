---
title: "The Non-Designer's Design Book, 3rd Edition"
author: "Robin Williams"
source_pdf: "Knowledge/references/dispose/Non-Designers.Design.Book.3rd.Edition.pdf"
learned_file: "learned/williams-non-designers-design-book.md"
---

# The Non-Designer's Design Book — Lookup Summary

## Chapter: The Joshua Tree Epiphany — Naming the Four Principles
Williams argues that naming a design problem is the first step to fixing it, and introduces her core toolkit CRAP: Contrast, Repetition, Alignment, Proximity. Contrast means making different elements clearly different; Repetition means repeating a visual element to unify a piece; Alignment means every element visually connects to another; Proximity means grouping related items and separating unrelated ones. These four principles are meant to be used together and give non-designers a shared vocabulary for critiquing layouts, including game HUDs and menus.
→ see learned/williams-non-designers-design-book.md § Chapter: The Joshua Tree Epiphany — Naming the Four Principles

## Chapter: Proximity
Proximity means grouping related items physically close and separating unrelated ones, since closeness signals relationship to the eye. Williams warns that equal spacing between all elements is itself a proximity failure, and that "trapped" white space (identical gaps above and below an item) creates ambiguous ownership. She recommends applying proximity first, before the other three principles, since a page has to be organized into groups before contrast/repetition/alignment mean much.
→ see learned/williams-non-designers-design-book.md § Chapter: Proximity

## Chapter: Alignment
Alignment means every element connects visually to another element via a shared invisible line, rather than being placed arbitrarily. Centered alignment is soft and safe; flush-left/flush-right alignment creates a strong, confident edge the eye can lock onto. Her key rule is to pick one alignment scheme per piece and hold it consistently, since mixing several is a common cause of amateurish-looking layouts — and that any deliberate break from alignment should be bold, not timid.
→ see learned/williams-non-designers-design-book.md § Chapter: Alignment

## Chapter: Repetition
Repetition means consistently repeating some visual trait — a color, rule weight, bullet style, or spatial pattern — throughout a piece so it reads as one unified whole. It doesn't require exact repetition; "unity with variety" (same shape at different sizes/colors) still works as long as the connecting trait is recognizable. It matters most across multi-page or multi-screen work, letting a viewer instantly recognize that separate screens belong to the same system, though overusing an accent can backfire and stop reading as an intentional signal.
→ see learned/williams-non-designers-design-book.md § Chapter: Repetition

## Chapter: Contrast
Contrast means making genuinely different elements really different — in size, weight, color, shape, or texture — rather than weakly different, since weak contrast reads as an error rather than a choice. Contrast serves two purposes: drawing the eye to a page and establishing information hierarchy (what to look at first, second, last). Stacking multiple contrast axes on the same pair of elements (e.g., a headline that's both bigger and bolder) is more effective than relying on one axis alone.
→ see learned/williams-non-designers-design-book.md § Chapter: Contrast

## Chapter: Review — Applying All Four Principles Together
This chapter re-applies all four principles in sequence — proximity, then alignment, then repetition, then contrast — to a single example, showing how each pass compounds on the last. The recommended working order is to group first, add a shared structural line, unify with a repeated element, and only then punch up the focal hierarchy with contrast, since applying contrast to an ungrouped, unaligned layout doesn't fix the underlying disorganization. The chapter's meta-principle is "don't be a wimp": embrace deliberate asymmetry, blank space, and bold size differences rather than timid half-measures.
→ see learned/williams-non-designers-design-book.md § Chapter: Review — Applying All Four Principles Together

## Chapter: Using Color
Covers the traditional 12-hue color wheel and standard harmony relationships: complementary (opposite hues, strong contrast, use unevenly), triads (three evenly spaced hues), split-complement, analogous (neighboring hues), and shades/tints/tones for expanding any palette beyond juvenile pure primaries. Practical rules include that warm colors advance and demand attention even in small amounts while cool colors recede and need more area, and that colors with similar tone/brightness create weak, muddy contrast regardless of hue difference. It also notes RGB is correct for screen work (versus CMYK for print).
→ see learned/williams-non-designers-design-book.md § Chapter: Using Color

## Chapter: Extra Tips and Tricks — Applying CRAP to Real Layouts
A worked-example chapter applying CRAP to real collateral (business cards, flyers, newsletters, web pages) that yields cross-cutting production lessons: push supporting text smaller and true headlines larger than instinct suggests; avoid all-caps for body text since it's slower to read and takes more space; design multi-piece "packages" (or in games, HUD + pause menu + inventory) as one consistent system from the start; and treat white space as a first-class design element rather than empty space to be filled.
→ see learned/williams-non-designers-design-book.md § Chapter: Extra Tips and Tricks — Applying CRAP to Real Layouts

## Chapter: Type and Life — Concord, Conflict, and Contrast
Describes three relationships when multiple typographic elements appear together: Concord (one typeface family throughout — calm but potentially dull), Conflict (two similar-but-not-identical typefaces, which reads as a mistake), and Contrast (clearly different typefaces, her recommended default when combining more than one face). Her diagnostic for fixing a conflicting pair is to look for what's similar between them, not what's different, since the similarity is what causes the eye to expect sameness and register small differences as errors.
→ see learned/williams-non-designers-design-book.md § Chapter: Type and Life — Concord, Conflict, and Contrast

## Chapter: Categories of Type
Groups typefaces into six families — oldstyle, modern, slab serif, sans serif, script, and decorative — each with distinct structural traits (serif style, stroke contrast, stress). Her core safety rule is to never pair two faces from the same category, since shared underlying structure guarantees a Conflict relationship; pulling faces from different categories guarantees at least a baseline structural Contrast to build on.
→ see learned/williams-non-designers-design-book.md § Chapter: Categories of Type

## Chapter: Type Contrasts — Size, Weight, Structure, Form, Direction, Color
Breaks type contrast into six independently controllable axes — size, weight, structure, form, direction, and color (including typographic "gray value") — and stresses that combining several axes on the same pair of elements produces the strongest, least ambiguous result. Practical notes include that size/weight differences must be real jumps (not near-identical values), all-caps forces smaller point sizes and loses word-shape recognition, and varying typographic gray value helps dense text-heavy screens avoid reading as one undifferentiated block.
→ see learned/williams-non-designers-design-book.md § Chapter: Type Contrasts — Size, Weight, Structure, Form, Direction, Color

## Chapter: So, Does It Make Sense? — Design Process and Self-Critique
A closing exercise chapter reinforcing the book's method: before redesigning a piece, verbalize in words exactly which CRAP principle (or type-contrast axis) is being violated, since naming the specific problem produces more focused fixes than jumping straight to "make it prettier." Williams also endorses "productive theft" — studying admired layouts and adapting their structure to new content as a normal, legitimate professional practice.
→ see learned/williams-non-designers-design-book.md § Chapter: So, Does It Make Sense? — Design Process and Self-Critique

## Key Takeaways for Game UI Design
- Diagnose HUD/menu complaints using the CRAP checklist by name (contrast/repetition/alignment/proximity) instead of vague "feels off" critiques — it turns subjective taste calls into actionable, shared-vocabulary fixes. → learned/williams-non-designers-design-book.md § Chapter: The Joshua Tree Epiphany — Naming the Four Principles
- Cluster related HUD readouts (weapon icon + ammo + reload state) with tight spacing, and separate unrelated clusters (health vs. minimap) with larger gaps — uniform padding across all widgets destroys the grouping signal. → learned/williams-non-designers-design-book.md § Chapter: Proximity
- Build HUDs and menus on an explicit layout grid/anchor system with a small number of shared alignment lines (consistent margins, baselines) instead of free-floating, eyeballed per-widget offsets. → learned/williams-non-designers-design-book.md § Chapter: Alignment
- Enforce one consistent icon frame, color-coding scheme, and header type treatment across inventory, map, and dialogue screens so players transfer learned meaning instantly between screens — this is what "UI kits" structurally provide. → learned/williams-non-designers-design-book.md § Chapter: Repetition
- Make critical states (low health, danger warnings) unmistakably different from normal states — stack multiple contrast axes (color + scale + iconography) rather than a single weak shift, since ambiguous warnings get missed mid-gameplay. → learned/williams-non-designers-design-book.md § Chapter: Contrast
- When polishing a HUD or menu, work in this order: group elements (proximity), align them to a shared grid (alignment), unify visual language across screens (repetition), then punch up critical-info contrast — don't jump straight to "add more contrast/juice" on an ungrouped screen. → learned/williams-non-designers-design-book.md § Chapter: Review — Applying All Four Principles Together
- Use color-wheel harmonies (split-complement, triad, analogous) to generate coherent faction/rarity/accent palettes quickly, and always pair a HUD color against its likely background for tone/brightness similarity, not just hue difference — near-tone colors merge into illegibility regardless of hue, which is why HUD text often needs outlines or backing plates. → learned/williams-non-designers-design-book.md § Chapter: Using Color
- Keep secondary/ambient HUD text (timestamps, buff durations, currency deltas) genuinely small and reserve real size jumps for what needs first-read priority; avoid all-caps in body-length tooltip/quest text and design HUD + pause menu + inventory as one system from project start. → learned/williams-non-designers-design-book.md § Chapter: Extra Tips and Tricks — Applying CRAP to Real Layouts
- When pairing a display font (titles/logos) with a body/UI font (labels/numbers), pull them from genuinely different type categories (e.g., sans serif UI font + slab serif or decorative display font) rather than two similar sans faces, which reads as an inconsistency bug instead of intentional hierarchy. → learned/williams-non-designers-design-book.md § Chapter: Categories of Type
- Default to one sans-serif family with a real weight range (light/regular/bold/black) for HUD/UI chrome for small-size legibility, and use genuine weight jumps — not near-identical medium/semibold pairs — to separate primary from secondary readouts. → learned/williams-non-designers-design-book.md § Chapter: Type Contrasts — Size, Weight, Structure, Form, Direction, Color
- Vary typographic "gray value" (weight/spacing/size together) on dense screens like inventories or skill trees so the list doesn't read as one undifferentiated wall of labels. → learned/williams-non-designers-design-book.md § Chapter: Type Contrasts — Size, Weight, Structure, Form, Direction, Color
- Before proposing a visual fix in a UI review, state in one sentence which CRAP principle or type-contrast axis is actually failing — this keeps design-critique documentation precise and actionable across artists and engineers. → learned/williams-non-designers-design-book.md § Chapter: So, Does It Make Sense? — Design Process and Self-Critique

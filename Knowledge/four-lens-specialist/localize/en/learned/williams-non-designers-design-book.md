---
title: "The Non-Designer's Design Book, 3rd Edition"
author: "Robin Williams"
source_pdf: "Knowledge/references/Non-Designers.Design.Book.3rd.Edition.pdf"
learned_file: "learned/williams-non-designers-design-book.md"
---

# The Non-Designer's Design Book — Learned Notes

Robin Williams' book teaches graphic design to non-designers through one core
toolkit: four principles she nicknames CRAP (Contrast, Repetition, Alignment,
Proximity), plus a second half on combining typefaces. The book is built almost
entirely from paired "before/after" redesigns of real-world print pieces
(business cards, newsletters, flyers, brochures, résumés, postcards, ads). The
notes below distill the reasoning behind those redesigns and translate each
idea into terms useful for game UI/HUD layout, menu design, and diegetic text.

## Chapter: The Joshua Tree Epiphany — Naming the Four Principles

Williams opens with an anecdote: she couldn't see Joshua trees in her own
neighborhood until a field guide gave her the name for them — then she saw
them everywhere. Her thesis is that naming a design problem is the first step
to fixing it. Most bad layouts aren't bad because the person lacks taste; they
lack vocabulary for what's wrong. Once you can say "this fails at proximity"
or "this is a contrast problem," you can address it directly instead of
randomly nudging elements around.

The four principles, briefly:
- **Contrast** — if two elements aren't the same, make them clearly, obviously
  different (size, weight, color, texture, spacing, direction). Weak contrast
  reads as a mistake, not a choice.
- **Repetition** — repeat some visual element (a color, rule, bullet style,
  spatial pattern, typeface treatment) throughout a piece so it reads as one
  unified thing.
- **Alignment** — nothing sits on the page arbitrarily; every element lines up
  with some edge of another element, even across distance.
- **Proximity** — related items are grouped physically close together;
  unrelated items are separated. Closeness signals relationship.

These are not independent — a well-designed piece almost always uses all four
simultaneously, and Williams repeatedly reworks the same example piece by
piece, principle by principle, to show how they compound.

**Game UI/HUD framing:** CRAP is a ready-made diagnostic checklist for HUD and
menu critique. When a HUD "feels cluttered" or "feels amateurish" but it's
hard to say why, run it through the four questions: Is anything almost-but-
not-quite different (weak contrast)? Does every panel/icon style repeat
elsewhere, or is each screen inventing its own visual language (no
repetition)? Do elements share edges/baselines with a grid, or are they eyeballed
into place (no alignment)? Are related readouts (e.g. ammo count and weapon
icon) touching while unrelated ones (health and minimap) are also touching at
the same distance (no proximity signal)? Naming the failure is the first step
to a fix, exactly as in Williams' anecdote.

## Chapter: Proximity

Robin's Principle of Proximity: group related items close together so they
read as one visual unit; separate unrelated items so they don't imply a false
relationship. The core diagnostic is to squint at a layout and count how many
times your eye "stops" — each stop is a separate visual unit. More than
roughly three to five stops on a simple piece usually means related items
need to be grouped.

Key mechanics she demonstrates repeatedly:
- Equal spacing between *all* elements is itself a proximity failure — it
  makes everything look equally (un)related. Space should be smaller within a
  group and larger between groups.
- "Trapped" white space (e.g., identical gaps above and below a headline)
  makes it ambiguous whether the headline belongs to the text above or below.
  Space should be intentionally unequal to show ownership.
- Proximity is usually the *first* principle to apply — contrast, repetition,
  and alignment don't mean much on a page that isn't organized into groups
  yet.
- Grouping is an intellectual act before it's a visual one: you already know
  which pieces of information belong together (a title with its subtitle, a
  price with its item); the job is to make the physical layout match that
  mental model.

**Game UI/HUD framing:** Proximity is the direct ancestor of HUD "clustering."
A weapon icon, its ammo count, and its reload-state indicator should sit
tight together as one group, visually distinct from the health/armor cluster
on the other side of the screen, which is distinct again from the
minimap/objective cluster. A common HUD mistake mirrors Williams' equal-
spacing trap: laying out all HUD widgets in a uniform grid with identical
padding so nothing reads as "belonging together" — the player has to learn
groupings by rote rather than perceiving them instantly. Diegetic and
non-diegetic UI both benefit: dialogue text and the speaker's name/portrait
should be closer to each other than to the next unrelated line of UI (an
objective tracker, say). When in doubt, the fix is almost never "add a
border" — it's "adjust the gap."

## Chapter: Alignment

Robin's Principle of Alignment: nothing is placed on the page arbitrarily;
every element has a visual connection — an invisible shared line — with
something else on the page, even when physically far apart. The strength of
that connection depends on the alignment type:

- **Centered** alignment has a "soft" edge — the line is invisible and the
  result reads as safe, formal, sometimes dull. It's the default beginners
  reach for because it feels balanced, but it rarely produces a sophisticated
  look.
- **Flush left / flush right** alignment creates a hard, visible edge that the
  eye can lock onto, producing a stronger, more confident, more modern
  impression.
- **Justified** text (aligned on both sides) should only be used when the
  column is wide enough to avoid ugly, uneven word-gaps.

Her practical rule: pick **one** alignment for a piece and hold it. Mixing
centered, flush-left, and flush-right elements on the same layout is one of
the most common causes of an unpolished look, because it multiplies the
number of "invisible lines" the eye has to track and none of them reinforce
each other. Once alignments are consistently strong, you can deliberately
break one element out of alignment for emphasis — but a *deliberate*, bold
break reads as intentional, while a slight, timid misalignment reads as a
mistake ("don't be a wimp" about breaking a rule, or don't break it at all).

She also stresses aligning non-text elements: photos, rules (drawn lines),
icons, and text blocks should all share edges or baselines with something
else, not float at whatever position leaves "empty space."

**Game UI/HUD framing:** This is arguably the single highest-value principle
for HUD/menu layout. A HUD where health, stamina, minimap, quest tracker, and
hotbar all sit on independent, eyeballed positions with no shared margins or
baselines looks assembled ad hoc, even if every individual widget is well
designed. Establishing a small number of screen-edge alignment lines (a
consistent left margin, a consistent bottom safe-area baseline, icons that
share a vertical center with their numeric readouts) makes disparate widgets
read as one coherent system. It's also directly actionable for engines: build
the HUD on an explicit layout grid/anchors rather than free-floating
per-widget offsets, and treat "this icon is 3px off the shared baseline" as a
real bug, not a nitpick — a small misalignment reads as broken far more than
a large, deliberate one reads as a mistake.

## Chapter: Repetition

Robin's Principle of Repetition: repeat some aspect of the design — a bold
typeface, a rule weight, a bullet glyph, a color, a spatial pattern, a corner
treatment — consistently throughout a piece. Repetition is essentially
"consistency" pushed from an accidental habit into a conscious design tool.
It has two jobs: it unifies otherwise-separate parts into one recognizable
whole, and it gives the eye something to bounce back to, keeping attention on
the piece longer.

Key points:
- Repetition doesn't require repeating the *exact* same element — "unity with
  variety" is fine and often better: the same shape at different sizes,
  colors, or angles still reads as connected, as long as the connecting trait
  is distinct enough to recognize.
- It matters most in multi-page or multi-screen work: a reader should
  instantly know page 3 belongs to the same document as page 12 purely from
  shared visual DNA (page-number placement, rule weights, heading treatment),
  without reading the content.
- Existing "accidental" consistencies (same headline font every time, same
  bullet style) are the easiest starting point — the recommendation is to
  identify what you're already doing consistently and deliberately push it
  further/bolder so it reads as a design choice rather than a default.
- Overuse is a real failure mode: repeating an accent so much that it
  overwhelms rather than unifies (her analogy: one red accessory looks
  intentional, seven red accessories looks like a mistake).

**Game UI/HUD framing:** Repetition is what makes a HUD/UI system feel like a
system instead of a pile of separately designed screens. A consistent icon
frame shape, consistent color coding (e.g., always cyan for friendly
information, always the same corner-notch motif on panels), and a consistent
type treatment for headers across the inventory, map, and dialogue screens
let players transfer learned meaning from one screen to the next instantly.
This is also the underlying justification for "UI kits" and shared component
libraries in game dev — they are repetition enforced structurally. Watch for
the overuse failure mode too: HUD elements that are all bold, all glowing, all
outlined lose the ability to repetition-signal anything, because nothing
stands apart as the *exception* that repetition is supposed to set off.

## Chapter: Contrast

Robin's Principle of Contrast: "If two items are not exactly the same, then
make them different. Really different." Contrast is presented as the most fun
and most immediately eye-catching of the four principles, and it serves two
inseparable purposes: it draws the eye to the page/screen in the first place,
and it establishes an information hierarchy (what to look at first, second,
last).

The critical failure mode she hammers repeatedly is *weak* contrast — two
elements that are almost the same (12pt vs 14pt type, a 0.5pt vs 1pt rule,
dark brown vs black) don't read as a considered choice, they read as an
error. Her refrain is "don't be a wimp": if you're going to differentiate two
things, differentiate them enough that no one could mistake it for
inconsistency.

Contrast can be built from many independent axes (elaborated further in
Chapter 11): size, weight, color, shape, spacial density, texture, direction.
Effective contrast usually stacks several axes at once on the *same* pair of
elements (e.g., a headline that is both much larger and much bolder than body
text) rather than relying on a single weak axis alone.

Contrast also has a load-bearing relationship to hierarchy and scanning:
adding strong contrast to a heading or a pull-quote lets a reader skim a page
and get the gist without reading everything — which increases the odds they
read the rest.

**Game UI/HUD framing:** Contrast is the primary tool for HUD legibility and
priority signaling: a critical-health state should not be "slightly more red"
than the normal state, it should be unmistakably, aggressively different
(color shift, pulsing scale, added iconography) precisely because ambiguous
warning states get missed in the middle of gameplay. The same logic applies
to selection/focus states in menus (a selected item must be unmistakably
different from an unselected one — weak highlight contrast is a common
usability complaint in game menus), and to establishing HUD reading order:
the most important readout (often health or an active objective) should carry
more contrast than secondary readouts (ammo reserve, currency count) so the
eye's default landing spot matches actual priority.

## Chapter: Review — Applying All Four Principles Together

This chapter re-runs a single dull, centered report cover through all four
principles in sequence — proximity, then alignment, then repetition, then
contrast — showing how each pass compounds on the last rather than replacing
it. The practical takeaways for working method:

- Apply the principles roughly in that order when redesigning something:
  group first (proximity), then give the groups a shared structural line
  (alignment), then unify with a repeated element (repetition), then punch up
  the focal hierarchy (contrast). Trying to add contrast to an ungrouped,
  unaligned mess doesn't fix the underlying disorganization.
- A recurring quiz format in this chapter — spot the differences between a
  "before" and "after" and name which principle each fix addresses — reflects
  the book's core teaching method: naming the specific violated principle is
  what turns a vague "this looks off" into an actionable fix.
- Williams' meta-principle threaded through the whole review: "don't be a
  wimp" — don't be afraid of asymmetry, large blank space, extreme size
  differences, or bold graphic choices, as long as they're deliberate and
  reinforce the piece's purpose.

**Game UI/HUD framing:** This maps onto an iteration order for HUD/menu
critique passes: first pass — are the right elements grouped (proximity)?
second — is everything on a shared grid (alignment)? third — does the visual
language repeat correctly across screens (repetition)? fourth — does the
critical information actually stand out (contrast)? Doing these in sequence
during a UI polish pass avoids the common trap of jumping straight to
"needs more contrast/juice" on a screen whose real problem is that nothing is
grouped or aligned yet.

## Chapter: Using Color

A practical, non-technical primer on the traditional color wheel (12 hues:
3 primary, 3 secondary, 6 tertiary) and the standard harmony relationships
built from it:

- **Complementary** — opposite hues (e.g., blue/orange); strong contrast, best
  used as one dominant color plus one accent rather than in equal amounts.
- **Triads** — three hues equally spaced around the wheel; reliably
  harmonious because they share underlying relationships.
- **Split-complement** — a hue plus the two neighbors of its complement;
  slightly more sophisticated/less obvious than a straight complementary
  pair.
- **Analogous** — hues next to each other on the wheel; naturally harmonious
  because they share an undertone.
- **Shades/tints/tones** — adding black (shade), white (tint), or gray (tone)
  to a hue multiplies the usable palette from any single relationship above,
  and is what keeps "kid-primary-color" combinations (pure red/yellow/blue)
  from looking juvenile.

Other practical rules: warm colors (reds/yellows) advance and demand
attention even in small amounts; cool colors (blues/greens) recede and need
more area to register — so an interface shouldn't use equal amounts of a hot
accent and a cool base color. Colors with *similar tone* (brightness/value),
even if hue differs, create weak, muddy contrast — legibility comes from
value contrast as much as hue difference. Finally: use CMYK only for physical
print; use RGB for anything viewed on a screen (directly applicable — RGB is
correct for real-time game UI/HUD work).

**Game UI/HUD framing:** The color-wheel relationships are a fast way to
generate a coherent HUD/faction/rarity palette without trial and error — e.g.
a split-complement keyed off a game's primary brand hue gives a
non-arbitrary accent color for warnings or highlights. The tone-similarity
warning is a direct legibility rule for HUDs over busy 3D backgrounds: two
HUD colors (or a HUD color and the likely background) that share similar
brightness will visually merge regardless of hue, which is why HUD text
commonly needs an outline/shadow/backing plate rather than relying on hue
contrast alone. The warm-advances/cool-recedes rule also explains why danger
and critical-health states default to red/orange across nearly every game's
UI convention, and why cool colors are safe for large ambient/passive UI
surfaces (map backgrounds, inactive panels) without overpowering gameplay.

## Chapter: Extra Tips and Tricks — Applying CRAP to Real Layouts

A long worked-example chapter applying the four principles to a series of
real collateral types (business card, letterhead/envelope, flyer, newsletter,
brochure, postcard, newspaper ad, web page). The piece-specific tips
generalize into a few cross-cutting production lessons:

- **Type size discipline**: new designers consistently set body/label text
  too large (defaulting to 12pt) and headlines too small relative to it;
  professional-feeling pieces usually push small supporting text smaller
  (7–10pt) and push true headlines much larger than instinct suggests, using
  the freed-up space for grouping/whitespace instead.
- **ALL CAPS is a legibility tax**: capitalized text takes more space *and*
  reads slower (word-shape recognition is lost), so it should be reserved for
  short labels, not body text or long headlines — and switching a title to
  caps/lowercase is one of the easiest way to free room to enlarge it.
- **Consistency across a "package"**: when multiple pieces belong together
  (business card + letterhead + envelope; or in games, HUD + pause menu +
  inventory), they must be designed as one system from the start, not
  patched to match after the fact — repetition principle applied at the
  product-suite level.
- **Web-specific notes** (from the book's late-2000s vantage point, but the
  underlying claims still generalize): repetition is the *most* important
  principle for multi-screen/multi-page digital work specifically because it
  is how a user confirms "I am still in the same place/system"; consistent
  navigation position across screens reduces cognitive load more than any
  single screen's individual polish.
- **White space is a first-class design element**, not empty space to be
  filled — cramming a layout to "get your money's worth" out of paid space
  (an ad, a card) consistently reads as amateurish and *reduces* how much
  actually gets read, because nothing stands out.

**Game UI/HUD framing:** Directly transferable: keep secondary HUD text (kill
feed timestamps, buff durations, currency deltas) genuinely small rather than
defaulting everything to a "readable" size, and reserve real size contrast
for what actually needs first read priority. Avoid all-caps for body-length
tooltip/quest text for the same legibility reasons (short caps labels — like
button prompts — are fine). Treat the HUD, pause menu, inventory, and any
other UI surface as one designed system from project start rather than
letting each screen's team invent its own type scale, icon frame, and
spacing — this is the game-dev equivalent of designing the business card,
letterhead, and envelope together. And resist the instinct to fill every
inch of a HUD/menu with information "since there's room" — unused screen
space around a HUD cluster is what lets that cluster read as a distinct,
scannable group (ties back to Proximity).

## Chapter: Type and Life — Concord, Conflict, and Contrast

Introduces the three possible relationships when more than one typographic
element (or typeface) appears together:

- **Concord** — using essentially one typeface family throughout (perhaps
  with its italic, or one size variation). Calm, safe, often formal or
  "quiet," sometimes dull — a legitimate and common choice (most wedding
  invitations, for instance), but should be a *conscious* choice, not a
  default from not knowing other options.
- **Conflict** — combining two typefaces that are similar but not identical
  (e.g., two different oldstyle serif faces, or two different scripts). This
  is the failure state: the reader perceives the mismatch as a mistake
  because the faces are close enough to invite comparison but not close
  enough to look intentional.
- **Contrast** — combining typefaces that are clearly, deliberately different
  from each other. This produces energy and visual interest and is
  Williams' recommended default whenever more than one typeface appears.

Her diagnostic heuristic for fixing a conflict: don't look for what's
*different* between two clashing faces — look for what's *similar*. The
similarity is what's causing the eye to expect sameness and then register
the small differences as errors.

**Game UI/HUD framing:** Directly applicable to UI type-scale decisions:
picking a display font for headers and a separate body font for
descriptions/tooltips is a contrast choice and should be treated as such —
two faces that are both, say, geometric sans-serifs at similar weights will
conflict (readers will perceive stray inconsistency) rather than contrast.
The fix mirrors the book's advice: if a HUD font pairing "feels off," check
for near-but-not-quite similarity (two different but similar-weight sans
faces) rather than assuming more differentiation is needed elsewhere.

## Chapter: Categories of Type

Groups typefaces into six broad families the reader should learn to
recognize on sight, since combining two faces from the *same* category is
the most common source of Conflict (above):

- **Oldstyle** — serif faces descended from calligraphic pen strokes; angled
  serifs, moderate thick/thin stroke contrast, diagonal stress. Their
  familiarity makes them "invisible" and easy to read in long text (e.g.
  Garamond, Palatino, Times, Baskerville).
- **Modern** — serif faces from the 1700s onward; thin horizontal serifs,
  extreme (radical) thick/thin contrast, perfectly vertical stress. Striking
  at large display sizes; the thin strokes can vanish and become hard to read
  at small/body sizes (e.g. Bodoni, Didot).
- **Slab serif** — thick, blocky, roughly rectangular serifs; little to no
  thick/thin contrast, vertical stress. Reads as sturdy/industrial/clean; good
  legibility even at moderate weight (e.g. Clarendon, Memphis, New Century
  Schoolbook). Historically also called "Egyptian."
- **Sans serif** — no serifs; almost always monoweight (no thick/thin
  transition), so no stress. The dominant category for UI generally, though a
  rare few (Optima) have subtle stroke contrast and are noted as tricky to
  pair because they straddle categories.
- **Script** — imitates hand lettering/calligraphy/brush/pen. Never set as
  long body text or in all caps; most effective used sparingly and large.
- **Decorative** — anything highly stylized/thematic that would be
  unreadable as a whole book; useful in small doses for character, best
  reserved for short display text (headlines, logos, single words).

Her core rule for combining typefaces safely: never pair two faces from the
same category on one layout (two oldstyles, two moderns, two sans serifs,
two scripts) — the shared underlying structure guarantees a Conflict
relationship. Instead, pull faces from *different* categories, which
guarantees at least a baseline structural Contrast to build on.

**Game UI/HUD framing:** This is the practical rulebook for a game's UI type
system: pick one sans serif (usually) for HUD/UI chrome — labels, numbers,
buttons — for maximum legibility at small sizes and across resolutions/DPI,
and if a second display face is used for titles/logos/flavor headers, pull it
from a genuinely different category (a slab serif or a decorative face)
rather than a second similar sans, or it will read as an inconsistency bug
rather than an intentional hierarchy. This also explains why so many HUDs use
exactly one sans-serif family with multiple weights (light/regular/bold/black)
rather than multiple different sans faces — the weight range from Chapter 11
is a safer contrast lever than swapping structurally-similar families.

## Chapter: Type Contrasts — Size, Weight, Structure, Form, Direction, Color

Breaks "contrast of type" into six independently controllable axes, any of
which can differentiate two typographic elements, and stresses that
combining *multiple* axes on the same pair produces the strongest, least
ambiguous result:

- **Size** — must be a real jump (not 12pt vs 14pt); note that ALL CAPS forces
  smaller point sizes for the same physical space than caps/lowercase would,
  so switching case can free room for a bigger, bolder size contrast.
- **Weight** — contrast a genuine bold/black against a regular or light, not
  regular against semibold; most bundled system fonts lack a sufficiently
  heavy weight, which is why investing in a true black/heavy weight in a UI
  font family pays off. Weight is one of the single most effective, easiest
  levers for adding visual interest and hierarchy (e.g. bolding key phrases
  in an otherwise plain paragraph, or bolding first-level vs. second-level
  entries in an index/list so hierarchy reads at a glance).
- **Structure** — how the letterform is physically built: monoweight
  (sans) vs. thick/thin (serif), tubular vs. picket-fence. This is effectively
  the Categories-of-Type distinction applied as a contrast tool; pairing
  faces of different structure is the safest way to combine two families.
- **Form** — the actual shape of a letter/word: caps vs. lowercase (an
  all-caps word has a uniform rectangular silhouette, which is part of why
  all-caps is harder to read — word-shape recognition is lost), and roman
  (upright) vs. italic/script (slanted, and often genuinely redrawn, not
  just slanted). Two italic or script forms should never be combined with
  each other — same rule as Categories, restated as a Form-level conflict.
- **Direction** — literal slant (used sparingly, only when justified by
  the content/mood) versus the more useful sense of a layout's horizontal vs.
  vertical *flow* — e.g. a wide headline crossing tall narrow columns creates
  a contrast of direction at the layout level, not just the letterform level.
- **Color** — both literal ink/pixel color (warm advances, cool recedes,
  matching tone reads as low-contrast regardless of hue) and typographic
  "color": the overall gray-value density a block of text produces on the
  page from weight, letter-spacing, line-spacing, and size combined. A
  uniformly gray text-heavy page is uninviting; varying typographic color
  (a bold pull-quote, a lighter caption) breaks the monotony and helps
  organize distinct content blocks.

Meta-rule for the whole chapter: stacking contrasts (a subhead that is both
bigger *and* bolder *and* a different structural category) is dramatically
more effective than relying on any single axis alone, and to debug a
combination that "feels wrong," look for unintended *similarity* on one of
these six axes rather than assuming more difference is needed everywhere.

**Game UI/HUD framing:** This is a literal checklist for designing HUD
information hierarchy: a critical alert should differ from ambient HUD text
on multiple axes at once (bigger, bolder, a shifted/warning color, possibly a
different structural weight) rather than just one, exactly as the book
recommends stacking contrasts. It also explains common UI/UX text
legibility rules of thumb — avoid long strings of caps in tooltips and quest
text (Form axis), keep body/label fonts monoweight sans for small-size
legibility (Structure axis), and use real weight jumps (not near-identical
medium/semibold pairs) to separate primary from secondary HUD readouts
(Weight axis). The Color axis's "typographic gray value" concept is directly
relevant to dense UI screens like inventories or skill trees — varying
weight/spacing to create lighter and darker text blocks helps a busy list
screen avoid reading as one undifferentiated wall of labels.

## Chapter: So, Does It Make Sense? — Design Process and Self-Critique

A short closing exercise chapter that reinforces the book's overall method
rather than introducing new principles: take a real (often badly designed)
piece, verbalize *in words* exactly which of the four principles (and, for
type, which of the six type-contrast axes) is being violated, and only then
redesign it. Williams' consistent emphasis across the whole book is that the
naming step is not optional — jumping straight to "make it prettier" without
first being able to state the specific structural problem tends to produce
timid, unfocused fixes.

She also explicitly encourages "productive theft": studying layouts/pieces
you admire and adapting their structure to new content, since professional
designers do this constantly and the adaptation process is what makes a
borrowed structure become genuinely your own.

**Game UI/HUD framing:** A practical critique protocol for UI reviews:
before proposing a visual fix to a HUD/menu complaint, state in one sentence
which CRAP principle (or which type-contrast axis) is actually failing. This
keeps feedback specific and actionable ("the ammo counter has no proximity
relationship to its weapon icon" beats "the ammo counter feels off") and
scales well to written design-critique documentation in a pipeline where
artists and engineers need a shared, precise vocabulary rather than
subjective taste calls.

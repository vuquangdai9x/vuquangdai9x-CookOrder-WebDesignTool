# CookOrder — Experience Design (Feedback Catalog)

> Scope note: this document catalogs every **player-feedback moment** in a CookOrder play
> session — the instant something happens that the player should *feel*, not just see change
> in a data table. It's written for the shipping **Unity** game (see [GDD.md](GDD.md)'s scope
> note), but every trigger point below is grounded in the actual browser prototype's simulation
> (`src/core/sim.ts`'s event log) and its already-built visual layer (`src/ui/play/effectsLayer.ts`,
> `src/ui/play/index.ts`), so triggers and timing are exact, not speculative.
>
> Each position lists three properties: **Sound**, **Visual**, **Haptic**. A `Status` column marks
> whether the visual is already built and verified in the web prototype (`Prototype`) or is a
> recommendation with no prototype equivalent yet (`Proposed`) — **sound and haptic are always
> `Proposed`**, since the browser tool has neither; they're informed by the prototype's visual
> intent (what the flash/burst/shake is already communicating) so Unity's audio/haptic pass stays
> consistent with the feel already validated in-browser, rather than being designed from scratch.

## Haptic & Sound Taxonomy

Used consistently across every table below so the same *category* of feeling always maps to the
same physical sensation and sonic register, regardless of which specific event triggers it.

| Haptic tier | Feel | Typical use |
|---|---|---|
| **Selection** | A light, quick tick | Hover/target acquisition, UI navigation |
| **Light Impact** | A soft, single tap | A small, frequent, low-stakes action (a normal pick) |
| **Medium Impact** | A firmer, single tap | A meaningful action landing (an ingredient arriving, a hazard clearing) |
| **Heavy Impact** | A pronounced, weighty thud | A large/rare action (a combined block moving, a booster firing) |
| **Success** | A short rising buzz-buzz | Positive milestone (dish filled, customer served, level won) |
| **Warning** | A short double-pulse | Something needs attention but isn't failure yet (timer low, tool congested) |
| **Error / Failure** | A sharp buzz | A loss, an overflow, a blocked action |
| **None** | — | Passive/continuous state with no discrete feedback |

| Sound register | Palette |
|---|---|
| **UI** | Clean, synthetic, short — menu/system-level (clicks, whooshes, chimes) |
| **Diegetic — kitchen** | Real-world kitchen foley (sizzle, chop, clink, pour, ding) |
| **Diegetic — service** | Front-of-house sounds (bell, register, door, chatter murmur) |
| **Music-adjacent** | Short musical stingers layered over the mix (win fanfare, tension riser) |

---

## 1. Ingredient Queue

| # | Position | Trigger (code) | Status | Visual | Sound | Haptic |
|---|---|---|---|---|---|---|
| 1.1 | Ingredient picked | Click a pickable front tile → `sim.pick(x)` (`performPick`, `play/index.ts`) | Prototype | Tile vanishes from the lane the instant the pick commits; a floating icon clone launches from that exact spot and arcs toward its destination (`EffectsLayer.fly`) | Diegetic-kitchen: soft *pluck*/pop, pitched by ingredient category | Light Impact |
| 1.2 | Combined block picked | Click any front-row column of a combined group → whole block dispatches as one pick, N flights at once | Prototype | Every member tile vanishes together; N clones launch in the same frame | Diegetic-kitchen: the single-pick pluck, layered/thickened (2–4 voices) so a multi-item pick reads as "bigger" without being N× louder | Heavy Impact |
| 1.3 | Linked chain picked | Front-most click once **every** chain member has reached row 0 → whole chain dispatches | Prototype | Same as 1.1 but for every member; the rope overlay connecting them disappears with them | Diegetic-kitchen: pluck + a short *snap* (the "chain breaking") layered on top | Medium Impact |
| 1.4 | Sweeper picked | Click a sweeper tile (`kind: "sweeper"`) — no flight, dirty stack cleared synchronously | Prototype | Tile vanishes with no flight (sweepers carry no ingredient payload) | Diegetic-kitchen: quick broom *swish* | Light Impact |
| 1.5 | Blocked-pick attempt | Click a disabled front tile (frozen / tool full under Block-the-pick) | Prototype (tooltip only, no motion/sound) | Tile shows a disabled tint + reason tooltip; nothing else happens | UI: short muted *thud* (a "no" cue, not alarming) | Selection |
| 1.6 | Frozen slot — adjacent pick registers | A pick lands on a slot 4-connected to a still-frozen item (`decrementAdjacentFreezes`, `sim.ts`) | Prototype (badge count updates; no dedicated cue of its own) | The frozen tile's bottom-right countdown badge decrements | UI: soft *crackle* tick, distinct from the normal pick sound so the player associates it with "that's chipping the ice" | Selection |
| 1.7 | Frozen slot thaws | A frozen item's remaining count reaches 0 (`playFreezeBreakBursts`, `play/index.ts`) | Prototype | Small ice-colored particle burst (10 particles, blue/white palette) at the tile; frozen tint and corner icon clear on the next render | Diegetic-kitchen: glass-like ice *crack-and-shatter* | Success |
| 1.8 | Queue lane reflow | Any pick that shifts a lane's remaining tiles up (`animatePickedLaneShift`) | Prototype | Remaining tiles slide up by the vacated row count; newly-revealed bottom row(s) fade in | None (silent — reads as a side-effect of 1.1–1.3, not its own moment) | None |

## 2. Cooking & Tools

| # | Position | Trigger (code) | Status | Visual | Sound | Haptic |
|---|---|---|---|---|---|---|
| 2.1 | Ingredient enters a tool slot | A `queue-to-tool` flight lands (`completeFlight`) | Prototype (flight landing only; no slot-specific flourish) | Item settles into the slot; the slot's progress bar begins filling from 0 | Diegetic-kitchen: tool-specific *clunk* (pan sizzle-start, chopping-board *thock*, machine *whirr-up*) | Light Impact |
| 2.2 | Cooking in progress | Continuous, while `tool.slots[i].item` is cooking | Prototype (bar fill only) | Progress bar fills linearly toward `cookingTime` | Diegetic-kitchen: looping ambience matched to the tool (sizzle loop, chopping loop) at low volume, one voice per busy slot | None |
| 2.3 | Cooking complete | Elapsed reaches `cookingTime` → `tool-to-grid` flight launches (`advanceTools`) | Prototype (flight only) | Cooked item's icon clone flies from the slot to its landing cell | Diegetic-kitchen: a bright *ding*/timer bell, tool-specific | Medium Impact |
| 2.4 | Tool full — pick blocked | `outOfSlotPolicy = "block-pick"` and every slot busy | Prototype (same disabled-tile treatment as 1.5) | Front tile disabled + tooltip | UI: same "no" cue as 1.5 | Selection |
| 2.5 | Raw parked on grid | `outOfSlotPolicy = "park-on-grid"` and every slot busy — raw lands on the grid instead | Prototype | Dimmed/grayscale icon on the grid cell + "waiting" badge | Diegetic-kitchen: a soft *set-down* clink (distinct from 3.1's landing sound — this one reads as "put aside", not "delivered") | Light Impact |
| 2.6 | Parked raw reclaimed | A tool slot frees and a parked raw is pulled in ahead of new picks (`reclaimParkedRaws`) | Prototype (flight only) | Icon flies grid→tool; the grid cell clears | Diegetic-kitchen: same clunk as 2.1 | Light Impact |

## 3. Grid & Order Matching

| # | Position | Trigger (code) | Status | Visual | Sound | Haptic |
|---|---|---|---|---|---|---|
| 3.1 | Ingredient lands on the grid | `queue-to-grid` or `tool-to-grid` flight completes | Prototype (flight landing only) | Icon settles into the first free cell in scan order | Diegetic-kitchen: light *plate-set-down* | Light Impact |
| 3.2 | Grid overflow (loss) | A finished item has no free cell (`grid-overflow` lose reason) | Proposed (currently the plain lose overlay only, no cell-level cue) | *Proposed:* the offending item flashes red and shakes briefly before the overlay appears | UI/diegetic hybrid: a sharp *clatter* (dropped tray) | Error / Failure |
| 3.3 | Dirty dish lands on the grid | `customer-to-grid` flight completes | Prototype (flight landing only) | Dirty icon settles into its stack cell; stack count badge updates | Diegetic-kitchen: dish *clink*/stack sound | Light Impact |
| 3.4 | Dirty stack fills, new stack opens | Next same-type dirty dish finds its stack at `dirtyStackHeight` (`addDirtyDish`) | Proposed (no distinct cue today — same as 3.3) | *Proposed:* a brief "stack full" pulse on the completed stack the moment its successor lands elsewhere | UI: soft warning blip | Warning |
| 3.5 | Dirty overflow (loss) | A dirty dish has no free cell (`dirty-overflow` lose reason) | Proposed | Same treatment as 3.2, on the dirty item | Same as 3.2 | Error / Failure |
| 3.6 | Sweeper clears a stack | Sweeper picked with a dirty stack present (`clearDirtyStacks`) | Prototype (stack disappears; no dedicated flourish) | Oldest dirty stack's cell empties immediately | Diegetic-kitchen: quick *wipe* swish (shared with 1.4, layered) | Light Impact |
| 3.7 | Staff clears stack(s) | A Staff customer's `dirty-to-staff` flights land (`onFlightLanded`) | Prototype | Particle burst (8 particles) per stack, at the staff card | Diegetic-service: brisk *bussing* clatter | Medium Impact |

## 4. Serving & Customers

| # | Position | Trigger (code) | Status | Visual | Sound | Haptic |
|---|---|---|---|---|---|---|
| 4.1 | Ingredient serves a dish chip | `grid-to-customer` or `backpack-to-customer` flight lands on an unfilled chip (`onFlightLanded`) | Prototype | Particle burst (8 particles) at the chip + a 0.16s bright-flash animation on the chip before it dims to "filled" | Diegetic-service: light *plate-slide* + soft chime | Light Impact |
| 4.2 | Full order complete | A customer's last dish chip fills (`playCelebrations`) | Prototype | Card brightens (×1.7 at 28%) then scales 1→1.06→1→0 while shrinking away, with a particle burst at the start; the next customer/mystery card only takes the slot once this finishes | Diegetic-service: cash-register *cha-ching* / satisfied chime, music-adjacent stinger | Success |
| 4.3 | New customer arrives | A vacated serve slot is filled (`slideInNewCustomers`) | Prototype | Card slides in from the side (translateX 24px → 0) and fades up | Diegetic-service: door chime / bell | Selection |
| 4.4 | Mystery ("?") customer revealed | The masked lookahead card becomes a real serve-slot card (same trigger as 4.3, next in queue) | Prototype (covered by 4.3's slide; the "?" mark itself just changes to the real order) | The "?" mark is replaced with the customer's real dish chips as part of the same slide-in | Diegetic-service: a light *page-turn*/reveal flourish under the door chime | Selection |
| 4.5 | Customer patience low | `timeLeft` approaching 0 on a timed customer | Proposed (no urgency cue today — the badge is static) | *Proposed:* wait-badge pulses and shifts toward red under a threshold (e.g. last 20% of `waitTime`) | Music-adjacent: rising tension tick, tempo increasing as time runs out | Warning (repeating, escalating) |
| 4.6 | Customer timeout (loss) | `timeLeft` reaches 0 (`customer-timeout` lose reason) | Prototype (only the overlay; no per-card cue) | *Proposed addition:* the expiring customer's card flashes and shakes before the overlay appears | Diegetic-service: an annoyed *huff*/door-slam as they leave unserved | Error / Failure |

## 5. Boosters

| # | Position | Trigger (code) | Status | Visual | Sound | Haptic |
|---|---|---|---|---|---|---|
| 5.1 | Booster charge available | Passive — button enabled with a nonzero charge badge | Prototype (static badge) | Charge count shown on the button | None | None |
| 5.2 | Booster charges exhausted | Charge count hits 0 (`boostersBar`) | Prototype (button disables) | Button dims/disables | UI: soft *empty* click (distinct from the "no" cue — this is "used up", not "blocked") | Selection |
| 5.3 | Shift-up Row used | Click fires `sim.forceShiftUp()` (`useBooster`) | Prototype (queue tier rebuild only; no dedicated flourish) | Every column's front instance vacates and reappears at the back of its own column on the next render | Diegetic-kitchen: mechanical *conveyor-belt* whirr | Heavy Impact |
| 5.4 | Ingredient Pick armed | Click arms pick mode; window expands to `numRowPick`, every tile becomes clickable | Prototype | Queue tier rebuilds with the wider window; header text changes to "armed" state | UI: a held *charge-up* tone (loops while armed) | Selection, held |
| 5.5 | Ingredient Pick resolved | A tile is clicked while armed → `sim.pickAt(x,y)` succeeds (`performPickAt`) | Prototype | Same tile-vanish + flight as 1.1, from arbitrary depth; mode disarms, window shrinks back | Diegetic-kitchen: pluck (1.1) + a short *release* tone closing out 5.4's charge-up | Medium Impact |
| 5.6 | Clean Table used | Click fires `sim.clearDirtyStacks(numCleanStack)` (`useBooster`) | Prototype (grid rebuild only) | Every cleared stack's cell empties on the next render, all at once | Diegetic-kitchen: a sweeping *whoosh* across multiple stacks at once (bigger than 3.6's single-stack wipe) | Heavy Impact |
| 5.7 | Auto Complete Dish used | Click fires `sim.autoCompleteDish()` (`useBooster`) | Proposed (currently just a silent state jump — dish fills, sources empty, with no flight or flourish, since it bypasses the normal serve pipeline entirely) | *Proposed:* a quick sequence of small bursts at each source (backpack/grid/queue) converging on the completed dish, since there's genuinely no flight to hang the animation on | Diegetic-service+kitchen: a fast, layered "assembly" flourish — several small clinks resolving into 4.2's chime | Success |

## 6. Save Me

| # | Position | Trigger (code) | Status | Visual | Sound | Haptic |
|---|---|---|---|---|---|---|
| 6.1 | Loss triggered | Any lose reason fires (`sim.lose`) | Prototype (overlay appears once animation settles) | The failure or Save Me overlay fades in over the board, which stays visible underneath | Music-adjacent: a short minor-key sting | Error / Failure |
| 6.2 | Save Me offered | Loss occurs and a use remains (`canOfferSaveMe`) | Prototype | Save Me overlay (backpack icon, "Save Me" / "Give Up" buttons) instead of the plain failure screen | Music-adjacent: the 6.1 sting resolves into a hopeful held note instead of fading out, signaling "there's a way back" | None (held, no new pulse) |
| 6.3 | Save Me accepted | "Save Me" clicked → `sim.saveMe()` succeeds (`handleSaveMe`) | Prototype | Every swept grid item flies (one-off, non-flight animation) from its cell into the backpack cell, then a particle burst (12 particles) at the backpack | Diegetic-kitchen: a rapid multi-item *sweep-and-gather* whoosh resolving into a soft *zip-up* (bag closing) | Success |
| 6.4 | Save Me declined | "Give Up" clicked (`saveMeDeclined`) | Prototype | Save Me overlay swaps to the plain failure overlay | UI: the 6.2 held note fades down, back into 6.1's sting | None |
| 6.5 | Backpack item serves a customer | A `backpack-to-customer` flight lands | Prototype (same as 4.1) | Same as 4.1 | Same as 4.1, with a distinct low *rustle* under it (the bag being reached into) so the source reads as "backpack", not "grid" | Light Impact |
| 6.6 | Level won | `servedCount >= totalCustomers` (`checkEnd`) | Prototype (overlay only) | Win overlay fades in over the board | Music-adjacent: full victory fanfare | Success |
| 6.7 | Next Level | "Next Level" clicked on the win overlay (only shown when a following level exists) | Prototype | Immediate transition to the next level's Play view | UI: a bright *swoosh*/page-turn transition cue | Selection |

---

## Notes for the Unity pass

- **Volume ducking**: 2.2's per-slot cooking loops should duck as more slots become busy
  (`sim.cookingCount`, already tracked) so a fully congested tool bank doesn't turn into noise —
  cap total simultaneous loop voices per tool, not per slot.
- **Haptic budget**: mobile haptic engines throttle rapid repeats. A combined/linked pick (1.2/1.3)
  or a booster (5.x) firing during a fast Skip/×3 playthrough should still collapse to **one**
  haptic pulse per player action, not one per underlying flight — mirror the web prototype's own
  `skipMode` gate (`dispatchFlights`), which already suppresses landing feedback entirely in Skip
  mode for exactly this reason.
- **Proposed rows are additive, not corrective**: every `Proposed` status above is a gap in the
  *prototype's visual layer* (no particle/flash exists yet for it), not a bug — the web tool's
  purpose is level design and playtesting, not the final player-facing feel, so some feedback
  positions were reasonably left silent there. Building them out in Unity is expected, not a
  fix-up.
- **Source of truth**: if sim.ts's event log (`SimEvent.type` — `pick`, `cooked`, `served`,
  `customer-arrived`, `customer-timeout`, `dirty-added`, `dirty-cleared`, `won`, `lost`, `saved`)
  ever grows a new type, or a new booster/mechanic is added (see [GDD.md](GDD.md) §2.6–2.7), this
  catalog should grow with it — treat "does this event have a row here" as part of that feature's
  definition of done, the same way `docs/GDD.md` and `docs/ToolDesign.md` are kept current
  alongside gameplay/tool changes.

---
title: "Don't Make Me Think, Revisited: A Common Sense Approach to Web Usability"
author: "Steve Krug"
source_pdf: "Knowledge/references/dispose/Steve_Krug_Don't_Make_Me_Think,.pdf"
learned_file: "learned/krug-dont-make-me-think.md"
---

# Don't Make Me Think, Revisited — Lookup Summary

## Don't make me think!
Introduces Krug's First Law: screens should be self-evident (or, failing that, self-explanatory) so users understand what something is and how to use it without conscious effort. Every moment of hesitation is a "question mark" that adds cognitive load and erodes trust, even if the user eventually succeeds. Because users give any given screen only a few seconds of attention, clarity has to work almost entirely at a glance, not through explanation.
→ see learned/krug-dont-make-me-think.md § Chapter: Don't make me think!

## How we really use the Web
Covers three "facts of life": users scan rather than read, satisfice (pick the first reasonable option) rather than optimize, and muddle through with vague or wrong mental models rather than learning how things actually work. All three behaviors persist even among expert/technical users and should be assumed as the default, not the exception.
→ see learned/krug-dont-make-me-think.md § Chapter: How we really use the Web

## Billboard Design 101
Concrete techniques for designing scannable screens: follow existing conventions (clarity trumps consistency when they conflict), build a clear visual hierarchy (prominence, grouping, nesting), divide the screen into clearly defined regions, make interactive elements obviously interactive, minimize visual noise (shouting/disorganization/clutter), and format text for scanning (headings, short paragraphs, bullets, selective bolding).
→ see learned/krug-dont-make-me-think.md § Chapter: Billboard Design 101

## Animal, Vegetable, or Mineral?
Krug's Second Law: users tolerate many clicks as long as each one is mindless and unambiguous; an ambiguous choice is worth roughly three easy ones in perceived effort. When a hard choice is unavoidable, guidance should be brief, exactly timed, and impossible to miss.
→ see learned/krug-dont-make-me-think.md § Chapter: Animal, Vegetable, or Mineral?

## Omit needless words
Krug's Third Law: cut roughly half the words on a page, then half of what's left. Targets "happy talk" (self-congratulatory filler text) and unnecessary instructions (which most users skip until they've already failed) as the biggest offenders, arguing for self-explanatory design over explanatory prose.
→ see learned/krug-dont-make-me-think.md § Chapter: Omit needless words

## Street signs and Breadcrumbs
The navigation design chapter. Navigation must compensate for the Web's missing spatial cues (no sense of scale, direction, or accumulated location memory). Persistent navigation needs four elements — Site ID, Sections, Utilities, Search — and deep/lower-level navigation is chronically under-designed relative to top levels. Introduces the "trunk test": dropped blindfolded on any page, can the user instantly identify site, page, sections, current location, and how to search?
→ see learned/krug-dont-make-me-think.md § Chapter: Street signs and Breadcrumbs

## The Big Bang Theory of Web Design
The Home/landing-page chapter. A home page must convey the "big picture" (what is this, what can I do here) within the first few seconds, because first impressions strongly anchor later interpretation and wrong first guesses compound into worse confusion. Warns against the "tragedy of the commons" where every stakeholder's promo request individually helps traffic but collectively clutters the page. Covers taglines, welcome blurbs, and explainer videos as the three places users expect a plain statement of purpose.
→ see learned/krug-dont-make-me-think.md § Chapter: The Big Bang Theory of Web Design

## "The Farmer and the Cowman Should Be Friends"
Diagnoses why usability debates on teams rarely resolve: personal taste projected onto "most users," professional-role biases (designers vs. developers vs. "hype culture" stakeholders), and belief in a nonexistent "Average User." The fix is reframing opinion-based questions ("do people like X") into testable ones ("does this specific X work for people doing this task") and settling them with usability testing instead of argument.
→ see learned/krug-dont-make-me-think.md § Chapter: "The Farmer and the Cowman Should Be Friends"

## Usability testing on 10 cents a day
The do-it-yourself usability testing chapter. Recommends small, frequent, cheap tests (three users, one morning, monthly) over rare expensive ones; distinguishes usability tests (observed task performance) sharply from focus groups (opinion discussion); covers recruiting ("loosely, grade on a curve"), facilitation (think-aloud, no leading), and debriefing (rank and fix the worst problems first, ignore self-corrected "kayak" problems and unsolicited feature requests).
→ see learned/krug-dont-make-me-think.md § Chapter: Usability testing on 10 cents a day

## Mobile: It's not just a city in Alabama anymore
Covers mobile-specific usability constraints: limited screen space forcing harder content tradeoffs, loss of hover-based affordance cues on touchscreens (worsened by flat/minimal visual design), and the added importance of load speed. Introduces three attributes specific to app usability — delight, learnability, memorability — and warns that low switching cost ("life is cheap on mobile") means friction is punished fast.
→ see learned/krug-dont-make-me-think.md § Chapter: Mobile: It's not just a city in Alabama anymore

## Usability as common courtesy
Frames user patience as a finite "reservoir of goodwill" depleted by inconsiderate design (hidden pricing/support info, rigid input formatting, unnecessary data requests, insincere copy) and refilled by considerate design (surfacing needed information proactively, saving the user steps, maintaining genuine FAQs, graceful error recovery, honest apologies for real limitations).
→ see learned/krug-dont-make-me-think.md § Chapter: Usability as common courtesy

## Accessibility and you
Argues accessibility is inseparable from usability and that concrete human examples persuade better than statistics. Gives a prioritized action list: fix universal confusion first (highest leverage), learn how screen-reader users actually scan ("scan with their ears"), then apply concrete technical fixes (alt text, heading structure, form labels, skip links, keyboard support, contrast). Rejects the "buttered cat" idea that accessible design must compromise everyone else's experience.
→ see learned/krug-dont-make-me-think.md § Chapter: Accessibility and you

## Guide for the perplexed
Closing chapter on building organizational support for usability practice: get decision-makers to watch a live test in person, run a cheap informal first test to demonstrate a win, test competitors to build the case with low political risk, and lead with empathy and humility. Draws an explicit ethical line between legitimate persuasion and manipulative dark patterns, plus a short list of near-absolute interface rules (contrast, form labels, visited-link color, heading placement).
→ see learned/krug-dont-make-me-think.md § Chapter: Guide for the perplexed

## Key Takeaways for Game UI/UX Design
- Apply the "trunk test" to every menu depth, not just the main menu: dropped into any random sub-screen, a player should instantly identify what screen it is, its parent/sibling options, and how to get back — deep settings/crafting sub-panels are the most common place this fails. → learned/krug-dont-make-me-think.md § Chapter: Street signs and Breadcrumbs
- Treat in-fiction or clever naming for core menu functions (crafting, inventory, skills) as a usability cost, not just a flavor win — plain, scannable labels should win unless the flavor name is nearly as clear. → learned/krug-dont-make-me-think.md § Chapter: Don't make me think!
- Design HUD/menu visual hierarchy so critical information (health, target, active objective) is unmistakably more prominent than ambient/decorative elements — audit for "shouting" (everything competing), disorganization (no grid), and clutter (low-value elements diluting signal). → learned/krug-dont-make-me-think.md § Chapter: Billboard Design 101
- Run cheap, frequent playtests (a handful of players, short sessions, regular cadence) on menu/onboarding flows specifically, and settle internal team debates about UI ("do players like radial menus") by testing a concrete version instead of arguing preferences. → learned/krug-dont-make-me-think.md § Chapter: Usability testing on 10 cents a day; § Chapter: "The Farmer and the Cowman Should Be Friends"
- Teach mechanics through minimal, contextual, first-use prompts rather than front-loaded tutorial text walls — cut onboarding copy aggressively and replace explanation with self-explanatory interaction design wherever possible. → learned/krug-dont-make-me-think.md § Chapter: Omit needless words
- Give every interactive HUD/menu element an unambiguous affordance cue (shape, border, motion) since games can't rely on cursor-hover the way desktop Web UI historically could, especially under flat/minimal art styles. → learned/krug-dont-make-me-think.md § Chapter: Mobile: It's not just a city in Alabama anymore
- Fix universal menu confusion before building specialized accessibility accommodations — colorblind-unfriendly status icons, low-contrast subtitles, and unlabeled buttons hurt every player and are the highest-leverage accessibility fix available. → learned/krug-dont-make-me-think.md § Chapter: Accessibility and you
- Surface player-relevant information proactively (patch notes, known issues, downtime causes) rather than making players hunt for it — treat player patience as a depletable "reservoir of goodwill" that silence during a crisis drains fastest. → learned/krug-dont-make-me-think.md § Chapter: Usability as common courtesy
- When pitching a UI/UX fix internally, get a producer or lead to watch a real player struggle with the current design in person rather than relying on a written report — it is consistently the most persuasive lever for prioritization. → learned/krug-dont-make-me-think.md § Chapter: Guide for the perplexed
- Distinguish legitimate monetization persuasion (clear pricing, honest framing) from dark patterns (confirm-shaming, disguised ads, panic-inducing timers) as an explicit design ethics line, not just a legal compliance question. → learned/krug-dont-make-me-think.md § Chapter: Guide for the perplexed

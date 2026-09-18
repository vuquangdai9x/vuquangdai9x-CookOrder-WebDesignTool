---
title: "Refactoring UI"
author: "Adam Wathan & Steve Schoger"
source_pdf: "Knowledge/references/dispose/Refactoring UI.pdf"
learned_file: "learned/wathan-schoger-refactoring-ui.md"
---

# Refactoring UI — Lookup Summary

## Chapter: Starting from Scratch
Start a design from one concrete feature rather than the app shell/nav, and work in low fidelity first so spacing and hierarchy carry the design instead of color and polish. Design only the next working increment and avoid implying unbuilt functionality. Personality comes from a few consistent levers (typeface, color, border radius, copy tone), and pre-defining constrained systems (fixed palettes, fixed scales) makes every later decision an easy pick from a short list instead of an exhausting open choice.
→ see learned/wathan-schoger-refactoring-ui.md § Chapter: Starting from Scratch

## Chapter: Hierarchy is Everything
Visual hierarchy — driven mainly by font weight and color/contrast rather than size alone — is the single biggest lever for a UI feeling designed. "Emphasize by de-emphasizing" competing neighbors when an element still doesn't stand out. Labels are a last resort since format and context usually communicate meaning on their own, and buttons should follow an importance hierarchy (one primary, outline secondary, link-style tertiary) rather than pure semantics.
→ see learned/wathan-schoger-refactoring-ui.md § Chapter: Hierarchy is Everything

## Chapter: Layout and Spacing
Start with too much white space and remove it, rather than adding increments until "good enough." Build a non-linear spacing scale (small values need finer steps than large ones) and avoid stretching elements to fill available width just because the canvas is wide. Relative sizing (e.g. deriving everything from one base ratio) breaks down across screen sizes, and ambiguous equal spacing between and within groups should be avoided by always making between-group gaps larger than within-group gaps.
→ see learned/wathan-schoger-refactoring-ui.md § Chapter: Layout and Spacing

## Chapter: Designing Text
Define a small hand-picked type scale rather than a mathematically pure modular scale, and set sizes in px/rem, not em. Keep paragraph line length to roughly 45-75 characters, align mixed font sizes by baseline, and scale line-height inversely with font size and proportionally with line length. De-emphasize most links in link-dense UIs, keep text left-aligned by default, right-align tabular numbers, and widen letter-spacing only for all-caps text.
→ see learned/wathan-schoger-refactoring-ui.md § Chapter: Designing Text

## Chapter: Working with Color
Think in HSL rather than hex/RGB since its components map to how people perceive color. A real UI needs a large defined palette (8-10 grey shades, 5-10 shades of one or two primary colors, multiple semantic/accent colors) built as a fixed named ramp rather than generated on the fly. Compensate for saturation washing out near 0%/100% lightness, and prefer accessible techniques like "flipping the contrast" over guesswork; never use color as the sole signal for meaning — pair it with an icon or shape.
→ see learned/wathan-schoger-refactoring-ui.md § Chapter: Working with Color

## Chapter: Creating Depth
Fake real-world lighting with one governing rule: light comes from above, so raised elements get a lighter top edge and a shadow below, while inset elements flip this. Use restraint, and define a fixed multi-step shadow/elevation scale so panels, dropdowns, and modals read consistently along a z-axis. Shadows can also communicate live interaction state (growing on drag, shrinking on click), and even flat design can suggest depth through lighter-is-closer shading and hard-edged offset "solid shadows."
→ see learned/wathan-schoger-refactoring-ui.md § Chapter: Creating Depth

## Chapter: Working with Images
Use only high-quality photography, never permanent placeholders, since layouts get tuned around whatever image is present. Reduce an image's dynamic range (overlay, contrast reduction, colorizing, or a soft text glow) before overlaying text so no single text color fails against it. Respect each image asset's intended display size — icons and screenshots degrade when scaled far outside their authored size — and contain user-uploaded images in fixed-aspect-ratio, cover-cropped containers with a subtle inner border to avoid clashing with the page.
→ see learned/wathan-schoger-refactoring-ui.md § Chapter: Working with Images

## Chapter: Finishing Touches
A collection of low-effort, high-impact polish moves: supercharge browser/OS defaults (custom bullets, links, checkboxes), use accent-color borders for cheap brand presence, decorate backgrounds with low-contrast patterns or gradients, and treat empty states as a priority since they're often a user's first impression. Prefer shadows, background-color differences, or spacing over hard borders for separating elements, and question default component conventions (a dropdown, table cell, or radio group doesn't have to look like the plain default).
→ see learned/wathan-schoger-refactoring-ui.md § Chapter: Finishing Touches

## Chapter: Leveling Up
Two ongoing practice habits: actively hunt for "I wouldn't have thought of that" decisions in admired interfaces, and rebuild liked interfaces from scratch without inspecting their code, since the friction of noticing your version differs is what surfaces transferable technique.
→ see learned/wathan-schoger-refactoring-ui.md § Chapter: Leveling Up

## Key Takeaways for Game UI Design
- Prototype one screen (e.g. the inventory grid) fully in grayscale before styling the whole menu shell, instead of tackling nav, HUD, and art style all at once. → learned/wathan-schoger-refactoring-ui.md § Chapter: Starting from Scratch
- Lock one shared kit of parts per game — font, corner radius, palette, in-fiction vs. plain copy — applied consistently across every menu/HUD/store screen. → learned/wathan-schoger-refactoring-ui.md § Chapter: Starting from Scratch
- Drive HUD hierarchy (health, objective, reticle) with font weight and color/contrast, not just size, and dim ambient HUD elements before making a critical alert bigger. → learned/wathan-schoger-refactoring-ui.md § Chapter: Hierarchy is Everything
- Give every menu/store screen exactly one primary CTA (solid), secondary actions as outline buttons, and Cancel/Skip as plain links; save alarming red-bold styling for the actual confirmation step of a destructive action. → learned/wathan-schoger-refactoring-ui.md § Chapter: Hierarchy is Everything
- Build one locked spacing scale for icon padding, card gutters, and section margins shared across all menu/HUD screens, and re-tune HUD element sizing independently per resolution/aspect ratio rather than scaling proportionally. → learned/wathan-schoger-refactoring-ui.md § Chapter: Layout and Spacing
- Define one small type scale (5-7 sizes) shared by dialogue, tooltips, HUD numbers, and menu headers, and favor a neutral highly legible sans-serif for stat/tooltip text even when a stylized font is used for titles. → learned/wathan-schoger-refactoring-ui.md § Chapter: Designing Text
- Add extra letter-spacing to all-caps HUD labels and achievement banners, and re-check line-height/line-length whenever localized text runs longer than English. → learned/wathan-schoger-refactoring-ui.md § Chapter: Designing Text
- Build one HSL-based color system (greys + 1-2 faction colors + semantic accents) with defined shade ramps shared across HUD, menus, and store — and never rely on color alone for rarity tiers or buff/debuff states; pair it with an icon or shape for colorblind players. → learned/wathan-schoger-refactoring-ui.md § Chapter: Working with Color
- Define a fixed shadow/elevation scale so tooltip-over-card-over-panel-over-HUD always reads in a consistent z-order, and use shadow growth/shrink as cheap tactile feedback on hover, drag, and click. → learned/wathan-schoger-refactoring-ui.md § Chapter: Creating Depth
- Author icon assets at their actual display size instead of scaling one master sheet — redraw simplified versions for minimap/HUD-scale icons rather than shrinking detailed art. → learned/wathan-schoger-refactoring-ui.md § Chapter: Working with Images
- Apply overlay/contrast-reduction/text-shadow techniques to any screen with background art behind text (loading screens, splash art, store banners) instead of picking one text color and hoping it works against every piece of concept art. → learned/wathan-schoger-refactoring-ui.md § Chapter: Working with Images
- Design real empty states (fresh inventory, unstarted quest log, guild-less social tab) with a clear next action instead of a blank list, and reskin default engine-UI toggles/sliders/radios with the game's actual style kit. → learned/wathan-schoger-refactoring-ui.md § Chapter: Finishing Touches

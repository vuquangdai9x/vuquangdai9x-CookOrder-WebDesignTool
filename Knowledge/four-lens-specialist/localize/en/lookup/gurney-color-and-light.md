---
title: "Color and Light: A Guide for the Realist Painter"
author: "James Gurney"
source_pdf: "Knowledge/references/dispose/Color_and_Light_James_Gurney_English.pdf"
learned_file: "learned/gurney-color-and-light.md"
---

# Color and Light: A Guide for the Realist Painter — Lookup Summary

## Chapter: History of Light and Color in Painting
Gurney surveys how historical painters (Old Masters, academic tradition, Hudson River School, plein-air, Symbolist, magazine illustration) worked under real constraints — limited pigments, no photography, studio vs. location practice — and how those constraints shaped transferable lighting and color solutions. Old Masters proved a small, disciplined palette forces better value/temperature decisions than an unlimited one. Plein-air and illustration traditions are the direct ancestors of, respectively, observational color practice and the fast, high-contrast, "reads at a glance" lighting used in concept art and games today.
→ see learned/gurney-color-and-light.md § Chapter: History of Light and Color in Painting

## Chapter: Sources of Light
Every common real-world light source (sunlight, overcast sky, window light, indoor electric, streetlights/night, luminescence) has a distinct signature of direction, hardness, and color that should be memorized and treated deliberately rather than arbitrarily. Direct sunlight is really three overlapping systems — a small hard warm sun, a huge soft cool sky fill, and weaker bounce light — with the sun always dominant. Night and mixed-source scenes read best with a small, deliberate palette of 2–3 light colors instead of unlimited arbitrary hues.
→ see learned/gurney-color-and-light.md § Chapter: Sources of Light

## Chapter: Light and Form
This chapter covers how light reveals volume independent of the light source itself: the value gap between a form's lit and shadow sides, occlusion/contact shadows where surfaces crowd together, and deliberate lighting strategies like frontal lighting (flattening, high readability) versus spotlighting (selective, attention-directing contrast). Keeping the light/shadow value interval consistent across every object in a scene is what makes a whole painting or lit environment feel unified. Occlusion shadows are the small, dark accents that visually anchor objects to the ground and to each other.
→ see learned/gurney-color-and-light.md § Chapter: Light and Form

## Chapter: Elements of Color
Core color vocabulary and observational habits: chroma/value compression, local color as a reference point rather than the color to paint, the essential contrast role of grays and neutrals, the notorious difficulty of convincing greens, gradation as the "musical glissando" that avoids flat/banded forms, tints as the natural state of distant or brightly lit objects, and the real historical constraints (permanence, availability, safety) that shaped available pigments. Value relationships generally matter more for legibility than exact hue accuracy.
→ see learned/gurney-color-and-light.md § Chapter: Elements of Color

## Chapter: Paint and Pigments
A studio-craft chapter on organizing and mixing physical paint — charting pigments before painting, warm underpainting for overall temperature unity, the "mud debate" (muddy color is often a chroma/value mismatch rather than an absolute flaw), monochromatic schemes as a strong-unity fallback, warm/cool relationships as more important than exact hue, and pre-mixed "color strings" that force a value plan in advance. The underlying discipline — limited, deliberate palettes and planned value ranges — transfers directly to digital color grading and in-engine material/lighting LUTs.
→ see learned/gurney-color-and-light.md § Chapter: Paint and Pigments

## Chapter: Gamut Mapping
Gamut mapping is Gurney's system for deliberately restricting a painting's palette using shapes (gamut masks) drawn on a color wheel: tight clusters read as unified/harmonious, wide arcs allow more drama but risk incoherence without value control. Once a gamut shape is chosen, every color mixed within its boundary guarantees harmony by construction. Color scripting extends this to planning value/color progression across an entire sequence of scenes, exactly like a film or game production's color script.
→ see learned/gurney-color-and-light.md § Chapter: Gamut Mapping

## Chapter: Visual Perception
Human color perception is a construction of the visual system, not a direct read of physical wavelength, and diverges from physical reality in predictable, useful ways — moonlight is physically reddish but is universally perceived and painted as blue, because perceptual/conventional correctness beats literal physical accuracy when the two conflict. Simultaneous contrast and chromatic adaptation mean any color reads differently depending on its surroundings, so color must always be evaluated in scene context, never in isolation. Color and lighting choices also carry associative/emotional weight (appetite, calm, dread) independent of physical accuracy.
→ see learned/gurney-color-and-light.md § Chapter: Visual Perception

## Chapter: Surfaces and Effects
Covers how light interacts with distinct materials and atmospheric conditions: transmitted light and subsurface scattering (translucent materials carry and diffuse light rather than reflecting it), specular reflections (shiny surfaces show their environment, not their own local color), sky color as two overlapping gradients (solar glare plus horizon glow), atmospheric perspective (distance lightens/desaturates/cools and reduces contrast, with a rare reverse-perspective exception), and a family of specific effects — sunsets, fog/mist/smoke/dust, skyholes, sunbeams/shadowbeams, illuminated foreground, and turbulent water. This is the most directly transferable chapter for environment and material shading work, mapping closely onto SSS, specular/reflection shading, aerial-perspective LUTs, and volumetric god-ray lighting in game engines.
→ see learned/gurney-color-and-light.md § Chapter: Surfaces and Effects

## Chapter: Light's Changing Show / Serial Painting
Closes the technique portion of the book by treating light as something that changes over time rather than a fixed condition to capture once. Painting (or designing) the same subject across a series of times of day, seasons, or weather conditions builds a far deeper, more flexible understanding of how a form and material behave under light than any single rendering can. This is directly analogous to building a full day/night or seasonal lighting cycle for a game environment instead of lighting only for one hero screenshot.
→ see learned/gurney-color-and-light.md § Chapter: Light's Changing Show / Serial Painting

## Key Takeaways for Key Art and Environment Lighting
- Layer every lighting setup as 2–3 subordinate light systems (key/sun, sky/fill, bounce) rather than one flat light — use it as a checklist when a scene reads flat or arbitrary. → learned/gurney-color-and-light.md § Chapter: Sources of Light
- Keep the light/shadow value gap consistent across every surface in a scene so the whole image reads as one coherent lighting condition. → learned/gurney-color-and-light.md § Chapter: Light and Form
- Build night, interior, and mixed-source scenes from a deliberate 2–3 color light palette instead of arbitrary per-light hues. → learned/gurney-color-and-light.md § Chapter: Sources of Light
- Place occlusion/contact shadows deliberately wherever forms meet or crowd together — they anchor objects to the ground and each other, equivalent to ambient occlusion. → learned/gurney-color-and-light.md § Chapter: Light and Form
- Treat atmospheric depth (fog, aerial perspective, distance desaturation/cooling) as a first-class depth and scale cue, not just a technical fog volume. → learned/gurney-color-and-light.md § Chapter: Surfaces and Effects
- Model skies as two overlapping gradients — solar glare toward the sun, horizon glow toward the horizon — instead of one flat gradient. → learned/gurney-color-and-light.md § Chapter: Surfaces and Effects
- Favor perceptual correctness over literal physical correctness when they conflict (the "moonlight is blue" case); players read familiar convention as more correct than physical accuracy. → learned/gurney-color-and-light.md § Chapter: Visual Perception
- Use gamut mapping — a restricted, wheel-based hue range per scene or level — to guarantee color harmony by construction rather than after-the-fact correction. → learned/gurney-color-and-light.md § Chapter: Gamut Mapping
- Build a color script across a whole level or sequence of scenes so each space reads distinctly and supports the narrative arc, the same way film and game productions plan color. → learned/gurney-color-and-light.md § Chapter: Gamut Mapping
- Reserve saturated color as a scarce resource against a mostly neutral backdrop; overusing intense color everywhere is a more common failure than "too much gray." → learned/gurney-color-and-light.md § Chapter: Elements of Color
- Choose environment and UI palettes deliberately for the emotional/associative response a space needs (appetite, comfort, dread), not only for physical accuracy. → learned/gurney-color-and-light.md § Chapter: Visual Perception
- Design key materials (skin, foliage, glass, water, metal) around their distinct optical behavior — subsurface scattering, transmission, specular environment reflection, turbulent-water breakup — instead of one generic shading model. → learned/gurney-color-and-light.md § Chapter: Surfaces and Effects
- Light a hero environment under several different time-of-day/weather conditions, not just one hero shot, to build a lighting rig that holds up across a full gameplay session. → learned/gurney-color-and-light.md § Chapter: Light's Changing Show / Serial Painting

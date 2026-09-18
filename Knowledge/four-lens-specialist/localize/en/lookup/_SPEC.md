---
title: "Lookup file structure spec"
---

# Lookup File Structure Spec

Every `lookup/<slug>.md` MUST follow this exact shape so `scripts/kb.js` can parse it without a human (or an LLM) reading the whole file. This file is itself excluded from `kb.js list`.

```
---
title: "<Book Title>"
author: "<Author>"
source_pdf: "Knowledge/references/dispose/<original filename>"
learned_file: "learned/<slug>.md"
---

# <Book Title> — Lookup Summary

## <Section Name 1>
<3-6 sentence plain-language summary of this section/chapter>
→ see learned/<slug>.md § <Section Name 1>

## <Section Name 2>
...

## Key Takeaways for <Domain>
- <actionable bullet> → learned/<slug>.md § <Section Name>
- ...
```

Rules:
- Front matter is YAML between `---` lines, always present, always with exactly these four keys (`title`, `author`, `source_pdf`, `learned_file`). `source_pdf` should point at wherever the original currently lives — `references/<filename>` before disposal, `references/dispose/<filename>` after (update it when you move the file).
- Exactly one `# ` (H1) title line right after front matter.
- Every subsequent section is a `## ` (H2) heading — no H3 inside lookup files (H3 is fine inside `learned/` files for sub-topics).
- Every section body ends with a line starting with `→ see learned/<slug>.md § <heading text>` (the arrow character `→`, U+2192) — this is how `kb.js get --full` maps a lookup section to its learned-file counterpart. The heading text after `§` must match a real `##` or `###` heading in the learned file (exact or substring match — `kb.js` does case-insensitive substring matching).
- The final section is always named starting with `Key Takeaways` (any casing/suffix, e.g. `Key Takeaways for Game Narrative Design`) — `kb.js keytakeaways <slug>` looks for this exact prefix.
- Do not put prose between the H1 title and the first `##` section (no unstructured intro paragraph) — keeps the parser simple.

`learned/<slug>.md` has looser structure (front matter + `## Chapter/Section: <name>` blocks, optionally with `###` sub-headings) since it's read in full only when an agent explicitly needs depth — `kb.js get <slug> <query> --full` still expects section headings to be findable by substring match, so keep heading text stable and don't rename sections after lookup.md citations are written.

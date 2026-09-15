# Map 1 — Levels 1–10

Finalized with the `design-level` workflow on 2026-09-15. Candidate search was capped at four attempts per level; the best fundamentally valid result was selected.

Fixed production model: unpacked raw ingredients, automatic tool processing, park-on-grid overflow policy, 10 grid cells, two active customers, and three visible queue rows. Queue slot amount is always 1.

| Level | Customers | Dishes | Introduced content | Obstacles | Simulator duration | Result | Final CSV |
|---:|---:|---:|---|---|---:|---|---|
| 1 | 6 | 7 | Burger: bun, patty | None | 42.598 s | Closest valid | [CSV](map1-l01-v2/versions/v002-level.csv) |
| 2 | 8 | 11 | Coca: cup, ice | None | 39.732 s | Closest valid | [CSV](map1-l02-v2/versions/v002-level.csv) |
| 3 | 14 | 20 | Tomato | 2 combined groups | 63.297 s | Closest valid | [CSV](map1-l03-v2/versions/v005-level.csv) |
| 4 | 16 | 24 | — | 2 linked groups | 77.464 s | Closest valid | [CSV](map1-l04-v2/versions/v005-level.csv) |
| 5 | 28 | 28 | — | None in safe fallback | 49.664 s | Valid fallback; below hard-duration target | [CSV](map1-l05-v2/versions/v088-level.csv) |
| 6 | 16 | 25 | Potato | 2 combined groups | 117.231 s | Closest valid | [CSV](map1-l06-v2/versions/v013-level.csv) |
| 7 | 18 | 28 | — | 5 frozen slots | 145.564 s | Closest valid | [CSV](map1-l07-v2/versions/v017-level.csv) |
| 8 | 20 | 32 | Lettuce, cheese | 3 combined groups, 10 frozen slots | 322.258 s | Valid | [CSV](map1-l08-v2/versions/v062-level.csv) |
| 9 | 30 | 30 | — | None in safe fallback | 129.333 s | Closest valid; below hard-duration target | [CSV](map1-l09-v2/versions/v106-level.csv) |
| 10 | 52 | 52 | — | None in safe fallback | 236.334 s | Valid fallback; below super-hard-duration target | [CSV](map1-l10-v2/versions/v247-level.csv) |

No chicken, onion, egg, or sauce appears in the finalized batch. The only obstacle families used are combined groups, linked groups, and frozen ingredient slots.

Levels 5, 9, and 10 originally used higher dish counts and denser obstacles, but those candidates lost to deterministic grid overflow. Per the four-attempt cap, the workflow selected previously tested playable fallbacks instead of starting further searches. Their finalized draft JSON and validation report sit next to each CSV.

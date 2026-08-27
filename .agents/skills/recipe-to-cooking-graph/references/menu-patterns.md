# Tested burger and cafe menu patterns

Read this reference only for burger/fast-food or coffee/cafe graphs. These patterns came from a forward test that recreated both sample menus using only their orderable-composite names as initial data.

## What the legacy samples teach—and what not to copy

`Graph-1-Burger.json` and `Graph-2-Coffee.json` remain useful for names and gameplay vocabulary, but they predate the stricter skill contract.

| Sample | Useful concepts | Known traps to avoid in new graphs |
|---|---|---|
| Burger | bun/patty/topping assembly, soda machine, fried sides, dirty plate/cup/tray | unbounded option groups, missing provenance map, incomplete emoji coverage |
| Coffee | grind/brew flow, hot/cold drinks, baked/fried pastries, creams/glazes/fruit | dead donut variants, multi-input processes the simulation only partly reads, depth-4 assemblies, missing provenance and artwork |

Never fix those canonical samples as part of an unrelated graph request. Use the patterns below for new work.

## Burger + soda + fried basket

A tested 25-pickup allocation:

- Burger (14): bun; beef, chicken, and veggie patties; tomato; lettuce; onion; cheese; egg; bacon; pickle; ketchup; mustard; mayo.
- Soda (4, with shared sauces excluded): cup, ice, cola syrup, orange syrup.
- Fried basket (7, plus shared ketchup/mayo): potato, chicken wing, chicken tender, onion rings, mozzarella stick, ranch, chili sauce.

Player-visible processes:

- cutting board: bun and vegetables to sliced states;
- griddle: patties, egg, and bacon to cooked states;
- cutting board then fryer: potato to sliced potato to fries;
- fryer: wings, tenders, onion rings, and mozzarella sticks to fried states;
- soda machine: cup to carbonated soda base, with syrup/ice assembled afterward.

Safe assembly:

```text
required patty group + bounded extras group → burger-fillings helper
sliced bun + burger-fillings helper → burger
soda base + required bounded soda extras → soda
required bounded fried base + optional bounded sauces → fried-basket
```

The burger helper is necessary because a composite cannot own two topping edges. Counting the orderable, helper, and group gives maximum assembly depth 3. Give burger, soda, and fried basket their own dirty plate, cup, and tray edges.

Recipe grounding: a familiar burger may include a cooked patty in a bun with lettuce, tomato, onion, pickle, cheese, and sauces. Fries and fried finger foods share a fryer, while their ready states remain distinct.

## Coffee drinks + donut + cupcake

A tested 25-pickup allocation:

- Coffee bases (5): coffee bean, decaf bean, prepared cold brew, cinnamon, cocoa.
- Milks/flavors (9): milk, oat milk, soy milk, ice, whipped cream, chocolate cream, vanilla syrup, caramel syrup, chocolate syrup.
- Pastries/toppings (11): donut dough, cupcake batter, three glazes, sprinkles, four fruits, chocolate chips.

Player-visible processes:

- grind coffee/decaf beans, then brew each ground state through single-input espresso recipes;
- use cold brew as a prepared pickup instead of adding a pass-through cold station;
- fry prepared donut dough and bake prepared cupcake batter;
- slice fruit only when the cut state is visible and orderable-relevant.

Safe assembly:

- hot latte: required one-of coffee base plus required one-of milk;
- iced milk coffee: cold-brew base plus a group requiring two distinct additions from milk choices and ice;
- cream coffee: cold-brew base plus one to three bounded cream/flavor options;
- donut/cupcake: fried or baked base plus one to three bounded glaze, cream, fruit, sprinkle, or chip options.

Keep cups implicit until multi-input simulation handles every declared input. Use dirty hot cup, dirty cold cup, and dirty pastry plate outputs. Prepared dough and batter preserve the meaningful fry/bake action without spending the pickup budget on invisible pantry chemistry.

A compact version of this mixed cafe menu uses five tools: `coffee-grinder`, `coffee-machine`, `fryer`, `oven`, and `cutting-board`. A sixth `cold-station` is unnecessary when it only renames concentrate, but six or more tools remain valid when the extra stations add meaningful actions or when the user requests that count.

## Forward-test benchmark

The tested reconstructions produced:

| Menu | Pickups | Orderables | Max assembly depth | Validation warnings | Leftward wires | Normalized crossing ratio |
|---|---:|---:|---:|---:|---:|---:|
| Burger/soda/fried basket | 25 | 3 | 3 | 0 | 0 | 3.0% |
| Coffee drinks/donut/cupcake | 25 | 5 | 2 | 0 | 0 | 2.2% |

The normalized layout ratio divides pairwise straight-line crossings by eligible pairs of wires that do not share an endpoint. Raw crossing count is still reported for diagnosis.

## Audit checklist learned from the test

- Preserve exact orderable identifiers supplied as initial data.
- Draft the food-to-orderable map before adding ingredients.
- Recount reachable pickups after graph assembly; do not trust the ingredient list alone.
- Check schema edge cardinality before using multiple required/optional slots.
- Count the orderable itself when measuring assembly depth.
- Bound groups and individual options unless duplicate pieces are intentional.
- Prefer runtime-safe single-input processes and implicit vessels.
- Use 4–5 tools as a soft efficiency target; more is fine. Remove pass-through stations and needless duplicates, while honoring any explicit user tool count.
- Require one dirty result per orderable unless explicitly exempted.
- Treat sample warnings as historical debt, not acceptable defaults.
- Normalize crossing density by eligible wire pairs so large choice groups are judged fairly.

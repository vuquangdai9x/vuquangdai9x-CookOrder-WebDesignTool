# LINEAR AND HEURISTIC LEVEL DESIGN FRAMEWORK FOR COOKORDER

This framework establishes a scientific, pipeline-oriented method to construct levels for the queue-management game *CookOrder*. By leveraging cognitive load theory, player psychology, and mathematical constraints, this process translates abstract player experiences (target winrates, desired pacing, emotional peaks) into concrete physical level configurations.

---

## I. MAP CONSTANTS (FIXED PHYSICAL PARAMETERS)

Map Constants represent the immutable physics of a given Map. They remain constant across all levels designed for that specific Map, acting as the hard boundaries within which all psychological modeling takes place:

* **Grid Dimensions ($W \times H$):** The physical coordinates of the Prep Grid (e.g., $5 \times 2 = 10$ total cells in Map 1).


* **Dirty Dish Stack Limit ($N_{stack}$):** The maximum height of dirty dishes that can pile up in a single grid cell before spilling over (e.g., 3 dishes).


* **Queue Preview Depth ($V_{prev}$):** The sensory interface limitation defining the number of upcoming items visible to the player. This is a **per-map configuration value** (`visibleRows` in the map's config, default 3), not a hardcoded constant — 1 interactive top item plus $V_{prev}-1$ previewed items. A designer can widen or narrow it per map, which directly shifts how much planning-ahead the CLI model should assume.



---

## II. THE 4-LAYER ABSTRACT ARCHITECTURE

Designing directly with physical entities (e.g., item IDs, coordinate tables) often results in trial-and-error balancing. This framework separates design into four progressive abstract layers where each layer serves as the mathematical foundation for the next.

```
    (CLI target, Volume budget, Active toggles)
    │ 
    ▼
    (Effective Grid Area A_eff curve)
    │ 
    ▼
    (Recipe complexity REC, Congestion TC)
    │ 
    ▼
    OUTPUT (Customer Queue, Grid Config, Ingredient Queues)
```



### Layer 1: Emotional Anchor, Volume, & Level Mechanics Config
This layer maps the level's intended emotional pacing, player capacity limits, and active mechanics.

*   **Static Parameters (Level Specifications):**
    *   $P(Win)$: Target winrate for the level (e.g., 0.75 for intermediate players).[2]
    *   $T_{target}$: Target level duration in seconds (e.g., 120 seconds for a 2-minute level).
    *   $t_{comp}$: Time cost coefficient of a single recipe ingredient component, standardized at $t_{comp}=5$ seconds.[1]
    *   $C_{total}$: The theoretical budget of raw ingredient components processed during the level [1]:
    $$C_{total}=\frac{T_{target}}{t_{comp}}=\frac{T_{target}}{5}$$
    *   $Volume_{cust}$: Total customer order volume, defined as:
    $$Volume_{cust}=N_{cust}\times D_{avg}\times I_{avg}$$
    *(Where $N_{cust}$ is the total number of customers, $D_{avg}$ is the average number of dishes ordered per customer, and $I_{avg}$ is the average number of ingredient components per dish).*
    
    **Boundary Condition:** $Volume_{cust} \approx C_{total}$ must be enforced to align play session length with $T_{target}$.

    *   $C_{player}$: Information processing capacity of the target cohort (e.g., intermediate player = 4.5 bits/second).[3]
    *   $CLI_{peak}$: The maximum allowed Cognitive Load Index for the level, derived using an inverse logistic model (where $\lambda=1.5$ represents difficulty sensitivity scaling) [2]:
    $$CLI_{peak}=C_{player}-\frac{\ln\left(\frac{P(Win)}{1-P(Win)}\right)}{\lambda}$$
    *   **Level Queue Count ($N_{queues}$):** Number of active ingredient queues in the level, configured dynamically between 3 and 5.[1]
    *   **Active Mechanic Toggles:** Configures allowed level-specific status effects and rules [1]:
        *   *Grid Statuses:* Blocked, OrderLock, IngredientSlot, ColorLock.[1]
        *   *Queue Item Statuses:* Freeze (thaws from ADJACENT picks only — see Layer 3), Key-holder. (A "Locked" queue-item status does not exist in the engine — locking is a grid-cell concept, opened by keys picked up from queue items.)
        *   *Queue-level Grouping* (separate from item statuses): Combined slots (a rigid block that moves/is picked as one unit) and Linked slots (a chain, one cell per adjacent column, pickable only once every member reaches the front). Both are optional per-level design levers with no effect on any single item's status.
*   **Dynamic Parameters (Bezier Curves):**
    *   **Tension Curve $T(t)$:** Progression pacing across normalized level time $t \in [0.0, 1.0]$, scaling tension from $[0.0, 10.0]$.[4]
    *   **Cognitive Load Index $CLI(t)$:** Target cognitive load curve over time, derived from $T(t)$ such that $CLI(t_{climax}) \approx CLI_{peak}$.

### Layer 2: Spatial Constraints
Translates the tension curve into spatial restrictions on the Prep Grid, utilizing the Map Constants ($W \times H$, $N_{stack}$) and the active Grid Statuses defined in Layer 1.[1]

*   **Static Parameters:** $W \times H$, $N_{stack}$.
*   **Dynamic Parameters (Bezier Curves):**
    *   **Effective Grid Area $A_{eff}(t)$:** The minimum number of vacant grid cells required to prevent overflow. Mathematically formulated as [1]:
    $$A_{eff}(t)=(W\times H)-B-L_{active}(t)-P_{parked}(t)$$
    *(Where $B$ is the number of blocked cells, $L_{active}(t)$ is the number of locked cells, and $P_{parked}(t)$ is the count of excess ingredients parked on the grid due to congested tools).*
        $A_{eff}(t)$ is inversely proportional to $T(t)$ (lower available space increases tension).[2]

### Layer 3: Input Load & Tool Flow
Determines input rates and spatial congestion using the Level’s queue parameters and active status mechanics.[1]

*   **Static Parameters:** $V_{prev}$ (Map constant), $N_{queues}$ (Level configuration).
*   **Dynamic Parameters (Bezier Curves):**
    *   **Recipe Complexity $REC(t)$:** The average number of manual steps/cooking transformations per order at time $t$.[1]
    *   **Tool Congestion $TC(t)$:** The density of occupied slots in cooking tools (Pan, Chopping Board), directly scaling grid parking $P_{parked}(t)$ when the parking toggle is enabled.[1]
    *   **Queue Obstruction Frequency $F_{queue}(t)$:** The density of `Freezed` or `Locked` states on active queues to disrupt player routing.[1]

### Layer 4: Physical Compilation
Bi-directionally compiles Layer 1, 2, and 3 profiles into GDD-compliant, syntax-exact configuration strings for the game engine.[1]

---

## III. LINEAR & HEURISTIC LEVEL DESIGN ALGORITHM

This procedural step-by-step method allows designers to configure a balanced level with a predictable winrate.

### Step 1: Input Core Level Spec & Toggles
Define the starting requirements of the level and toggle active systems:
1.  **Emotion Map:** Target the emotional sequence: **Introduction (Competence) $\rightarrow$ Complication (Attention Splitting) $\rightarrow$ Climax (Micro-stress, Loss Aversion) $\rightarrow$ Resolution (Catharsis, Mastery)**.[2, 5, 4]
2.  **Target Winrate:** Set $P(Win) = 0.75$ (Intermediate player target, $C_{player} = 4.5$).[2]
3.  **Active Map Constants:** Retrieve parameters for Map 1 ($W \times H = 10$, $N_{stack} = 3$, $V_{prev} = 3$).[1]
4.  **Level Settings:**
    *   $N_{queues} = 3$ active queues.[1]
    *   *Grid:* Enable `Blocked` and `OrderLock` cells.[1]
    *   *Queue:* Enable `Freeze` and `Key-holder` items. Grouping (Combined/Linked slots) off for this pass.[1]

### Step 2: Temporal to Spatial Volume Translation
1.  Set the desired playtime: $T_{target} = 120$ seconds (2 minutes).
2.  Calculate ingredient component capacity:
$$C_{total}=\frac{120\text{ s}}{5\text{ s/component}}=24\text{ components}$$
3.  Synthesize the Customer Queue parameters to match the $Volume_{cust}$ budget:
    *   Total customers ($N_{cust}$) = 6.[1]
    *   Average dishes per customer ($D_{avg}$) = 1.[1]
    *   Average ingredients per dish ($I_{avg}$) = 4.
    *   Verify boundary constraint: $Volume_{cust} = 6 \times 1 \times 4 = 24 \approx C_{total}$ (Budget balanced).

### Step 3: Plot the Peak Cognitive Load Threshold
1.  Calculate $CLI_{peak}$ to guarantee the 75% winrate threshold [2]:
$$CLI_{peak}=4.5-\frac{\ln(3)}{1.5}\approx 3.77$$
2.  Structure the Bezier control points for the target load curve $CLI(t)$:
    *   *Warm-up ($t \in [0.0, 0.25]$):* $CLI(t) \in [1.0, 2.0]$ (Simple, direct ingredient processing).[1]
    *   *Complication ($t \in [0.25, 0.60]$):* $CLI(t) \in [2.0, 3.0]$ (Grid cells lock, dirty dishes return).[1]
    *   *Climax ($t \in [0.60, 0.85]$):* $CLI(t) \in [3.0, 3.77]$ (Peak congestion, frozen queues, minimal $A_{eff}$).[2, 1]
    *   *Resolution ($t \in [0.85, 1.00]$):* $CLI(t) \in [1.5, 2.5]$ (Cleaners introduced, tension drops).[1, 4]

### Step 4: Map Spatial Constraints & Effective Area ($A_{eff}$)
Heuristically scale $A_{eff}(t)$ to match the $CLI(t)$ tension profile:
*   **Intro ($t < 0.25$):** $A_{eff} \ge 8$ cells. Generous spatial clearance.[1]
*   **Complication ($t \in [0.25, 0.60]$):** $A_{eff} \approx 6$ cells. Place 1 Blocked cell (`#1`) and 1 Locked cell (`#2:2`) to restrict movement and trigger the Zeigarnik effect.[1, 4]
*   **Climax ($t \in [0.60, 0.85]$):** $A_{eff} \le 4$ cells. Drive rapid dirty dish accumulation. Flood identical orders to saturate tool slots, triggering the `Parking` toggle to spill raw ingredients onto the grid.[1]
*   **Resolution ($t > 0.85$):** $A_{eff} \ge 8$ cells. Grid cleared completely.[1]

### Step 5: Engineer Input Impedances & Catharsis Points
1.  **Input Friction:** Place a `Freeze:2` status effect on a vital ingredient at the head of Queue 3 during peak climax, positioned so Queue 2 or Queue 4 (an **adjacent** column) is something the player is naturally picking during this window — the thaw count only decrements from picks in a 4-connected neighbor slot (same column one row back, or an adjacent column same row), not from picks anywhere in the level. A Freeze with no realistically-adjacent traffic never thaws.[1]
2.  **Catharsis Design:** 
    *   Anchor Customer 4 as a `Staff` cleaner (`0;0;`). Arrival instantly wipes up to 2 dirty dish stacks.[1]
    *   Hide a `Sweeper` utility item (id `-1`) in Queue 1 at depth 4 to give the player active spatial recovery options.[1]

### Step 6: Generate Physical Configuration Strings
Compile all properties into parsed engine strings.[1]
// Every knob the difficulty solver used to hard-code, exposed as one editable
// "scoring scenario". Design pops the scenario modal
// (estimateScenarioDialog.ts) before each Estimate run; the solver
// (nodeEstimateDifficulty.ts) reads nothing but the resolved numbers below.
// Scoring defaults reproduce the former hard-coded weights. Run controls also
// include pick cadence so estimation reflects cooking still in progress when
// the real autoplay bot is allowed to make its next move.

export type ScenarioFieldKey =
  | "scoreBase"
  | "scoreReady"
  | "scoreBlocked"
  | "scoreBlockedTight"
  | "scoreSweeper"
  | "scoreSweeperUrgent"
  | "previewConfidence"
  | "depthBonusPerLevel"
  | "depthBonusCap"
  | "multiInputBaseBonus"
  | "multiInputBonus"
  | "nearCompletionBonus"
  | "customerPositionDecay"
  | "scarcityFactor"
  | "scarcityCap"
  | "lastInputBonusMulti"
  | "lastInputBonusSingle"
  | "rowDecay"
  | "detourPenalty"
  | "detourPenaltyTight"
  | "gridTightThreshold"
  | "pickIntervalSeconds"
  | "maxIterations"
  | "rngSeed"
  | "maxPairDishes"
  | "retryCount";

/** One row of the modal: its toggle, and the number its drag-input holds. */
export interface ScenarioField {
  enabled: boolean;
  value: number;
}

export interface EstimateScenario {
  /**
   * ON - Hidden slots stay hidden to the solver, exactly as a player sees
   * them. OFF (the default) - the queue is assumed already revealed, so
   * lookahead scores buried rows normally; an estimate then measures the
   * level's real structure rather than how much of it the player is guessing
   * at. The only status toggle: freeze, holding key and cell locks stay
   * simulated.
   */
  hiddenStatus: boolean;
  fields: Record<ScenarioFieldKey, ScenarioField>;
}

export interface ScenarioFieldSpec {
  key: ScenarioFieldKey;
  group: string;
  label: string;
  /** Value the field carries when its toggle is on and nothing was edited. */
  def: number;
  /** Value substituted when the toggle is OFF - i.e. what "disabled" means. */
  off: number;
  min: number;
  /** Optional upper bound, used by bounded controls such as retry count. */
  max?: number;
  /** Digits kept while drag-scrubbing; also what the input displays. */
  decimals: number;
  hint: string;
}

export const SCENARIO_GROUPS = ["Demand priority", "Bonuses & penalties", "Run controls"] as const;

export const SCENARIO_FIELDS: ScenarioFieldSpec[] = [
  {
    key: "scoreBase",
    group: "Demand priority",
    label: "Base slot",
    def: 1000,
    off: 0,
    min: 0,
    decimals: 0,
    hint: "Worth of an ingredient feeding a dish's base slot - nothing can be stacked before it.",
  },
  {
    key: "scoreReady",
    group: "Demand priority",
    label: "Ready slot (gate open)",
    def: 850,
    off: 0,
    min: 0,
    decimals: 0,
    hint: "Slot whose gate is already open, so the piece can be placed as soon as it exists.",
  },
  {
    key: "scoreBlocked",
    group: "Demand priority",
    label: "Blocked slot",
    def: 260,
    off: 0,
    min: 0,
    decimals: 0,
    hint: "Slot still waiting on the piece underneath it.",
  },
  {
    key: "scoreBlockedTight",
    group: "Demand priority",
    label: "Blocked slot, grid tight",
    def: 60,
    off: 0,
    min: 0,
    decimals: 0,
    hint: "Same, once the grid is at or below the tight threshold - parking work early gets punished.",
  },
  {
    key: "scoreSweeper",
    group: "Demand priority",
    label: "Sweeper",
    def: 500,
    off: 0,
    min: 0,
    decimals: 0,
    hint: "Worth of picking a sweeper while dirty stacks exist.",
  },
  {
    key: "scoreSweeperUrgent",
    group: "Demand priority",
    label: "Sweeper, grid tight",
    def: 1400,
    off: 0,
    min: 0,
    decimals: 0,
    hint: "Sweeper worth once the grid is tight and dirty stacks are what is filling it.",
  },
  {
    key: "previewConfidence",
    group: "Demand priority",
    label: "Upcoming composite hint",
    def: 0.08,
    off: 0,
    min: 0,
    max: 1,
    decimals: 3,
    hint: "Fractional demand assigned to the next three composite-only previews. Keep this low: their exact ingredients are still hidden.",
  },

  {
    key: "depthBonusPerLevel",
    group: "Bonuses & penalties",
    label: "Chain depth bonus per level",
    def: 45,
    off: 0,
    min: 0,
    decimals: 0,
    hint: "Added per production step behind an ingredient, so long chains start early.",
  },
  {
    key: "depthBonusCap",
    group: "Bonuses & penalties",
    label: "Chain depth bonus cap",
    def: 180,
    off: 0,
    min: 0,
    decimals: 0,
    hint: "Ceiling on the depth bonus.",
  },
  {
    key: "multiInputBaseBonus",
    group: "Bonuses & penalties",
    label: "Multi-input bonus (base slot)",
    def: 260,
    off: 0,
    min: 0,
    decimals: 0,
    hint: "Every input of a multi-input process producing a base is itself base-critical.",
  },
  {
    key: "multiInputBonus",
    group: "Bonuses & penalties",
    label: "Multi-input bonus (other slots)",
    def: 120,
    off: 0,
    min: 0,
    decimals: 0,
    hint: "Same idea, for non-base slots.",
  },
  {
    key: "nearCompletionBonus",
    group: "Bonuses & penalties",
    label: "Near-completion bonus per dish",
    def: 25,
    off: 0,
    min: 0,
    decimals: 0,
    hint: "Per dish under 4 still remaining - finish what is nearly done.",
  },
  {
    key: "customerPositionDecay",
    group: "Bonuses & penalties",
    label: "Later-customer decay",
    def: 0.12,
    off: 0,
    min: 0,
    decimals: 3,
    hint: "Priority is divided by 1 + position x this, so the front customer wins ties. 0 = all equal.",
  },
  {
    key: "scarcityFactor",
    group: "Bonuses & penalties",
    label: "Scarcity factor",
    def: 0.2,
    off: 0,
    min: 0,
    decimals: 3,
    hint: "How hard a scarce needed/available ratio lifts a leaf's score.",
  },
  {
    key: "scarcityCap",
    group: "Bonuses & penalties",
    label: "Scarcity cap",
    def: 0.45,
    off: 0,
    min: 0,
    decimals: 3,
    hint: "Ceiling on the scarcity multiplier, so priority still dominates.",
  },
  {
    key: "lastInputBonusMulti",
    group: "Bonuses & penalties",
    label: "Last missing input (multi-input)",
    def: 0.45,
    off: 0,
    min: 0,
    decimals: 3,
    hint: "Share of a claim's priority added when everything else it needs is already loaded.",
  },
  {
    key: "lastInputBonusSingle",
    group: "Bonuses & penalties",
    label: "Last missing input (single)",
    def: 0.2,
    off: 0,
    min: 0,
    decimals: 3,
    hint: "Same, for single-input recipes.",
  },
  {
    key: "rowDecay",
    group: "Bonuses & penalties",
    label: "Lookahead row decay",
    def: 0.5,
    off: 0,
    min: 0,
    decimals: 3,
    hint: "An item in row y is worth decay^y. 0 = the solver only ever values the front of a lane.",
  },
  {
    key: "detourPenalty",
    group: "Bonuses & penalties",
    label: "Detour penalty per footprint",
    def: 30,
    off: 0,
    min: 0,
    decimals: 0,
    hint: "Charged per grid cell a pick costs when the front item itself is worth nothing.",
  },
  {
    key: "detourPenaltyTight",
    group: "Bonuses & penalties",
    label: "Detour penalty, grid tight",
    def: 160,
    off: 0,
    min: 0,
    decimals: 0,
    hint: "Same, once the grid is tight.",
  },
  {
    key: "gridTightThreshold",
    group: "Bonuses & penalties",
    label: "Grid tight threshold",
    def: 0.5,
    off: 0,
    min: 0,
    decimals: 2,
    hint: "Free-cell fraction at or below which the tight variants kick in. 0 = never tight.",
  },

  {
    key: "pickIntervalSeconds",
    group: "Run controls",
    label: "Seconds between picks",
    def: 1,
    off: 0,
    min: 0,
    max: 5,
    decimals: 2,
    hint: "Gameplay time allowed to pass after an accepted pick before the solver may pick again. Cooking continues during this delay; visual transfers remain logically immediate.",
  },

  {
    key: "maxIterations",
    group: "Run controls",
    label: "Max picks before giving up",
    def: 5000,
    off: 100000,
    min: 1,
    decimals: 0,
    hint: "Safety valve against a pathological level.",
  },
  {
    key: "rngSeed",
    group: "Run controls",
    label: "RNG seed",
    def: 0x5eed,
    off: 0,
    min: 0,
    decimals: 0,
    hint: "Breaks ties between worthless picks. OFF = unseeded, so repeat runs differ.",
  },
  {
    key: "maxPairDishes",
    group: "Run controls",
    label: "Max paired dishes for 2-slot window",
    def: 5,
    off: 0,
    min: 0,
    decimals: 0,
    hint: "Two customers are served at once only while their dishes total at most this. 0 = never pair.",
  },
  {
    key: "retryCount",
    group: "Run controls",
    label: "Retry count",
    def: 10,
    off: 0,
    min: 0,
    max: 10,
    decimals: 0,
    hint: "After authored scoring fails, try simple profiles, then adaptive switching and bounded search (maximum 10).",
  },
];

export const SCENARIO_FIELD_BY_KEY = new Map(SCENARIO_FIELDS.map((spec) => [spec.key, spec]));

export function defaultScenario(): EstimateScenario {
  const fields = {} as Record<ScenarioFieldKey, ScenarioField>;
  for (const spec of SCENARIO_FIELDS) fields[spec.key] = { enabled: true, value: spec.def };
  return { hiddenStatus: false, fields };
}

export type ResolvedScenario = Record<ScenarioFieldKey, number> & {
  hiddenStatus: boolean;
  /** Per-field toggle state, for the one place where OFF is not just a number. */
  enabled: Record<ScenarioFieldKey, boolean>;
};

/** Flatten a scenario (or the defaults) into the plain numbers the solver reads. */
export function resolveScenario(scenario?: EstimateScenario | null): ResolvedScenario {
  const base = defaultScenario();
  const merged: EstimateScenario = scenario
    ? { ...base, ...scenario, fields: { ...base.fields, ...scenario.fields } }
    : base;
  const out = {
    hiddenStatus: merged.hiddenStatus,
    enabled: {} as Record<ScenarioFieldKey, boolean>,
  } as ResolvedScenario;
  for (const spec of SCENARIO_FIELDS) {
    const field = merged.fields[spec.key] ?? { enabled: true, value: spec.def };
    out.enabled[spec.key] = field.enabled;
    out[spec.key] = field.enabled ? field.value : spec.off;
  }
  return out;
}

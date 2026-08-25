// Copy/paste for a level's generator inputs.
//
// An in-app clipboard rather than the system one, because paste has to be
// RELIABLE: `navigator.clipboard.readText()` is permission-gated, async, and
// silently unavailable in plenty of contexts, and a paste that sometimes does
// nothing is worse than no paste at all. Copy still writes to the system
// clipboard as well, best-effort, so a designer can drop the string into a
// spreadsheet or a chat message — but nothing here depends on that working.
//
// THE SEED IS NEVER CARRIED. Copying a level's generator data and pasting it
// onto another is "make this level like that one"; carrying the seed across
// would instead make the two levels identical, which is the one thing a seed
// exists to make impossible to do by accident.

import type { LevelData } from "../../data/mapLoader.ts";

/** The generator inputs a level carries, minus the seed. */
export type GeneratorField = "weights" | "dishes" | "complexity" | "shuffle" | "obstacles";

export const GENERATOR_FIELDS: GeneratorField[] = [
  "weights",
  "dishes",
  "complexity",
  "shuffle",
  "obstacles",
];

export const FIELD_LABEL: Record<GeneratorField, string> = {
  weights: "Ingredient weights",
  dishes: "Dish sequence",
  complexity: "Complexity curve",
  shuffle: "Shuffle curve",
  obstacles: "Obstacles",
};

/** Read/write access to each field on a level, in one table. */
export const LEVEL_FIELD: Record<
  GeneratorField,
  { get(level: LevelData): string | undefined; set(level: LevelData, value: string | undefined): void }
> = {
  weights: {
    get: (level) => level.ingredientWeights,
    set: (level, value) => {
      if (value === undefined) delete level.ingredientWeights;
      else level.ingredientWeights = value;
    },
  },
  dishes: {
    get: (level) => level.customerDishesSequence,
    set: (level, value) => {
      if (value === undefined) delete level.customerDishesSequence;
      else level.customerDishesSequence = value;
    },
  },
  complexity: {
    get: (level) => level.complexityCurve,
    set: (level, value) => {
      if (value === undefined) delete level.complexityCurve;
      else level.complexityCurve = value;
    },
  },
  shuffle: {
    get: (level) => level.shuffleCurve,
    set: (level, value) => {
      if (value === undefined) delete level.shuffleCurve;
      else level.shuffleCurve = value;
    },
  },
  obstacles: {
    get: (level) => level.obstacleData,
    set: (level, value) => {
      if (value === undefined) delete level.obstacleData;
      else level.obstacleData = value;
    },
  },
};

/** What the clipboard holds: whichever fields were copied, and where from. */
export interface ClipboardEntry {
  fields: Partial<Record<GeneratorField, string>>;
  /** Level name it came from, for the menu label. */
  source: string;
}

let entry: ClipboardEntry | null = null;

/** Best-effort mirror to the system clipboard; failure is not an error here. */
function mirrorToSystem(text: string): void {
  void navigator.clipboard?.writeText?.(text).catch(() => {
    // No permission, or no clipboard API. The in-app copy already succeeded,
    // which is the one paste actually reads from.
  });
}

export function copyField(level: LevelData, field: GeneratorField): void {
  const value = LEVEL_FIELD[field].get(level) ?? "";
  entry = { fields: { [field]: value }, source: level.name };
  mirrorToSystem(value);
}

/** Copies every generator field the level sets. The seed is deliberately not among them. */
export function copyAll(level: LevelData): void {
  const fields: Partial<Record<GeneratorField, string>> = {};
  for (const field of GENERATOR_FIELDS) {
    const value = LEVEL_FIELD[field].get(level);
    if (value !== undefined) fields[field] = value;
  }
  entry = { fields, source: level.name };
  mirrorToSystem(
    GENERATOR_FIELDS.filter((f) => fields[f] !== undefined)
      .map((f) => `${f}: ${fields[f]}`)
      .join("\n"),
  );
}

export const clipboard = (): ClipboardEntry | null => entry;

/** Whether a paste onto this one field would do anything. */
export const canPasteField = (field: GeneratorField): boolean =>
  entry?.fields[field] !== undefined;

/** Whether a paste onto a whole level would do anything. */
export const canPasteAll = (): boolean => Object.keys(entry?.fields ?? {}).length > 0;

/**
 * Applies the clipboard's copy of one field. An empty string CLEARS the field
 * rather than writing "" — copying an unset field and pasting it elsewhere
 * should unset that one too, and "" is not a value the pipeline understands.
 */
export function pasteField(level: LevelData, field: GeneratorField): boolean {
  const value = entry?.fields[field];
  if (value === undefined) return false;
  LEVEL_FIELD[field].set(level, value === "" ? undefined : value);
  return true;
}

/** Applies every field the clipboard holds. Fields it does not hold are left alone. */
export function pasteAll(level: LevelData): GeneratorField[] {
  const applied: GeneratorField[] = [];
  for (const field of GENERATOR_FIELDS) {
    if (pasteField(level, field)) applied.push(field);
  }
  return applied;
}

/** Test seam. */
export function clearClipboard(): void {
  entry = null;
}

import { createHash } from "node:crypto";
import type { AuthoringResources } from "./repository.ts";
import { interpretLevelBrief } from "./brief.ts";
import { productionBehaviorEvidence } from "./productionBehavior.ts";
import type {
  ConstraintOperator,
  ConstraintValue,
  MetricConstraint,
  RefinedLevelRequirements,
  RequirementGap,
  RequirementPriority,
} from "./types.ts";

export type RequirementMode = RefinedLevelRequirements["mode"];

export interface RefineRequirementInput {
  brief: string;
  answers?: Record<string, unknown>;
  mode?: RequirementMode;
  batchSpec?: Record<string, unknown>;
  skipConfirmation?: boolean;
}

export interface RequirementDimensionDefinition {
  id: string;
  label: string;
  prompt: string;
  answerKeys: string[];
  requiredForInteractiveConfirmation: boolean;
  legalValues?: Array<string | number>;
  productionFixed?: boolean;
}

const DIMENSIONS: RequirementDimensionDefinition[] = [
  { id: "intent", label: "Intent", prompt: "Is this a new level, a revision, or a batch?", answerKeys: ["mode"], requiredForInteractiveConfirmation: true },
  { id: "experience", label: "Experience", prompt: "What difficulty, audience, and fairness target should the level have?", answerKeys: ["difficultyProfile", "audience", "fairness"], requiredForInteractiveConfirmation: true, legalValues: ["relaxed", "standard", "challenging", "expert"] },
  { id: "durationPacing", label: "Duration and pacing", prompt: "What duration and early/mid/late pressure curve should it target?", answerKeys: ["targetDurationSeconds", "pacing"], requiredForInteractiveConfirmation: false },
  { id: "customersOrders", label: "Customers and orders", prompt: "How many customers/dishes and what concurrency should be used?", answerKeys: ["customerCount", "dishCount", "customerConcurrency"], requiredForInteractiveConfirmation: true },
  { id: "content", label: "Content", prompt: "Which dishes, ingredients, tools, and variety limits are desired?", answerKeys: ["dishNames", "ingredientNames", "distinctComposites"], requiredForInteractiveConfirmation: false },
  { id: "queue", label: "Queue", prompt: "What lane count, depth, balance, and ordering pattern should be used?", answerKeys: ["queueLaneCount", "queueDepth", "queueStyle"], requiredForInteractiveConfirmation: false },
  { id: "amount", label: "Amount mechanics", prompt: "How strongly should amount compress queue lines, and what maximum atomic release is acceptable?", answerKeys: ["amountUtilization", "maxAmount", "amountReleaseStyle"], requiredForInteractiveConfirmation: true },
  { id: "gridCapacity", label: "Grid and capacity", prompt: "What occupancy pressure and usable capacity should be targeted?", answerKeys: ["peakOccupancy", "usableGridCells"], requiredForInteractiveConfirmation: false },
  { id: "mechanics", label: "Special mechanics", prompt: "Which effects, groups, or special customers are explicitly authorized?", answerKeys: ["authorizedMechanics"], requiredForInteractiveConfirmation: false },
  { id: "validation", label: "Validation", prompt: "What simulation confidence and run budget are required?", answerKeys: ["validationProfile", "minimumRuns", "confidence"], requiredForInteractiveConfirmation: false, legalValues: ["fast-shape", "tuning", "final"] },
  { id: "output", label: "Output", prompt: "What level name/id and destination should finalization use?", answerKeys: ["levelName", "levelId", "outputName"], requiredForInteractiveConfirmation: false },
];

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function createRequirementToken(requirement: Omit<RefinedLevelRequirements, "requirementToken">): string {
  return createHash("sha256").update(stable(requirement)).digest("hex");
}

function constraint(
  constraints: MetricConstraint[],
  dimension: string,
  metric: string,
  operator: ConstraintOperator,
  value: ConstraintValue,
  source: string,
  priority: RequirementPriority = "target",
  extra: Partial<Pick<MetricConstraint, "minimumRuns" | "confidence">> = {},
): void {
  constraints.push({ id: `requirement-${constraints.length + 1}`, dimension, metric, operator, value, priority, weight: priority === "hard" ? 10 : priority === "target" ? 3 : 1, source, ...extra });
}

function answerNumber(answers: Record<string, unknown>, key: string): number | undefined {
  const value = answers[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function answerText(answers: Record<string, unknown>, key: string): string | undefined {
  const value = answers[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizedDuration(value: unknown): number | [number, number] | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value) && value.length === 2 && value.every((item) => typeof item === "number" && Number.isFinite(item))) return [value[0] as number, value[1] as number];
  return undefined;
}

export function listRequirementDimensions(resources: AuthoringResources): Record<string, unknown> {
  const doc = resources.doc;
  return {
    mapId: doc.map.id,
    contextToken: resources.contextToken,
    dimensions: structuredClone(DIMENSIONS),
    mapCapabilities: {
      grid: { width: doc.map.gridWidth, height: doc.map.gridHeight, capacity: doc.map.gridWidth * doc.map.gridHeight },
      visibleQueueRows: doc.map.visibleRows,
      pickupableCount: doc.vertices.ingredient.filter((item) => item.pickupable).length,
      orderableCount: doc.vertices.composite.filter((item) => item.orderable).length,
      queueEffects: resources.queueEffects.map((effect) => ({ id: effect.id, name: effect.name })),
      gridEffects: resources.gridEffects.map((effect) => ({ id: effect.id, name: effect.name })),
    },
    productionBehavior: productionBehaviorEvidence(),
    note: "Runtime behavior is fixed for the real game and is intentionally not a requirement dimension.",
  };
}

export function refineRequirements(resources: AuthoringResources, input: RefineRequirementInput): RefinedLevelRequirements {
  const brief = input.brief.trim();
  if (!brief) throw new Error("The level brief must not be empty.");
  const mode = input.mode ?? "create";
  const answers = input.answers ?? {};
  const interpreted = interpretLevelBrief(brief);
  const constraints: MetricConstraint[] = [];
  const assumptions = [
    "Production simulation uses Unpacked raw, Auto tool processing, and raw park-on-grid.",
    "Amount N is one atomic pick that expands into N independent one-use physical items.",
    "Special mechanics not named in the brief remain unauthorized.",
  ];

  constraint(constraints, "fundamental", "fundamental.structuralErrors", "=", 0, "All authored levels must serialize and validate structurally.", "hard");
  constraint(constraints, "fundamental", "fundamental.exactSupply", "=", true, "Pickup supply must exactly serve demand after process yields.", "hard");
  constraint(constraints, "fundamental", "fundamental.solverVictory", "=", true, "Every customer must be served without timeout.", "hard", { minimumRuns: 1 });

  for (const item of interpreted.constraints) {
    if (item.unit === "customers") constraint(constraints, "customersOrders", "customers.count", item.kind === "range" ? "between" : "=", item.kind === "range" ? [item.min ?? 1, item.max ?? item.min ?? 1] : item.target ?? 1, item.source);
    if (item.unit === "queue lanes") constraint(constraints, "queue", "queue.laneCount", item.kind === "range" ? "between" : "=", item.kind === "range" ? [item.min ?? 1, item.max ?? item.min ?? 1] : item.target ?? 1, item.source);
    if (item.unit === "duration") constraint(constraints, "durationPacing", "experience.durationP50", item.kind === "range" ? "between" : "=", item.kind === "range" ? [item.min ?? 0, item.max ?? item.min ?? 0] : item.target ?? 0, item.source, "target", { minimumRuns: 10, confidence: 0.8 });
  }

  const difficultyProfile = answerText(answers, "difficultyProfile") ?? interpreted.difficultyProfile?.id;
  const customerCount = answerNumber(answers, "customerCount");
  const dishCount = answerNumber(answers, "dishCount");
  const queueLaneCount = answerNumber(answers, "queueLaneCount");
  const maxAmount = answerNumber(answers, "maxAmount");
  const amountUtilization = answers.amountUtilization;
  const duration = normalizedDuration(answers.targetDurationSeconds);
  const validationProfile = answerText(answers, "validationProfile") ?? "tuning";
  const minimumRuns = answerNumber(answers, "minimumRuns") ?? (validationProfile === "final" ? 100 : validationProfile === "fast-shape" ? 5 : 20);
  const confidence = answerNumber(answers, "confidence") ?? (validationProfile === "final" ? 0.95 : 0.8);

  if (customerCount !== undefined) constraint(constraints, "customersOrders", "customers.count", "=", Math.floor(customerCount), "Confirmed customer count.");
  if (dishCount !== undefined) constraint(constraints, "customersOrders", "customers.dishCount", "=", Math.floor(dishCount), "Confirmed dish count.");
  if (queueLaneCount !== undefined) constraint(constraints, "queue", "queue.laneCount", "=", Math.floor(queueLaneCount), "Confirmed queue lane count.");
  if (maxAmount !== undefined) constraint(constraints, "amount", "amount.maxAmount", "<=", Math.floor(maxAmount), "Confirmed maximum atomic amount release.", "hard");
  if (typeof amountUtilization === "number") constraint(constraints, "amount", "amount.compactedUnitRatio", ">=", amountUtilization, "Confirmed amount utilization target.");
  if (duration !== undefined) constraint(constraints, "durationPacing", "experience.durationP50", Array.isArray(duration) ? "between" : "=", duration, "Confirmed duration target.", "target", { minimumRuns, confidence });

  const amountMentioned = /\b(amount|stack|compact|compression|atomic release|burst)\b/i.test(brief);
  const customerSpecified = customerCount !== undefined || constraints.some((item) => item.metric === "customers.count");
  const amountSpecified = amountUtilization !== undefined || maxAmount !== undefined || amountMentioned;
  const unresolved: RequirementGap[] = [];
  if (!difficultyProfile) unresolved.push({ id: "missing-experience", dimension: "experience", message: "Difficulty and intended audience are not measurable yet.", question: "Choose a difficulty profile and optionally name the intended audience/fairness tolerance.", answerKeys: ["difficultyProfile", "audience", "fairness"] });
  if (!customerSpecified) unresolved.push({ id: "missing-scope", dimension: "customersOrders", message: "Level scope is unspecified.", question: "Provide a customer count, dish count, or target duration.", answerKeys: ["customerCount", "dishCount", "targetDurationSeconds"] });
  if (!amountSpecified) unresolved.push({ id: "missing-amount", dimension: "amount", message: "The desired use of amount mechanics is unspecified.", question: "Choose an amount utilization target or explicitly request no amount compression.", answerKeys: ["amountUtilization", "maxAmount", "amountReleaseStyle"] });

  const bypass = Boolean(input.skipConfirmation) || mode === "batch";
  const status: RefinedLevelRequirements["confirmationStatus"] = mode === "batch" ? "batch-inferred" : input.skipConfirmation ? "skipped" : "draft";
  if (bypass && unresolved.length) assumptions.push(...unresolved.map((gap) => `Inferred default for ${gap.dimension}: ${gap.message}`));
  const dimensions: Record<string, unknown> = {
    intent: { mode },
    experience: { difficultyProfile: difficultyProfile ?? "standard", audience: answerText(answers, "audience") ?? "general", fairness: answerText(answers, "fairness") ?? "avoid surprising hard locks" },
    durationPacing: { targetDurationSeconds: duration ?? null, pacing: answerText(answers, "pacing") ?? "steady" },
    customersOrders: { customerCount: customerCount ?? null, dishCount: dishCount ?? null, customerConcurrency: answerNumber(answers, "customerConcurrency") ?? 2 },
    content: { dishNames: answers.dishNames ?? [], ingredientNames: answers.ingredientNames ?? [], distinctComposites: answerNumber(answers, "distinctComposites") ?? null },
    queue: { laneCount: queueLaneCount ?? null, depth: answerNumber(answers, "queueDepth") ?? null, style: answerText(answers, "queueStyle") ?? "balanced" },
    amount: { utilization: amountUtilization ?? (bypass ? "balanced" : null), maxAmount: maxAmount ?? null, releaseStyle: answerText(answers, "amountReleaseStyle") ?? "capacity-safe" },
    gridCapacity: { peakOccupancy: answers.peakOccupancy ?? null, usableGridCells: answers.usableGridCells ?? resources.doc.map.gridWidth * resources.doc.map.gridHeight },
    mechanics: { authorized: interpreted.authorizedMechanics },
    validation: { profile: validationProfile, minimumRuns, confidence },
    output: { levelName: answerText(answers, "levelName") ?? null, levelId: answerNumber(answers, "levelId") ?? null, outputName: answerText(answers, "outputName") ?? null },
    ...(input.batchSpec ? { batch: structuredClone(input.batchSpec) } : {}),
  };
  const withoutToken: Omit<RefinedLevelRequirements, "requirementToken"> = {
    schemaVersion: 1,
    mapId: resources.doc.map.id,
    mode,
    originalBrief: brief,
    assumptions,
    dimensions,
    constraints,
    authorizedMechanics: interpreted.authorizedMechanics,
    unresolved: bypass ? [] : unresolved.slice(0, 3),
    confirmationStatus: status,
    contextToken: resources.contextToken,
  };
  return { ...withoutToken, requirementToken: createRequirementToken(withoutToken) };
}

export function confirmRequirements(requirements: RefinedLevelRequirements, confirmationNote: string): RefinedLevelRequirements {
  if (!confirmationNote.trim()) throw new Error("A confirmation_note is required.");
  if (requirements.unresolved.length) throw new Error(`Requirements still have unresolved dimensions: ${requirements.unresolved.map((gap) => gap.dimension).join(", ")}. Call refine_level_requirements again with answers.`);
  const { requirementToken: _oldToken, ...withoutOldToken } = requirements;
  void _oldToken;
  const withoutToken: Omit<RefinedLevelRequirements, "requirementToken"> = {
    ...withoutOldToken,
    confirmationStatus: requirements.mode === "batch" ? "batch-inferred" : "confirmed",
    confirmationNote: confirmationNote.trim(),
  };
  return { ...withoutToken, requirementToken: createRequirementToken(withoutToken) };
}

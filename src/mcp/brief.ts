import type {
  BriefInterpretation,
  DifficultyProfile,
  MechanicAuthorization,
  NormalizedConstraint,
} from "./types.ts";

const PROFILES: DifficultyProfile[] = [
  { id: "relaxed", label: "Relaxed", thresholds: { randomPickRatio: { max: 0.05 }, occupancyRatio: { max: 0.55 }, detourRatio: { max: 0.15 } } },
  { id: "standard", label: "Standard", thresholds: { randomPickRatio: { max: 0.12 }, occupancyRatio: { min: 0.25, max: 0.72 }, detourRatio: { min: 0.05, max: 0.3 } } },
  { id: "challenging", label: "Challenging", thresholds: { occupancyRatio: { min: 0.45, max: 0.88 }, detourRatio: { min: 0.16 }, peakConcurrentWork: { min: 2 } } },
  { id: "expert", label: "Expert", thresholds: { occupancyRatio: { min: 0.62, max: 0.96 }, detourRatio: { min: 0.28 }, peakConcurrentWork: { min: 3 } } },
];

const PROFILE_ALIASES: Record<string, string[]> = {
  relaxed: ["relaxed", "easy", "gentle", "beginner", "low pressure"],
  standard: ["standard", "normal", "medium", "moderate"],
  challenging: ["challenging", "hard", "difficult", "high pressure"],
  expert: ["expert", "very hard", "extreme", "mastery"],
};

const MECHANIC_TERMS: Array<[MechanicAuthorization, RegExp]> = [
  ["queue:freeze", /\b(freeze|frozen)\b/i],
  ["queue:hidden", /\bhidden(?: queue| slot| ingredient)?\b/i],
  ["queue:holding-key", /\b(holding\s*key|key-holding ingredient|queue key)\b/i],
  ["grid:blocked", /\bblocked (?:grid )?(?:cell|slot)s?\b/i],
  ["grid:order-lock", /\border\s*locks?\b/i],
  ["grid:ingredient-slot", /\bingredient\s*slots?\b/i],
  ["grid:color-lock", /\bcolou?r\s*locks?\b/i],
  ["group:combined", /\bcombined (?:groups?|slots?|pieces?)\b/i],
  ["group:linked", /\blinked (?:groups?|slots?|pieces?)\b/i],
  ["customer:timer", /\b(customer timers?|timed customers?|patience timers?|time limits?)\b/i],
  ["customer:staff", /\bstaff customers?\b/i],
  ["customer:boss", /\bboss(?:es| customers?)?\b/i],
  ["customer:shipper", /\bshippers?\b/i],
  ["dish:effect", /\bdish effects?\b/i],
];

function profileFor(text: string): DifficultyProfile | undefined {
  const lower = text.toLowerCase();
  const containsPhrase = (phrase: string): boolean => {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|\\b)${escaped}(?:\\b|$)`, "i").test(lower);
  };
  const candidates = Object.entries(PROFILE_ALIASES)
    .flatMap(([id, phrases]) => phrases.filter(containsPhrase).map((phrase) => ({ id, length: phrase.length })))
    .sort((a, b) => b.length - a.length);
  const id = candidates[0]?.id;
  return id ? structuredClone(PROFILES.find((profile) => profile.id === id)) : undefined;
}

function addNumericConstraints(brief: string, constraints: NormalizedConstraint[]): void {
  const patterns: Array<{ regex: RegExp; unit: string; kind: NormalizedConstraint["kind"] }> = [
    { regex: /(\d+)\s*(?:to|–|-)\s*(\d+)\s+customers?\b/i, unit: "customers", kind: "range" },
    { regex: /(\d+)\s+customers?\b/i, unit: "customers", kind: "count" },
    { regex: /(\d+)\s*(?:to|–|-)\s*(\d+)\s+(?:queue )?lanes?\b/i, unit: "queue lanes", kind: "range" },
    { regex: /(\d+)\s+(?:queue )?lanes?\b/i, unit: "queue lanes", kind: "count" },
    { regex: /(\d+(?:\.\d+)?)\s*%\s+([^.,;]+)/i, unit: "percent", kind: "ratio" },
    { regex: /(\d+)\s*(?:to|–|-)\s*(\d+)\s*(?:seconds?|secs?|minutes?|mins?)\b/i, unit: "duration", kind: "range" },
  ];
  for (const pattern of patterns) {
    const match = brief.match(pattern.regex);
    if (!match) continue;
    const source = match[0].trim();
    if (constraints.some((item) => item.source === source)) continue;
    constraints.push({
      id: `constraint-${constraints.length + 1}`,
      source,
      kind: pattern.kind,
      ...(pattern.kind === "range"
        ? { min: Number(match[1]) * (/min/i.test(source) ? 60 : 1), max: Number(match[2]) * (/min/i.test(source) ? 60 : 1) }
        : { target: Number(match[1]) }),
      unit: pattern.unit,
      status: "pending",
    });
  }
}

export function interpretLevelBrief(brief: string): BriefInterpretation {
  const trimmed = brief.trim();
  if (!trimmed) throw new Error("The level brief must not be empty.");
  const constraints: NormalizedConstraint[] = [];
  addNumericConstraints(trimmed, constraints);
  const authorizedMechanics = MECHANIC_TERMS
    .filter(([, pattern]) => pattern.test(trimmed))
    .map(([mechanic]) => mechanic);
  for (const [mechanic, pattern] of MECHANIC_TERMS) {
    const match = pattern.exec(trimmed); if (!match) continue;
    const prefix = trimmed.slice(Math.max(0, match.index - 48), match.index);
    const range = prefix.match(/(\d+)\s*(?:to|–|-)\s*(\d+)\s*$/i);
    const count = range ? undefined : prefix.match(/(\d+)\s*$/);
    constraints.push({
      id: `constraint-${constraints.length + 1}`,
      source: `${range?.[0] ?? count?.[0] ?? ""}${match[0]}`.trim(),
      kind: range ? "range" : count ? "count" : "mechanic",
      unit: mechanic,
      ...(range ? { min: Number(range[1]), max: Number(range[2]) } : count ? { target: Number(count[1]) } : {}),
      status: "pending",
    });
  }

  const difficultyProfile = profileFor(trimmed);
  const duration = constraints.find((constraint) => constraint.unit === "duration");
  if (difficultyProfile && duration) difficultyProfile.thresholds.durationSeconds = { min: duration.min ?? duration.target, max: duration.max ?? duration.target };
  if (difficultyProfile) constraints.push({
    id: `constraint-${constraints.length + 1}`,
    source: difficultyProfile.label,
    kind: "difficulty",
    unit: "profile",
    status: "pending",
  });

  const explicitDifficulty = trimmed.match(/\bdifficulty\s*(?:is|:|=)?\s*([^.;\n]+)/i)?.[1]?.trim();
  const needsProfileExtension = explicitDifficulty && !difficultyProfile
    ? {
        phrase: explicitDifficulty,
        nearestProfiles: ["standard", "challenging"],
        proposedProfile: { id: "proposed", label: explicitDifficulty, thresholds: {} },
      }
    : undefined;
  const unresolvedQualitativeRequirements: string[] = needsProfileExtension && explicitDifficulty ? [explicitDifficulty] : [];
  return {
    brief: trimmed,
    constraints,
    authorizedMechanics: [...new Set(authorizedMechanics)],
    difficultyProfile,
    needsProfileExtension,
    unresolvedQualitativeRequirements,
  };
}

export function difficultyProfiles(): DifficultyProfile[] {
  return structuredClone(PROFILES);
}

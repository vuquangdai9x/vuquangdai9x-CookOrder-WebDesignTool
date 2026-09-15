import type { LevelData } from "./mapLoader.ts";

export interface AgentLevelSource {
  sessionId: string;
  revision: number;
  evaluationId?: string;
}

export interface AgentLevelEntry {
  /** Stable browser identity. A republish of the same session revision replaces this entry. */
  id: string;
  mapId: string;
  name: string;
  weather: string;
  tag: string;
  refinedInstruction: string;
  publishedAt: string;
  source: AgentLevelSource;
  level: LevelData;
}

export interface AgentLevelProfile {
  schemaVersion: 1;
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  levels: AgentLevelEntry[];
}

export interface AgentLevelProfileRef {
  id: string;
  name: string;
  file: string;
  levelCount: number;
  updatedAt: string;
}

export interface AgentLevelIndex {
  schemaVersion: 1;
  profiles: AgentLevelProfileRef[];
}

export interface LoadedAgentLevels {
  profiles: AgentLevelProfile[];
  warnings: string[];
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${field} must be a finite number`);
  return value;
}

function parseLevel(value: unknown): LevelData {
  const row = object(value);
  if (!row) throw new Error("level must be an object");
  return {
    ...(row as unknown as LevelData),
    id: requiredNumber(row.id, "level.id"),
    name: requiredString(row.name, "level.name"),
    weather: requiredString(row.weather, "level.weather"),
    levelTag: typeof row.levelTag === "string" ? row.levelTag : "",
    featureUnlock: typeof row.featureUnlock === "string" ? row.featureUnlock : "",
    serveableSlots: requiredNumber(row.serveableSlots, "level.serveableSlots"),
    shuffleDistance: requiredNumber(row.shuffleDistance, "level.shuffleDistance"),
    queueString: requiredString(row.queueString, "level.queueString"),
    gridString: requiredString(row.gridString, "level.gridString"),
    customerString: requiredString(row.customerString, "level.customerString"),
  };
}

function parseProfileRef(value: unknown): AgentLevelProfileRef {
  const row = object(value);
  if (!row) throw new Error("profile reference must be an object");
  const file = requiredString(row.file, "profile.file");
  if (file.includes("..") || file.startsWith("/") || /^https?:/i.test(file)) {
    throw new Error(`profile.file must stay inside agent-levels: ${file}`);
  }
  return {
    id: requiredString(row.id, "profile.id"),
    name: requiredString(row.name, "profile.name"),
    file,
    levelCount: requiredNumber(row.levelCount, "profile.levelCount"),
    updatedAt: requiredString(row.updatedAt, "profile.updatedAt"),
  };
}

export function parseAgentLevelIndex(value: unknown): AgentLevelIndex {
  const data = object(value);
  if (!data || data.schemaVersion !== 1 || !Array.isArray(data.profiles)) {
    throw new Error("agent-levels/index.json has an unsupported schema");
  }
  return { schemaVersion: 1, profiles: data.profiles.map(parseProfileRef) };
}

export function parseAgentLevelProfile(value: unknown): AgentLevelProfile {
  const data = object(value);
  if (!data || data.schemaVersion !== 1 || !Array.isArray(data.levels)) {
    throw new Error("agent profile has an unsupported schema");
  }
  const levels = data.levels.map((item): AgentLevelEntry => {
    const row = object(item);
    const source = object(row?.source);
    if (!row || !source) throw new Error("profile level/source must be an object");
    const level = parseLevel(row.level);
    return {
      id: requiredString(row.id, "entry.id"),
      mapId: requiredString(row.mapId, "entry.mapId"),
      name: requiredString(row.name, "entry.name"),
      weather: typeof row.weather === "string" ? row.weather : level.weather,
      tag: typeof row.tag === "string" ? row.tag : level.levelTag,
      refinedInstruction: requiredString(row.refinedInstruction, "entry.refinedInstruction"),
      publishedAt: requiredString(row.publishedAt, "entry.publishedAt"),
      source: {
        sessionId: requiredString(source.sessionId, "entry.source.sessionId"),
        revision: requiredNumber(source.revision, "entry.source.revision"),
        ...(typeof source.evaluationId === "string" ? { evaluationId: source.evaluationId } : {}),
      },
      level,
    };
  });
  return {
    schemaVersion: 1,
    id: requiredString(data.id, "profile.id"),
    name: requiredString(data.name, "profile.name"),
    ...(typeof data.description === "string" && data.description.trim()
      ? { description: data.description }
      : {}),
    createdAt: requiredString(data.createdAt, "profile.createdAt"),
    updatedAt: requiredString(data.updatedAt, "profile.updatedAt"),
    levels,
  };
}

/** Load committed Agent Design data. One damaged profile does not hide the healthy profiles. */
export async function loadAgentLevels(
  baseUrl = new URL("agent-levels/", document.baseURI),
  request: typeof fetch = fetch,
): Promise<LoadedAgentLevels> {
  const indexResponse = await request(new URL("index.json", baseUrl));
  if (!indexResponse.ok) throw new Error(`Agent level index failed to load (${indexResponse.status})`);
  const index = parseAgentLevelIndex(await indexResponse.json());
  const warnings: string[] = [];
  const profiles = (await Promise.all(index.profiles.map(async (ref) => {
    try {
      const response = await request(new URL(ref.file, baseUrl));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const profile = parseAgentLevelProfile(await response.json());
      if (profile.id !== ref.id) throw new Error(`profile id is ${profile.id}, expected ${ref.id}`);
      if (profile.levels.length !== ref.levelCount) {
        warnings.push(`${profile.name}: index says ${ref.levelCount} levels, file contains ${profile.levels.length}.`);
      }
      return profile;
    } catch (error) {
      warnings.push(`${ref.name}: ${(error as Error).message}`);
      return null;
    }
  }))).filter((profile): profile is AgentLevelProfile => profile !== null);
  return { profiles, warnings };
}

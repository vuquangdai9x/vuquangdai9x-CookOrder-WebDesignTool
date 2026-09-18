import type {
  AuthoringContextArtifact,
  PhaseVectorArtifact,
  QueueMechanic,
} from "./contracts.ts";
import { artifactHash } from "./artifactHash.ts";

export interface CreateAuthoringContextInput {
  mapId: string;
  graphHash: string;
  referenceProfileId: string;
  authorizedMechanics?: QueueMechanic[];
  constraints?: Record<string, unknown>;
  createdAt?: string;
}

const timestamp = (provided?: string): string => provided ?? new Date().toISOString();

export function createAuthoringContext(input: CreateAuthoringContextInput): AuthoringContextArtifact {
  const content = {
    mapId: input.mapId,
    graphHash: input.graphHash,
    referenceProfileId: input.referenceProfileId,
    authorizedMechanics: [...new Set(input.authorizedMechanics ?? [])].sort(),
    constraints: input.constraints ?? {},
  };
  const contentHash = artifactHash(content);
  return {
    schemaVersion: 1,
    kind: "authoring-context",
    id: `authoring-context-${contentHash.slice(0, 12)}`,
    createdAt: timestamp(input.createdAt),
    seed: 0,
    upstreamHashes: [],
    contentHash,
    status: "valid",
    warnings: [],
    ...content,
  };
}

export interface CreateVectorDraftInput<TKind extends string, TVector extends { seed: number }> {
  kind: TKind;
  values: TVector;
  context: AuthoringContextArtifact;
  createdAt?: string;
}

export function createVectorDraft<TKind extends string, TVector extends { seed: number }>(
  input: CreateVectorDraftInput<TKind, TVector>,
): PhaseVectorArtifact<TKind, TVector> {
  const content = {
    kind: input.kind,
    values: input.values,
    contextHash: input.context.contentHash,
    graphHash: input.context.graphHash,
  };
  const contentHash = artifactHash(content);
  return {
    schemaVersion: 1,
    kind: input.kind,
    id: `${input.kind}-${contentHash.slice(0, 12)}`,
    createdAt: timestamp(input.createdAt),
    seed: input.values.seed,
    graphHash: input.context.graphHash,
    upstreamHashes: [input.context.contentHash],
    contentHash,
    status: "draft",
    warnings: [],
    values: input.values,
    contextHash: input.context.contentHash,
  };
}

export function reviseVectorDraft<TKind extends string, TVector extends { seed: number }>(
  artifact: PhaseVectorArtifact<TKind, TVector>,
  values: TVector,
  createdAt?: string,
): PhaseVectorArtifact<TKind, TVector> {
  const contentHash = artifactHash({
    kind: artifact.kind,
    values,
    contextHash: artifact.contextHash,
    graphHash: artifact.graphHash,
  });
  return {
    ...artifact,
    id: `${artifact.kind}-${contentHash.slice(0, 12)}`,
    createdAt: timestamp(createdAt),
    seed: values.seed,
    contentHash,
    status: "draft",
    warnings: [],
    values,
    confirmedAt: undefined,
    confirmedBy: undefined,
  };
}

export function confirmVector<TKind extends string, TVector>(
  artifact: PhaseVectorArtifact<TKind, TVector>,
  confirmedBy: string,
  confirmedAt?: string,
): PhaseVectorArtifact<TKind, TVector> {
  if (artifact.status === "stale") throw new Error("A stale vector cannot be confirmed.");
  if (!confirmedBy.trim()) throw new Error("confirmedBy is required.");
  return {
    ...artifact,
    status: "valid",
    confirmedAt: timestamp(confirmedAt),
    confirmedBy: confirmedBy.trim(),
  };
}

export function markArtifactStale<T extends { status: string }>(artifact: T): T {
  return { ...artifact, status: "stale" };
}

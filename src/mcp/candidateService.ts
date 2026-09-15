import type { CandidateRecord, SessionRecord } from "./types.ts";

const clone = <T>(value: T): T => structuredClone(value);

function candidateFromLegacy(session: SessionRecord): CandidateRecord {
  return {
    id: "candidate-main",
    name: "Main",
    revision: session.revision,
    draft: clone(session.draft),
    history: clone(session.history),
    idCounters: clone(session.idCounters),
    validationHistory: clone(session.validationHistory),
    playtestHistory: clone(session.playtestHistory),
    cycleCount: session.cycleCount,
    status: "active",
  };
}

export function ensureCandidateState(session: SessionRecord): SessionRecord {
  if (!session.candidates || !session.activeCandidateId) {
    const main = candidateFromLegacy(session);
    session.candidates = { [main.id]: main };
    session.activeCandidateId = main.id;
  }
  session.schemaVersion = 2;
  session.evaluations ??= {};
  session.seedSets ??= {};
  session.deadlockReports ??= {};
  session.proposals ??= {};
  session.experiments ??= {};
  session.searchObservations ??= [];
  return session;
}

export function activeCandidate(session: SessionRecord): CandidateRecord {
  ensureCandidateState(session);
  const candidate = session.candidates?.[session.activeCandidateId ?? ""];
  if (!candidate) throw new Error("The active candidate record is missing.");
  return candidate;
}

export function syncActiveCandidate(session: SessionRecord): void {
  const candidate = activeCandidate(session);
  candidate.revision = session.revision;
  candidate.draft = clone(session.draft);
  candidate.history = clone(session.history);
  candidate.idCounters = clone(session.idCounters);
  candidate.validationHistory = clone(session.validationHistory);
  candidate.playtestHistory = clone(session.playtestHistory);
  candidate.cycleCount = session.cycleCount;
}

export function activateCandidate(session: SessionRecord, candidateId: string): CandidateRecord {
  syncActiveCandidate(session);
  const candidate = session.candidates?.[candidateId];
  if (!candidate) throw new Error(`Unknown candidate "${candidateId}".`);
  if (candidate.status === "rejected") throw new Error(`Candidate "${candidateId}" is rejected. Keep it before selecting it.`);
  const current = activeCandidate(session);
  if (current.id !== candidate.id && current.status === "active") current.status = "kept";
  candidate.status = "active";
  session.activeCandidateId = candidate.id;
  session.revision = candidate.revision;
  session.draft = clone(candidate.draft);
  session.history = clone(candidate.history);
  session.idCounters = clone(candidate.idCounters);
  session.validationHistory = clone(candidate.validationHistory);
  session.playtestHistory = clone(candidate.playtestHistory);
  session.cycleCount = candidate.cycleCount;
  return candidate;
}

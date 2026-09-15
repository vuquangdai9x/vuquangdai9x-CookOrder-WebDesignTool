import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureCandidateState, syncActiveCandidate } from "./candidateService.ts";
import type { EvaluationRecord, EvaluationSeedSet, LevelBatchRecord, MutationExperimentRecord, ProposalRecord, RefinedLevelRequirements, SearchObservationRecord, SessionRecord } from "./types.ts";

const SESSION_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
const REQUIREMENT_TOKEN = /^[a-f0-9]{64}$/;

export class SessionStore {
  readonly root: string;
  private readonly memory = new Map<string, SessionRecord>();

  constructor(workspaceRoot = process.cwd(), outputRoot?: string) {
    this.root = outputRoot ? path.resolve(outputRoot) : path.resolve(workspaceRoot, "outputs", "mcp-level-sessions");
  }

  sessionDir(sessionId: string): string {
    if (!SESSION_ID.test(sessionId)) throw new Error("Session ids must be 3-64 lowercase letters, digits, or hyphens.");
    const target = path.resolve(this.root, sessionId);
    if (!target.startsWith(`${this.root}${path.sep}`)) throw new Error("Session path escaped the output root.");
    return target;
  }

  private batchFile(batchId: string): string {
    if (!SESSION_ID.test(batchId)) throw new Error("Invalid batch id.");
    return path.join(this.root, "batches", `${batchId}.json`);
  }

  async create(session: SessionRecord): Promise<void> {
    const dir = this.sessionDir(session.id);
    await Promise.all([
      mkdir(path.join(dir, "versions"), { recursive: true }),
      mkdir(path.join(dir, "candidates"), { recursive: true }),
      mkdir(path.join(dir, "evaluations"), { recursive: true }),
      mkdir(path.join(dir, "seed-sets"), { recursive: true }),
      mkdir(path.join(dir, "deadlock-reports"), { recursive: true }),
      mkdir(path.join(dir, "proposals"), { recursive: true }),
      mkdir(path.join(dir, "experiments"), { recursive: true }),
    ]);
    try {
      await readFile(path.join(dir, "session.json"), "utf8");
      throw new Error(`Session "${session.id}" already exists.`);
    } catch (error) {
      if (error instanceof Error && error.message.includes("already exists")) throw error;
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
    this.memory.set(session.id, structuredClone(session));
    await this.save(session);
    await appendFile(path.join(dir, "actions.ndjson"), `${JSON.stringify({ at: session.createdAt, revision: 0, action: "start_level_session" })}\n`, "utf8");
  }

  async load(sessionId: string): Promise<SessionRecord> {
    const cached = this.memory.get(sessionId);
    if (cached) return ensureCandidateState(structuredClone(cached));
    const parsed = JSON.parse(await readFile(path.join(this.sessionDir(sessionId), "session.json"), "utf8")) as SessionRecord;
    const wasLegacy = parsed.schemaVersion === 1 || !parsed.candidates;
    ensureCandidateState(parsed);
    this.memory.set(sessionId, structuredClone(parsed));
    if (wasLegacy) await this.save(parsed);
    return parsed;
  }

  async save(session: SessionRecord): Promise<void> {
    ensureCandidateState(session);
    syncActiveCandidate(session);
    const dir = this.sessionDir(session.id);
    await mkdir(path.join(dir, "versions"), { recursive: true });
    const target = path.join(dir, "session.json");
    const temporary = path.join(dir, ".session.json.tmp");
    await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, "utf8");
    await rename(temporary, target);
    this.memory.set(session.id, structuredClone(session));
  }

  async appendAction(sessionId: string, entry: unknown): Promise<void> {
    await appendFile(path.join(this.sessionDir(sessionId), "actions.ndjson"), `${JSON.stringify(entry)}\n`, "utf8");
  }

  async writeVersion(sessionId: string, revision: number, files: Record<string, string>): Promise<Record<string, string>> {
    const dir = path.join(this.sessionDir(sessionId), "versions");
    await mkdir(dir, { recursive: true });
    const prefix = `v${String(revision).padStart(3, "0")}`;
    const written: Record<string, string> = {};
    for (const [suffix, content] of Object.entries(files)) {
      const file = path.join(dir, `${prefix}-${suffix}`);
      await writeFile(file, content, "utf8");
      written[suffix] = file;
    }
    return written;
  }

  async writeCandidateVersion(sessionId: string, candidateId: string, revision: number, files: Record<string, string>): Promise<Record<string, string>> {
    if (!SESSION_ID.test(candidateId)) throw new Error("Invalid candidate id.");
    const dir = path.join(this.sessionDir(sessionId), "candidates", candidateId, "versions");
    await mkdir(dir, { recursive: true });
    const prefix = `v${String(revision).padStart(3, "0")}`;
    const written: Record<string, string> = {};
    for (const [suffix, content] of Object.entries(files)) {
      const file = path.join(dir, `${prefix}-${suffix}`);
      await writeFile(file, content, "utf8");
      written[suffix] = file;
    }
    return written;
  }

  async writeEvaluation(sessionId: string, evaluation: EvaluationRecord): Promise<string> {
    if (!SESSION_ID.test(evaluation.id)) throw new Error("Invalid evaluation id.");
    const relative = path.join("evaluations", `${evaluation.id}.json`);
    const target = path.join(this.sessionDir(sessionId), relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(evaluation, null, 2)}\n`, "utf8");
    return relative.replaceAll("\\", "/");
  }

  async writeSeedSet(sessionId: string, seedSet: EvaluationSeedSet): Promise<string> {
    if (!SESSION_ID.test(seedSet.id)) throw new Error("Invalid seed-set id.");
    const relative = path.join("seed-sets", `${seedSet.id}.json`);
    const target = path.join(this.sessionDir(sessionId), relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(seedSet, null, 2)}\n`, "utf8");
    return relative.replaceAll("\\", "/");
  }

  async writeDeadlockReport(sessionId: string, reportId: string, report: unknown): Promise<string> {
    if (!SESSION_ID.test(reportId)) throw new Error("Invalid deadlock report id.");
    const relative = path.join("deadlock-reports", `${reportId}.json`);
    const target = path.join(this.sessionDir(sessionId), relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return relative.replaceAll("\\", "/");
  }

  async readDeadlockReport(sessionId: string, reportId: string): Promise<unknown> {
    if (!SESSION_ID.test(reportId)) throw new Error("Invalid deadlock report id.");
    try {
      return JSON.parse(await readFile(path.join(this.sessionDir(sessionId), "deadlock-reports", `${reportId}.json`), "utf8")) as unknown;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") throw new Error(`Unknown deadlock report "${reportId}".`);
      throw error;
    }
  }

  async writeProposal(sessionId: string, proposal: ProposalRecord): Promise<string> {
    if (!SESSION_ID.test(proposal.id)) throw new Error("Invalid proposal id.");
    const relative = path.join("proposals", `${proposal.id}.json`);
    const target = path.join(this.sessionDir(sessionId), relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(proposal, null, 2)}\n`, "utf8");
    return relative.replaceAll("\\", "/");
  }

  async writeExperiment(sessionId: string, experiment: MutationExperimentRecord): Promise<string> {
    if (!SESSION_ID.test(experiment.id)) throw new Error("Invalid experiment id.");
    const relative = path.join("experiments", `${experiment.id}.json`);
    const target = path.join(this.sessionDir(sessionId), relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(experiment, null, 2)}\n`, "utf8");
    return relative.replaceAll("\\", "/");
  }

  async appendSearchObservation(sessionId: string, observation: SearchObservationRecord): Promise<string> {
    const relative = "search-observations.ndjson";
    await appendFile(path.join(this.sessionDir(sessionId), relative), `${JSON.stringify(observation)}\n`, "utf8");
    return relative;
  }

  async saveBatch(batch: LevelBatchRecord): Promise<void> {
    const target = this.batchFile(batch.id);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = path.join(path.dirname(target), `.${batch.id}.tmp`);
    await writeFile(temporary, `${JSON.stringify(batch, null, 2)}\n`, "utf8");
    await rename(temporary, target);
  }

  async loadBatch(batchId: string): Promise<LevelBatchRecord> {
    try {
      return JSON.parse(await readFile(this.batchFile(batchId), "utf8")) as LevelBatchRecord;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") throw new Error(`Unknown level batch "${batchId}".`);
      throw error;
    }
  }

  async appendIndex(row: string): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await appendFile(path.join(this.root, "session-index.csv"), row, "utf8");
  }

  async saveRequirements(requirements: RefinedLevelRequirements): Promise<void> {
    if (!REQUIREMENT_TOKEN.test(requirements.requirementToken)) throw new Error("Invalid requirement token.");
    const dir = path.join(this.root, "requirements");
    await mkdir(dir, { recursive: true });
    const target = path.join(dir, `${requirements.requirementToken}.json`);
    const temporary = path.join(dir, `.${requirements.requirementToken}.tmp`);
    await writeFile(temporary, `${JSON.stringify(requirements, null, 2)}\n`, "utf8");
    await rename(temporary, target);
  }

  async loadRequirements(requirementToken: string): Promise<RefinedLevelRequirements> {
    if (!REQUIREMENT_TOKEN.test(requirementToken)) throw new Error("Invalid requirement token.");
    try {
      return JSON.parse(await readFile(path.join(this.root, "requirements", `${requirementToken}.json`), "utf8")) as RefinedLevelRequirements;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") throw new Error("Unknown requirement token. Refine the level requirements again.");
      throw error;
    }
  }
}

import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  parseAgentLevelIndex,
  parseAgentLevelProfile,
  type AgentLevelEntry,
  type AgentLevelIndex,
  type AgentLevelProfile,
} from "../data/agentLevels.ts";
import { LevelAuthoringService, sessionDraftToLevelData } from "./service.ts";
import type { SessionRecord } from "./types.ts";

const execFile = promisify(execFileCallback);
const PROFILE_ID = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

interface Options {
  sessionId: string;
  profileName: string;
  profileId: string;
  description?: string;
  instruction?: string;
  instructionFile?: string;
  commit: boolean;
  push: boolean;
  remote: string;
  branch: string;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64);
}

function usage(): never {
  throw new Error(
    "Usage: npm run agent-level:append -- --session <id> --profile <name> " +
    "[--profile-id <slug>] [--description <text>] [--instruction <text> | --instruction-file <path>] " +
    "[--remote <git-remote>] [--branch <deploy-branch>]",
  );
}

function parseArgs(args: string[]): Options {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === "--commit" || key === "--push") {
      flags.add(key);
      continue;
    }
    if (!key.startsWith("--") || !args[i + 1] || args[i + 1].startsWith("--")) usage();
    values.set(key, args[++i]);
  }
  const sessionId = values.get("--session")?.trim();
  const profileName = values.get("--profile")?.trim();
  if (!sessionId || !profileName) usage();
  if (values.has("--instruction") && values.has("--instruction-file")) {
    throw new Error("Use either --instruction or --instruction-file, not both.");
  }
  const profileId = values.get("--profile-id")?.trim() || slug(profileName);
  if (!PROFILE_ID.test(profileId)) {
    throw new Error("Profile ids must be 3-64 lowercase letters, digits, or hyphens.");
  }
  return {
    sessionId,
    profileName,
    profileId,
    ...(values.get("--description") ? { description: values.get("--description") } : {}),
    ...(values.get("--instruction") ? { instruction: values.get("--instruction") } : {}),
    ...(values.get("--instruction-file") ? { instructionFile: values.get("--instruction-file") } : {}),
    commit: flags.has("--commit"),
    push: flags.has("--push"),
    remote: values.get("--remote")?.trim() || "origin",
    branch: values.get("--branch")?.trim() || "master",
  };
}

async function readJsonOrNull(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function atomicJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

function requirementPrompt(session: SessionRecord): string {
  const requirements = session.requirements;
  if (!requirements) {
    return session.originalBrief.trim() || `Create a CookOrder level for map ${session.mapId}.`;
  }
  const constraints = requirements.constraints.map((constraint) =>
    `- ${constraint.priority}: ${constraint.metric} ${constraint.operator} ${JSON.stringify(constraint.value)}`,
  );
  return [
    `Create a CookOrder level for map ${requirements.mapId}.`,
    `Original brief: ${requirements.originalBrief || session.originalBrief || "(not provided)"}`,
    `Confirmation: ${requirements.confirmationStatus}${requirements.confirmationNote ? ` — ${requirements.confirmationNote}` : ""}`,
    `Resolved dimensions:\n${JSON.stringify(requirements.dimensions, null, 2)}`,
    `Acceptance constraints:\n${constraints.join("\n") || "- No explicit metric constraints"}`,
    `Authorized mechanics: ${requirements.authorizedMechanics.join(", ") || "none"}`,
    requirements.assumptions.length ? `Assumptions:\n- ${requirements.assumptions.join("\n- ")}` : "Assumptions: none",
  ].join("\n\n");
}

async function refinedInstruction(options: Options, session: SessionRecord, root: string): Promise<string> {
  if (options.instruction?.trim()) return options.instruction.trim();
  if (options.instructionFile) {
    const target = path.resolve(root, options.instructionFile);
    const text = (await readFile(target, "utf8")).trim();
    if (!text) throw new Error(`Instruction file is empty: ${target}`);
    return text;
  }
  return requirementPrompt(session);
}

async function git(root: string, args: string[]): Promise<string> {
  const result = await execFile("git", args, { cwd: root, encoding: "utf8" });
  return result.stdout.trim();
}

async function commitAndPush(root: string, paths: string[], profileName: string, options: Options): Promise<string | null> {
  const status = await git(root, ["status", "--short", "--", ...paths]);
  if (!status) return null;
  await git(root, ["add", "--", ...paths]);
  await git(root, ["commit", "--only", "-m", `Publish Agent Design levels: ${profileName}`, "--", ...paths]);
  const commit = await git(root, ["rev-parse", "--short", "HEAD"]);
  if (options.push) await git(root, ["push", options.remote, `HEAD:${options.branch}`]);
  return commit;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.push && !options.commit) throw new Error("--push requires --commit.");
  const root = process.cwd();
  if (options.push) {
    const currentBranch = await git(root, ["branch", "--show-current"]);
    if (currentBranch !== options.branch) {
      throw new Error(`Refusing to publish ${currentBranch || "detached HEAD"} to ${options.remote}/${options.branch}. Check out ${options.branch} or pass the intended --branch explicitly.`);
    }
    const remotes = (await git(root, ["remote"])).split(/\r?\n/).filter(Boolean);
    if (!remotes.includes(options.remote)) throw new Error(`Unknown Git remote "${options.remote}".`);
  }
  const service = new LevelAuthoringService(root);
  let session = await service.store.load(options.sessionId);
  if (
    session.finalization?.revision !== session.revision ||
    session.finalization.candidateId !== session.activeCandidateId
  ) {
    const finalized = await service.finalizeLevel(options.sessionId);
    if (!finalized.finalized) {
      throw new Error(`Session ${options.sessionId} is not publishable: ${String(finalized.reason ?? "final validation failed")}`);
    }
    session = await service.store.load(options.sessionId);
  }

  const resources = await service.repository.load(session.mapId);
  const level = sessionDraftToLevelData(session.draft, resources);
  const publishedAt = new Date().toISOString();
  const instruction = await refinedInstruction(options, session, root);
  const entry: AgentLevelEntry = {
    id: `${session.id}-r${session.revision}`,
    mapId: session.mapId,
    name: level.name,
    weather: level.weather,
    tag: level.levelTag,
    refinedInstruction: instruction,
    publishedAt,
    source: {
      sessionId: session.id,
      revision: session.revision,
      ...(session.finalization?.evaluationId ? { evaluationId: session.finalization.evaluationId } : {}),
    },
    level,
  };

  const dataRoot = path.resolve(root, "public", "agent-levels");
  const profileRelative = `profiles/${options.profileId}.json`;
  const profilePath = path.resolve(dataRoot, profileRelative);
  if (!profilePath.startsWith(`${dataRoot}${path.sep}`)) throw new Error("Profile path escaped Agent Design data root.");
  const existingProfile = await readJsonOrNull(profilePath);
  const profile: AgentLevelProfile = existingProfile
    ? parseAgentLevelProfile(existingProfile)
    : {
        schemaVersion: 1,
        id: options.profileId,
        name: options.profileName,
        ...(options.description ? { description: options.description } : {}),
        createdAt: publishedAt,
        updatedAt: publishedAt,
        levels: [],
      };
  if (profile.id !== options.profileId) throw new Error(`Profile file id ${profile.id} does not match ${options.profileId}.`);
  profile.name = options.profileName;
  if (options.description !== undefined) profile.description = options.description;
  profile.updatedAt = publishedAt;
  const existingEntry = profile.levels.findIndex((candidate) => candidate.id === entry.id);
  if (existingEntry >= 0) profile.levels[existingEntry] = entry;
  else profile.levels.push(entry);

  const indexPath = path.join(dataRoot, "index.json");
  const existingIndex = await readJsonOrNull(indexPath);
  const index: AgentLevelIndex = existingIndex
    ? parseAgentLevelIndex(existingIndex)
    : { schemaVersion: 1, profiles: [] };
  const ref = {
    id: profile.id,
    name: profile.name,
    file: profileRelative,
    levelCount: profile.levels.length,
    updatedAt: profile.updatedAt,
  };
  const existingRef = index.profiles.findIndex((candidate) => candidate.id === profile.id);
  if (existingRef >= 0) index.profiles[existingRef] = ref;
  else index.profiles.push(ref);
  index.profiles.sort((a, b) => a.name.localeCompare(b.name));

  await atomicJson(profilePath, profile);
  await atomicJson(indexPath, index);

  const relativePaths = [path.relative(root, indexPath), path.relative(root, profilePath)];
  const commit = options.commit
    ? await commitAndPush(root, relativePaths, profile.name, options)
    : null;
  process.stdout.write(`${JSON.stringify({
    profile: { id: profile.id, name: profile.name, levels: profile.levels.length },
    entry: { id: entry.id, mapId: entry.mapId, name: entry.name },
    files: relativePaths.map((file) => file.replaceAll("\\", "/")),
    committed: Boolean(commit),
    commit,
    pushed: Boolean(commit && options.push),
    ...(options.push ? { remote: options.remote, branch: options.branch } : {}),
  }, null, 2)}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

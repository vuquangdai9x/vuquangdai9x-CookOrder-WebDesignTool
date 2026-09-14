import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SessionRecord } from "./types.ts";

const SESSION_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;

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

  async create(session: SessionRecord): Promise<void> {
    const dir = this.sessionDir(session.id);
    await mkdir(path.join(dir, "versions"), { recursive: true });
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
    if (cached) return structuredClone(cached);
    const parsed = JSON.parse(await readFile(path.join(this.sessionDir(sessionId), "session.json"), "utf8")) as SessionRecord;
    this.memory.set(sessionId, structuredClone(parsed));
    return parsed;
  }

  async save(session: SessionRecord): Promise<void> {
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

  async appendIndex(row: string): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await appendFile(path.join(this.root, "session-index.csv"), row, "utf8");
  }
}

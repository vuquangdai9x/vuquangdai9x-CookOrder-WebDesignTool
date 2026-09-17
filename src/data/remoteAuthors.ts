import authorsJson from "./config/general/remote-authors.json";

export interface RemoteAuthorAssignment {
  map: number;
  lv: string;
}

export interface RemoteAuthor {
  author: string;
  name: string;
  table: string;
  emoji: string;
  /** Accent used for author chips, badges, and the Remote Data picker. */
  colorTheme: string;
  /** Verified Google accounts allowed to write level data to this author's sheet. */
  allowedEmails: string[];
  assigned?: RemoteAuthorAssignment[];
}

/** Checked-in author registry shared by the Remote Data picker and future badges. */
export const REMOTE_AUTHORS: readonly RemoteAuthor[] = authorsJson;
export const CUSTOM_REMOTE_AUTHOR = "custom";

export function remoteAuthorForTable(table: string): RemoteAuthor | undefined {
  const normalized = table.trim().toLowerCase();
  return REMOTE_AUTHORS.find((author) => author.table.toLowerCase() === normalized);
}

export function canEmailWriteRemoteAuthor(author: RemoteAuthor, email: string): boolean {
  const normalized = email.trim().toLowerCase();
  return author.allowedEmails.some((allowed) => allowed.toLowerCase() === normalized);
}

/** Default preserves ownership; named profiles claim pushes; custom sheets clear ownership. */
export function pushedAuthorValue(table: string, currentAuthor: string | null | undefined): string {
  const profile = remoteAuthorForTable(table);
  if (profile?.author === "default") return currentAuthor ?? "";
  return profile?.author ?? "";
}

/** Supports the compact assignment grammar used by remote-authors.json: `1-4;6;8-10`. */
export function remoteAuthorAssignedLevels(author: RemoteAuthor, map: number): ReadonlySet<number> {
  const result = new Set<number>();
  const expression = author.assigned?.find((assignment) => assignment.map === map)?.lv ?? "";
  for (const part of expression.split(";")) {
    const token = part.trim();
    if (!token) continue;
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(token);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      for (let level = Math.min(from, to); level <= Math.max(from, to); level++) result.add(level);
      continue;
    }
    const level = Number(token);
    if (Number.isInteger(level) && level > 0) result.add(level);
  }
  return result;
}

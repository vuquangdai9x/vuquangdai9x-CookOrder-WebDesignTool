const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function canonical(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Artifact content must contain only finite numbers.");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "undefined") return "null";
  if (typeof value !== "object") throw new Error(`Artifact content cannot contain ${typeof value} values.`);
  if (seen.has(value)) throw new Error("Artifact content cannot contain circular references.");
  seen.add(value);
  let out: string;
  if (Array.isArray(value)) {
    out = `[${value.map((item) => canonical(item, seen)).join(",")}]`;
  } else {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key], seen)}`);
    out = `{${entries.join(",")}}`;
  }
  seen.delete(value);
  return out;
}

export function stableSerialize(value: unknown): string {
  return canonical(value, new Set());
}

function fnv1a(input: string, offset: number): number {
  let hash = offset >>> 0;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash;
}

/** Browser-safe deterministic content hash. It is an identity checksum, not a security primitive. */
export function artifactHash(value: unknown): string {
  const input = stableSerialize(value);
  const first = fnv1a(input, FNV_OFFSET);
  const second = fnv1a(input, FNV_OFFSET ^ 0x9e3779b9);
  return `${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
}

export function deriveSeed(seed: number, stream: string): number {
  return fnv1a(`${seed >>> 0}:${stream}`, FNV_OFFSET) || 1;
}

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}


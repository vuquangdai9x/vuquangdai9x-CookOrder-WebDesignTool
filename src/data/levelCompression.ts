import { deflateSync, inflateSync } from "fflate";
import type { LevelData } from "./mapLoader.ts";

/** v1: raw DEFLATE of UTF-8, encoded as unpadded Base64url. No '~' delimiter. */
export const LEVEL_COMPRESSION_PREFIX = "z1_";
const MAX_DECODED_BYTES = 1024 * 1024;

export function compressLevelString(source: string): string {
  if (source === "") return "";
  const input = new TextEncoder().encode(source);
  if (input.length > MAX_DECODED_BYTES) throw new Error("Level string exceeds 1 MiB");
  const bytes = deflateSync(input, { level: 9 });
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return LEVEL_COMPRESSION_PREFIX + btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Unprefixed strings remain compatible with the existing level grammar. */
export function decompressLevelString(source: string): string {
  if (!source.startsWith(LEVEL_COMPRESSION_PREFIX)) {
    if (/^z\d+_/.test(source)) throw new Error("Unsupported level compression version");
    return source;
  }
  const payload = source.slice(LEVEL_COMPRESSION_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || payload.length % 4 === 1) {
    throw new Error("Invalid compressed level string: expected Base64url");
  }
  try {
    const binary = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    const decoded = inflateSync(bytes);
    if (decoded.length === 0 || decoded.length > MAX_DECODED_BYTES) throw new Error("Invalid decoded size");
    return new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  } catch {
    throw new Error("Invalid compressed level string: cannot decode DEFLATE/UTF-8");
  }
}

/** Keep readable authoring strings and their persisted export copies in sync. */
const cachedSources = new WeakMap<LevelData, { customers: string; queues: string; customerCompressed: string; queuesCompressed: string }>();
export function refreshLevelCompression(level: LevelData): void {
  const cached = cachedSources.get(level);
  level.customerCompressed = cached?.customers === level.customerString
    ? cached.customerCompressed : compressLevelString(level.customerString);
  level.queuesCompressed = cached?.queues === level.queueString
    ? cached.queuesCompressed : compressLevelString(level.queueString);
  cachedSources.set(level, { customers: level.customerString, queues: level.queueString,
    customerCompressed: level.customerCompressed, queuesCompressed: level.queuesCompressed });
}

/** Only empty cells can be omitted; explicit statuses, including #0, survive. */
export function remoteGridString(source: string): string {
  return /^,*$/.test(source) ? "" : source;
}

export function remoteLevelValue(level: LevelData, key: string): string {
  if (key === "customerCompressed" || key === "queuesCompressed") {
    refreshLevelCompression(level);
    return level[key]!;
  }
  if (key === "gridString") return remoteGridString(level.gridString);
  return String((level as unknown as Record<string, unknown>)[key] ?? "");
}

export function remoteLevelPayload(level: LevelData): string {
  return [remoteLevelValue(level, "customerCompressed"), remoteGridString(level.gridString),
    remoteLevelValue(level, "queuesCompressed")].join("~");
}

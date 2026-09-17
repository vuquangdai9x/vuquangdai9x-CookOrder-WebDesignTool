import { deflateSync, inflateSync } from "fflate";
import { artifactHash, stableSerialize } from "../../generation/queue-first/artifactHash.ts";

export const GENERATOR_CELL_SAFE_LIMIT = 45_000;
const MAX_DECODED_BYTES = 4 * 1024 * 1024;

const prefixes = {
  "customer-first-generator": "cg1_",
  "generator-workspace": "gw2_",
  "queue-first/queue-phase": "qfq1_",
  "queue-first/pickup-phase": "qfp1_",
  "queue-first/customer-phase": "qfc1_",
} as const;

type PayloadKind = keyof typeof prefixes;

const schemaVersions: Record<PayloadKind, 1 | 2> = {
  "customer-first-generator": 1,
  "generator-workspace": 2,
  "queue-first/queue-phase": 1,
  "queue-first/pickup-phase": 1,
  "queue-first/customer-phase": 1,
};

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) throw new Error("expected Base64url payload");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

export function payloadContentHash(value: object): string {
  const { contentHash: _ignored, ...content } = value as Record<string, unknown>;
  return artifactHash(content);
}

export function withPayloadHash<T extends object>(value: T): T & { contentHash: string } {
  return { ...value, contentHash: payloadContentHash(value) };
}

export function encodeGeneratorPayload(value: { schemaVersion: 1 | 2; kind: PayloadKind; contentHash: string }): string {
  if (value.schemaVersion !== schemaVersions[value.kind]) {
    throw new Error(`Cannot encode ${value.kind}: expected schema ${schemaVersions[value.kind]}.`);
  }
  const expected = payloadContentHash(value);
  if (value.contentHash !== expected) throw new Error(`Cannot encode ${value.kind}: content hash mismatch.`);
  const bytes = new TextEncoder().encode(stableSerialize(value));
  if (bytes.length > MAX_DECODED_BYTES) throw new Error("Generator payload exceeds the 4 MiB decoded limit.");
  const encoded = prefixes[value.kind] + bytesToBase64Url(deflateSync(bytes, { level: 9 }));
  if (encoded.length > GENERATOR_CELL_SAFE_LIMIT) {
    throw new Error(`Generator payload is ${encoded.length.toLocaleString()} characters; safe sheet limit is ${GENERATOR_CELL_SAFE_LIMIT.toLocaleString()}.`);
  }
  return encoded;
}

export function decodeGeneratorPayload<T extends { schemaVersion: 1 | 2; kind: PayloadKind; contentHash: string }>(
  source: string,
  expectedKind: T["kind"],
): T {
  const prefix = prefixes[expectedKind];
  if (!source.startsWith(prefix)) {
    if (/^(?:cg|gw|qfq|qfp|qfc)\d+_/.test(source)) throw new Error(`Unsupported ${expectedKind} payload version.`);
    throw new Error(`Expected ${prefix} payload.`);
  }
  try {
    const inflated = inflateSync(base64UrlToBytes(source.slice(prefix.length)));
    if (inflated.length === 0 || inflated.length > MAX_DECODED_BYTES) throw new Error("invalid decoded size");
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(inflated)) as T;
    if (!parsed || parsed.schemaVersion !== schemaVersions[expectedKind] || parsed.kind !== expectedKind) {
      throw new Error("kind or schema mismatch");
    }
    if (parsed.contentHash !== payloadContentHash(parsed)) throw new Error("content hash mismatch");
    return parsed;
  } catch (error) {
    throw new Error(`Invalid ${expectedKind} payload: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function generatorPayloadPrefix(kind: PayloadKind): string {
  return prefixes[kind];
}

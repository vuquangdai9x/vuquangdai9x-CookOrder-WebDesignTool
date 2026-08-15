// The lookup layer between level data and the graph.
//
// Every integer in a queue, grid or customer string is a DATA ID, not a node.
// Resolving it goes through this table: `dataId -> node name -> vertex`.
// Nothing in the level data references graph structure, which is what lets a
// designer add, remove and rename nodes without silently repointing levels
// that are already committed.
//
// Three rules make that safe, and each one kills a specific failure:
//
//   Append-only  — a new node takes the next free id; ids are NEVER reused.
//                  Kills: a deleted id later handed to a different node,
//                  silently changing every old level that used it.
//   Tombstones   — deleting keeps the entry with `node: null` + the old name.
//                  Kills: silent repointing. A level still referencing it is a
//                  loud validation error naming the level and the dead node.
//   Free rename  — only the `node` field changes; the id is untouched.
//                  Kills: renaming patty-cooked -> beef-patty invalidating
//                  every burger level.
//
// This module owns BOTH directions and is the only way from a string to a
// vertex — there is deliberately no second path that could disagree with it.
//
// Pure: no DOM, no config imports, fully unit-testable.

import type { IdEntry, IdSpace, IdTable } from "./nodeGraphTypes.ts";

export const ID_SPACES: IdSpace[] = ["ingredient", "composite", "group", "tool", "dirty"];

/** Both directions, precomputed. Rebuild after any mint/retire — it does not track mutations. */
export interface IdIndex {
  byId: Record<IdSpace, Map<number, string>>;
  byNode: Record<IdSpace, Map<string, number>>;
  /** Retired ids, so a reference to one can be reported as retired rather than merely unknown. */
  retired: Record<IdSpace, Map<number, string>>;
}

function emptyTable(): IdTable {
  return { ingredient: [], composite: [], group: [], tool: [], dirty: [] };
}

/** A table with every space present and empty — the starting point for a new map. */
export function createIdTable(): IdTable {
  return emptyTable();
}

/**
 * Fills in any space the JSON omitted, so callers never have to null-check a
 * space. Returns a new table; the input is not mutated.
 */
export function normalizeIdTable(raw: Partial<IdTable> | undefined): IdTable {
  const out = emptyTable();
  if (!raw) return out;
  for (const space of ID_SPACES) out[space] = [...(raw[space] ?? [])];
  return out;
}

export function buildIdIndex(table: IdTable): IdIndex {
  const byId = {} as IdIndex["byId"];
  const byNode = {} as IdIndex["byNode"];
  const retired = {} as IdIndex["retired"];
  for (const space of ID_SPACES) {
    byId[space] = new Map();
    byNode[space] = new Map();
    retired[space] = new Map();
    for (const entry of table[space] ?? []) {
      if (entry.node === null || entry.node === undefined) {
        retired[space].set(entry.id, entry.retired ?? "");
        continue;
      }
      byId[space].set(entry.id, entry.node);
      byNode[space].set(entry.node, entry.id);
    }
  }
  return { byId, byNode, retired };
}

/** Node name for a data id, or null when the id is unknown OR retired. Never throws. */
export function nodeOf(ix: IdIndex, space: IdSpace, id: number): string | null {
  return ix.byId[space].get(id) ?? null;
}

/** Data id for a node name, or null when the node has no id minted yet. Never throws. */
export function idOf(ix: IdIndex, space: IdSpace, node: string): number | null {
  return ix.byNode[space].get(node) ?? null;
}

/** True when this id was deliberately retired — distinguishes "dead" from "never existed" in error messages. */
export function isRetired(ix: IdIndex, space: IdSpace, id: number): boolean {
  return ix.retired[space].has(id);
}

/** The name a retired id used to point at, for diagnostics. */
export function retiredName(ix: IdIndex, space: IdSpace, id: number): string | null {
  return ix.retired[space].get(id) ?? null;
}

/**
 * Next id for a space: one past the highest ever issued, INCLUDING tombstones.
 * Counting tombstones is the whole point — an id is never reissued, so a
 * level string can never silently start meaning something else.
 */
export function nextId(table: IdTable, space: IdSpace): number {
  let max = -1;
  for (const entry of table[space] ?? []) if (entry.id > max) max = entry.id;
  return max + 1;
}

/**
 * Assigns `node` the next free id and returns it. Idempotent: a node that
 * already holds an id keeps it, so calling this on every save is harmless.
 * Mutates `table`.
 */
export function mintId(table: IdTable, space: IdSpace, node: string): number {
  const existing = (table[space] ??= []).find((e) => e.node === node);
  if (existing) return existing.id;
  const id = nextId(table, space);
  table[space].push({ id, node });
  return id;
}

/**
 * Tombstones the entry for `node`: the id stays, `node` becomes null, and the
 * old name is kept in `retired`. A no-op when the node has no entry.
 * Mutates `table`. Returns the retired id, or null when there was nothing to retire.
 */
export function retireId(table: IdTable, space: IdSpace, node: string): number | null {
  const entry = (table[space] ?? []).find((e) => e.node === node);
  if (!entry) return null;
  entry.retired = node;
  entry.node = null;
  return entry.id;
}

/**
 * Points an existing id at a new node name — the rename path. The id is
 * untouched, so every level string referencing it keeps working. Returns false
 * when `from` has no entry (nothing to rename). Mutates `table`.
 */
export function renameNode(table: IdTable, space: IdSpace, from: string, to: string): boolean {
  const entry = (table[space] ?? []).find((e) => e.node === from);
  if (!entry) return false;
  entry.node = to;
  return true;
}

export interface IdTableIssue {
  space: IdSpace;
  id?: number;
  node?: string;
  message: string;
}

/**
 * Structural checks that don't need the graph: duplicate ids, duplicate node
 * names, negative ids, a tombstone that still names a node. Graph-aware checks
 * (does this name exist? is it the right kind?) live in nodeGraphValidate.ts,
 * which has the vertices to check against.
 */
export function validateIdTable(table: IdTable): IdTableIssue[] {
  const issues: IdTableIssue[] = [];
  for (const space of ID_SPACES) {
    const seenIds = new Map<number, IdEntry>();
    const seenNodes = new Map<string, number>();
    for (const entry of table[space] ?? []) {
      if (!Number.isInteger(entry.id) || entry.id < 0) {
        issues.push({ space, id: entry.id, message: `Id must be a non-negative integer, got ${entry.id}.` });
      }
      if (seenIds.has(entry.id)) {
        issues.push({ space, id: entry.id, message: `Duplicate id ${entry.id} in the ${space} space.` });
      } else {
        seenIds.set(entry.id, entry);
      }
      if (entry.node === null || entry.node === undefined) {
        if (!entry.retired) {
          issues.push({
            space,
            id: entry.id,
            message: `Id ${entry.id} is a tombstone but records no retired name — its history is lost.`,
          });
        }
        continue;
      }
      const prior = seenNodes.get(entry.node);
      if (prior !== undefined) {
        issues.push({
          space,
          node: entry.node,
          message: `"${entry.node}" is claimed by both id ${prior} and id ${entry.id}; a node may hold only one id.`,
        });
      } else {
        seenNodes.set(entry.node, entry.id);
      }
    }
  }
  return issues;
}

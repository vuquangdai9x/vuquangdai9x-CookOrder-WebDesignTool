// The lookup layer between level data and the graph.
//
// Every integer in a queue, grid or customer string is a DATA ID, not a node.
// Resolving it goes through this table: `dataId -> node name -> vertex`.
// Nothing in the level data references graph structure, which is what lets a
// designer rename nodes without silently repointing levels already committed.
//
// **The id IS the row's position.** `idTable.ingredient[13]` is what a queue
// digit `13` picks up; `idTable.composite[0]` is what a dish's `{c0:` names.
// There is deliberately no stored `id` field: a position and a number that are
// supposed to agree are two places to disagree, and the one that loses is
// always the one the level strings actually used.
//
// The consequence, stated plainly: REORDERING A SPACE RENUMBERS IT, and every
// committed level string indexing into it starts meaning something else. That
// is a real editing power (a designer can renumber the queue alphabet), not an
// accident — the editor confirms before doing it, naming how many levels are
// affected.
//
// Two rules keep the rest safe:
//
//   Tombstones   — deleting a node sets its slot to `{ node: null, retired }`
//                  rather than splicing it out. Splicing would shift every row
//                  after it and silently renumber ids nobody asked to change.
//   Free rename  — only the `node` field changes; the slot stays put, so
//                  renaming patty-cooked -> beef-patty invalidates nothing.
//
// This module owns BOTH directions and is the only way from a string to a
// vertex — there is deliberately no second path that could disagree with it.
//
// Pure: no DOM, no config imports, fully unit-testable.

import type { IdSpace, IdTable } from "./nodeGraphTypes.ts";

export const ID_SPACES: IdSpace[] = ["ingredient", "composite", "group", "tool", "dirty"];

/** Both directions, precomputed. Rebuild after any mint/retire — it does not track mutations. */
export interface IdIndex {
  byId: Record<IdSpace, Map<number, string>>;
  byNode: Record<IdSpace, Map<string, number>>;
  /** Retired ids, so a reference to one reads as retired rather than merely unknown. */
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

/** Build the two-way index. The array index of each entry is its data id. */
export function buildIdIndex(table: IdTable): IdIndex {
  const byId = {} as IdIndex["byId"];
  const byNode = {} as IdIndex["byNode"];
  const retired = {} as IdIndex["retired"];
  for (const space of ID_SPACES) {
    byId[space] = new Map();
    byNode[space] = new Map();
    retired[space] = new Map();
    (table[space] ?? []).forEach((entry, id) => {
      if (!entry || entry.node === null || entry.node === undefined) {
        retired[space].set(id, entry?.retired ?? "");
        return;
      }
      byId[space].set(id, entry.node);
      // First row wins on a duplicate name; INV-IDTABLE-UNIQUE reports it
      // rather than this silently picking the later one.
      if (!byNode[space].has(entry.node)) byNode[space].set(entry.node, id);
    });
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

/** True when this id was deliberately retired — distinguishes "dead" from "never existed". */
export function isRetired(ix: IdIndex, space: IdSpace, id: number): boolean {
  return ix.retired[space].has(id);
}

/** The name a retired id used to point at, for diagnostics. */
export function retiredName(ix: IdIndex, space: IdSpace, id: number): string | null {
  return ix.retired[space].get(id) ?? null;
}

/**
 * The id the next minted node would take: one past the last row, tombstones
 * included. Appending is the only allocation that changes nothing else.
 */
export function nextId(table: IdTable, space: IdSpace): number {
  return (table[space] ?? []).length;
}

/**
 * Appends `node` and returns its id. Idempotent: a node that already holds a
 * slot keeps it, so calling this on every save is harmless. Mutates `table`.
 */
export function mintId(table: IdTable, space: IdSpace, node: string): number {
  const existing = (table[space] ??= []).findIndex((e) => e?.node === node);
  if (existing !== -1) return existing;
  table[space].push({ node });
  return table[space].length - 1;
}

/**
 * Tombstones `node`'s slot: the row stays at its index, `node` becomes null,
 * and the old name is kept in `retired`. The row is NOT removed — removing it
 * would shift every later row down and renumber ids nobody touched.
 * Returns the retired id, or null when there was nothing to retire.
 */
export function retireId(table: IdTable, space: IdSpace, node: string): number | null {
  const at = (table[space] ?? []).findIndex((e) => e?.node === node);
  if (at === -1) return null;
  table[space][at] = { node: null, retired: node };
  return at;
}

/**
 * Points an existing slot at a new node name — the rename path. The index is
 * untouched, so every level string referencing it keeps working. Returns false
 * when `from` has no slot. Mutates `table`.
 */
export function renameNode(table: IdTable, space: IdSpace, from: string, to: string): boolean {
  const at = (table[space] ?? []).findIndex((e) => e?.node === from);
  if (at === -1) return false;
  table[space][at] = { ...table[space][at], node: to };
  return true;
}

/**
 * Moves a row within its space. THIS RENUMBERS: every id from
 * min(from,to) onward changes meaning, and so does every level string that
 * used one. Callers are expected to confirm first — see the editor's
 * `confirmRenumber`. Returns a new table; the input is not mutated.
 */
export function reorderIdEntry(table: IdTable, space: IdSpace, from: number, to: number): IdTable {
  const rows = table[space] ?? [];
  if (from === to || from < 0 || to < 0 || from >= rows.length || to >= rows.length) return table;
  const next = { ...table, [space]: [...rows] };
  const [moved] = next[space].splice(from, 1);
  next[space].splice(to, 0, moved);
  return next;
}

export interface IdTableIssue {
  space: IdSpace;
  id?: number;
  node?: string;
  message: string;
}

/**
 * Structural checks that don't need the graph: a duplicate node name, a
 * tombstone with no recorded history, a hole. Graph-aware checks (does this
 * name exist? is it the right kind?) live in nodeGraphValidate.ts, which has
 * the vertices to check against.
 *
 * Duplicate IDS are impossible now — an id is an array index — which is the
 * main thing the positional model buys.
 */
export function validateIdTable(table: IdTable): IdTableIssue[] {
  const issues: IdTableIssue[] = [];
  for (const space of ID_SPACES) {
    const seenNodes = new Map<string, number>();
    (table[space] ?? []).forEach((entry, id) => {
      if (!entry) {
        issues.push({ space, id, message: `Id ${id} in the ${space} space is a hole; use a tombstone instead.` });
        return;
      }
      if (entry.node === null || entry.node === undefined) {
        if (!entry.retired) {
          issues.push({
            space,
            id,
            message: `Id ${id} is a tombstone but records no retired name — its history is lost.`,
          });
        }
        return;
      }
      const prior = seenNodes.get(entry.node);
      if (prior !== undefined) {
        issues.push({
          space,
          node: entry.node,
          message: `"${entry.node}" is claimed by both id ${prior} and id ${id}; a node may hold only one id.`,
        });
      } else {
        seenNodes.set(entry.node, id);
      }
    });
  }
  return issues;
}

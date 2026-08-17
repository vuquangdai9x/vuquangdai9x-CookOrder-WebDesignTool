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
//   Delete renumbers — removing a row splices it out and shifts every later id
//                  down. There are no tombstones: a dead slot would be a second
//                  kind of row for every reader to handle, and the renumber is
//                  a consequence the designer confirms either way.
//   Free rename  — the row's position never moves, so renaming
//                  patty-cooked -> beef-patty invalidates nothing.
//
// This module owns BOTH directions and is the only way from a string to a
// vertex — there is deliberately no second path that could disagree with it.
//
// Pure: no DOM, no config imports, fully unit-testable.

import type { IdSpace, IdTable } from "./nodeGraphTypes.ts";

export const ID_SPACES: IdSpace[] = ["ingredient", "composite", "group", "tool", "dirty"];

/** Both directions, precomputed. Rebuild after any mint/remove — it does not track mutations. */
export interface IdIndex {
  byId: Record<IdSpace, Map<number, string>>;
  byNode: Record<IdSpace, Map<string, number>>;
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

/** Build the two-way index. The array index of each name is its data id. */
export function buildIdIndex(table: IdTable): IdIndex {
  const byId = {} as IdIndex["byId"];
  const byNode = {} as IdIndex["byNode"];
  for (const space of ID_SPACES) {
    byId[space] = new Map();
    byNode[space] = new Map();
    (table[space] ?? []).forEach((node, id) => {
      if (!node) return; // an empty row; validateIdTable reports it
      byId[space].set(id, node);
      // First row wins on a duplicate name; INV-IDTABLE-UNIQUE reports it
      // rather than this silently picking the later one.
      if (!byNode[space].has(node)) byNode[space].set(node, id);
    });
  }
  return { byId, byNode };
}

/** Node name for a data id, or null when the id is unknown OR retired. Never throws. */
export function nodeOf(ix: IdIndex, space: IdSpace, id: number): string | null {
  return ix.byId[space].get(id) ?? null;
}

/** Data id for a node name, or null when the node has no id minted yet. Never throws. */
export function idOf(ix: IdIndex, space: IdSpace, node: string): number | null {
  return ix.byNode[space].get(node) ?? null;
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
  const existing = (table[space] ??= []).indexOf(node);
  if (existing !== -1) return existing;
  table[space].push(node);
  return table[space].length - 1;
}

/**
 * Removes `node`'s row. THIS RENUMBERS: every id after it shifts down by one,
 * and so does the meaning of every level string that used one. Callers confirm
 * first — see the editor's delete path. Returns the id the row held, or null
 * when there was nothing to remove. Mutates `table`.
 */
export function removeId(table: IdTable, space: IdSpace, node: string): number | null {
  const at = (table[space] ?? []).indexOf(node);
  if (at === -1) return null;
  table[space].splice(at, 1);
  return at;
}

/**
 * Points an existing slot at a new node name — the rename path. The index is
 * untouched, so every level string referencing it keeps working. Returns false
 * when `from` has no slot. Mutates `table`.
 */
export function renameNode(table: IdTable, space: IdSpace, from: string, to: string): boolean {
  const at = (table[space] ?? []).indexOf(from);
  if (at === -1) return false;
  table[space][at] = to;
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
 * Structural checks that don't need the graph: a duplicate name, an empty row.
 * Graph-aware checks (does this name exist? is it the right kind?) live in
 * nodeGraphValidate.ts, which has the vertices to check against.
 *
 * Duplicate IDS are impossible — an id is an array index — which is the main
 * thing the positional model buys.
 */
export function validateIdTable(table: IdTable): IdTableIssue[] {
  const issues: IdTableIssue[] = [];
  for (const space of ID_SPACES) {
    const seenNodes = new Map<string, number>();
    (table[space] ?? []).forEach((node, id) => {
      if (!node) {
        issues.push({ space, id, message: `Id ${id} in the ${space} space names nothing.` });
        return;
      }
      const prior = seenNodes.get(node);
      if (prior !== undefined) {
        issues.push({
          space,
          node,
          message: `"${node}" is claimed by both id ${prior} and id ${id}; a node may hold only one id.`,
        });
      } else {
        seenNodes.set(node, id);
      }
    });
  }
  return issues;
}


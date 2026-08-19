// Reading a graph document back out of a JSON file.
//
// The counterpart to Map Process's "⬇ JSON" export, and it holds the same
// contract `csvToGraph` does: **total on garbage**. A designer importing a
// hand-edited or older file must get a document plus a list of what could not
// be read, never a throw that loses their file with a stack trace.
//
// So every bucket the rest of the code indexes into is guaranteed present
// afterwards — `doc.vertices.ingredient`, `doc.edges.process`,
// `doc.idTable.composite` and so on. A reader downstream does `doc.vertices[k]
// .filter(...)`; there is no safe way for it to discover a missing bucket, so
// the repair happens here, once, and is reported rather than hidden.

import { ID_SPACES } from "./nodeIdTable.ts";
import type { IdSpace, IdTable } from "./nodeGraphTypes.ts";
import type { EdgeKindName, VertexKindName } from "./nodeGraphTypes.ts";
import type { NodeGraphMap } from "./nodeGraphTypes.ts";
import { EDGE_KIND_NAMES, VERTEX_KIND_NAMES } from "./nodeGraphSchema.ts";

export interface GraphJsonResult {
  /** Null only when the text is not JSON at all, or is not an object. */
  doc: NodeGraphMap | null;
  /** Everything that had to be repaired or dropped, in reading order. */
  issues: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Coerce one id space to the positional form.
 *
 * Accepts the retired `{ id, node }[]` shape as well, because an older export
 * is exactly the kind of file someone reaches for the import button with. Those
 * rows are placed at their stated `id` so the numbering committed levels depend
 * on survives, and any gap left behind is reported rather than quietly closed —
 * closing it would shift every id after the gap onto a different node.
 */
function readIdSpace(raw: unknown, space: IdSpace, issues: string[]): string[] {
  if (!Array.isArray(raw)) {
    if (raw !== undefined) issues.push(`idTable.${space} is not a list — treated as empty`);
    return [];
  }

  const rows: string[] = [];
  let legacyRows = 0;
  raw.forEach((row, i) => {
    if (typeof row === "string") {
      rows[rows.length] = row;
      return;
    }
    if (isRecord(row) && typeof row.node === "string" && typeof row.id === "number") {
      legacyRows++;
      rows[row.id] = row.node;
      return;
    }
    // A tombstone (`node: null`) lands here too: it holds an id open, which the
    // sparse array below preserves as an empty row.
    if (isRecord(row) && row.node === null) {
      legacyRows++;
      return;
    }
    issues.push(`idTable.${space}[${i}] is not a name — dropped`);
  });

  if (legacyRows > 0) {
    issues.push(`idTable.${space}: converted ${legacyRows} row(s) from the old {id,node} format`);
  }
  // Sparse holes become "", which `validateNodeGraph` reports as an empty row
  // — visible, and without shifting any id.
  const filled = Array.from(rows, (name) => name ?? "");
  const gaps = filled.filter((name) => name === "").length;
  if (gaps > 0) issues.push(`idTable.${space}: ${gaps} id(s) have no node — left empty to keep numbering`);
  return filled;
}

/** Parse a graph document from JSON text, repairing what it can. */
export function parseGraphJson(text: string): GraphJsonResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { doc: null, issues: [`Not valid JSON: ${(err as Error).message}`] };
  }
  if (!isRecord(parsed)) return { doc: null, issues: ["Top level is not an object"] };

  const issues: string[] = [];
  const rawMap = isRecord(parsed.map) ? parsed.map : {};
  if (!isRecord(parsed.map)) issues.push("No `map` block — defaults used for grid size and name");

  const num = (v: unknown, fallback: number) => (typeof v === "number" && v > 0 ? v : fallback);
  const str = (v: unknown, fallback: string) => (typeof v === "string" && v ? v : fallback);

  const vertices = {} as NodeGraphMap["vertices"];
  for (const kind of VERTEX_KIND_NAMES as VertexKindName[]) {
    const raw = (parsed.vertices as Record<string, unknown> | undefined)?.[kind];
    if (Array.isArray(raw)) {
      const rows = raw.filter(isRecord).filter((v: Record<string, unknown>) => typeof v.name === "string" && v.name);
      if (rows.length !== raw.length) {
        issues.push(`vertices.${kind}: dropped ${raw.length - rows.length} row(s) with no name`);
      }
      if (kind === "ingredient") {
        const retired = rows.filter((row) => "servable" in row).length;
        for (const row of rows) delete row.servable;
        if (retired > 0) issues.push(`vertices.ingredient: removed ${retired} retired servable field(s); servability is derived from order slots`);
      }
      vertices[kind] = rows as never;
    } else {
      if (raw !== undefined) issues.push(`vertices.${kind} is not a list — treated as empty`);
      vertices[kind] = [] as never;
    }
  }

  // Every edge must name both ends; an edge missing one cannot be drawn or
  // followed, and leaving it in would fail later at a point far from the file.
  const known = new Set(
    Object.values(vertices).flatMap((rows: { name: string }[]) => rows.map((v) => v.name)),
  );
  const edges = {} as NodeGraphMap["edges"];
  for (const kind of EDGE_KIND_NAMES as EdgeKindName[]) {
    const raw = (parsed.edges as Record<string, unknown> | undefined)?.[kind];
    if (Array.isArray(raw)) {
      const rows = raw.filter(
        (e): e is Record<string, unknown> =>
          isRecord(e) && typeof e.from === "string" && typeof e.to === "string",
      );
      if (rows.length !== raw.length) {
        issues.push(`edges.${kind}: dropped ${raw.length - rows.length} row(s) missing from/to`);
      }
      const live = rows.filter((e) => known.has(e.from as string) && known.has(e.to as string));
      if (live.length !== rows.length) {
        issues.push(`edges.${kind}: dropped ${rows.length - live.length} row(s) naming a missing node`);
      }
      edges[kind] = live as never;
    } else {
      if (raw !== undefined) issues.push(`edges.${kind} is not a list — treated as empty`);
      edges[kind] = [] as never;
    }
  }

  const rawTable = isRecord(parsed.idTable) ? parsed.idTable : {};
  if (!isRecord(parsed.idTable)) issues.push("No `idTable` — imported with empty id spaces");
  const idTable = {} as IdTable;
  for (const space of ID_SPACES) idTable[space] = readIdSpace(rawTable[space], space, issues);

  const doc: NodeGraphMap = {
    // Unknown `_*` keys ride along, so an import/export round trip diffs clean.
    ...(parsed as Partial<NodeGraphMap>),
    schemaVersion: typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : 1,
    map: {
      ...(rawMap as unknown as NodeGraphMap["map"]),
      id: str(rawMap.id, "imported"),
      name: str(rawMap.name, str(rawMap.id, "Imported map")),
      gridWidth: num(rawMap.gridWidth, 4),
      gridHeight: num(rawMap.gridHeight, 4),
      dirtyStackHeight: num(rawMap.dirtyStackHeight, 3),
      visibleRows: num(rawMap.visibleRows, 3),
    },
    idTable,
    vertices,
    edges,
    layout: isRecord(parsed.layout) ? (parsed.layout as NodeGraphMap["layout"]) : {},
    notes: Array.isArray(parsed.notes) ? (parsed.notes as NodeGraphMap["notes"]) : [],
  };

  return { doc, issues };
}

/** Total vertices across every kind — what the import dialog reports. */
export function vertexCount(doc: NodeGraphMap): number {
  return (VERTEX_KIND_NAMES as VertexKindName[]).reduce((n, k) => n + doc.vertices[k].length, 0);
}

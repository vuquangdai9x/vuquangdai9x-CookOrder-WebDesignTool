// One self-describing CSV for a whole graph document.
//
// `#`-prefixed rows declare the columns for the rows beneath them, and the
// column list is GENERATED FROM schema.json's `fields[]` — so adding a field to
// the schema widens the CSV with no code change here, and an older file that
// lacks the column still imports (a missing column is simply an absent value).
//
//   #VERTEX,ingredient,name,displayName,pickupable,usageNum,...
//   VERTEX,ingredient,bun,Bun,TRUE,FALSE,,...
//   #EDGE,process,from,to,inputs,amount,duration,chainTools
//   EDGE,process,cutting-board,bun-sliced,bun,1,,
//   #IDTABLE,space,id,node
//   IDTABLE,ingredient,0,bun
//
// Conventions: `|` separates list items (a `,` would collide with the CSV
// itself), TRUE/FALSE for booleans, blank for absent.
//
// `csvToGraph` is TOTAL ON GARBAGE. An unknown kind, a short row, an
// unparseable number — each becomes a line in the import report, never a throw.
// A designer who hand-edits this file in a spreadsheet and gets one cell wrong
// must not lose the other four hundred rows.

import {
  EDGE_KIND_NAMES,
  VERTEX_KIND_NAMES,
  edgeFields,
  vertexFields,
} from "./nodeGraphSchema.ts";
import type {
  EdgeKindName,
  FieldDef,
  IdSpace,
  NodeGraphMap,
  VertexKindName,
} from "./nodeGraphTypes.ts";
import { ID_SPACES } from "./nodeIdTable.ts";

const LIST_SEP = "|";
/** Separates a slot-point record's name from its number: `cup-slot:1`. */
const PAIR_SEP = ":";
const ID_FIELDS = ["space", "id", "node"];
const MAP_FIELDS = [
  "id",
  "name",
  "gridWidth",
  "gridHeight",
  "dirtyStackHeight",
  "visibleRows",
  "customerAvatars",
];

// ---------- writing ----------

/**
 * `{name, slot}` records ride in one cell as `name:slot`, so the CSV stays one
 * row per edge or vertex — the shape the whole format rests on. Splitting slot
 * points across their own row type would make a hand-edited file far easier to
 * get half-right.
 */
function recordCell(value: Record<string, unknown>): string | null {
  if (typeof value.name === "string" && typeof value.slot === "number") {
    return `${value.name}${PAIR_SEP}${value.slot}`;
  }
  if (typeof value.ingredient === "string" && typeof value.slot === "number") {
    return `${value.ingredient}${PAIR_SEP}${value.slot}`;
  }
  return null;
}

function csvCell(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  const text = Array.isArray(value)
    ? value
        .map((v) => (v && typeof v === "object" ? (recordCell(v as Record<string, unknown>) ?? String(v)) : String(v)))
        .join(LIST_SEP)
    : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const csvRow = (cells: unknown[]): string => cells.map(csvCell).join(",");

export function graphToCsv(doc: NodeGraphMap): string {
  const lines: string[] = [];

  lines.push(csvRow(["#MAP", ...MAP_FIELDS]));
  lines.push(csvRow(["MAP", ...MAP_FIELDS.map((f) => (doc.map as unknown as Record<string, unknown>)[f])]));

  for (const kind of VERTEX_KIND_NAMES) {
    const rows = (doc.vertices[kind] ?? []) as unknown as Record<string, unknown>[];
    if (rows.length === 0) continue;
    const fields = vertexFields(kind).map((f) => f.name);
    lines.push(csvRow(["#VERTEX", kind, ...fields]));
    for (const row of rows) lines.push(csvRow(["VERTEX", kind, ...fields.map((f) => row[f])]));
  }

  for (const kind of EDGE_KIND_NAMES) {
    const rows = (doc.edges[kind] ?? []) as unknown as Record<string, unknown>[];
    if (rows.length === 0) continue;
    // from/to are structural and live on every edge kind; the schema's fields[]
    // covers only the kind-specific extras.
    const fields = ["from", "to", ...edgeFields(kind).map((f) => f.name)];
    lines.push(csvRow(["#EDGE", kind, ...fields]));
    for (const row of rows) lines.push(csvRow(["EDGE", kind, ...fields.map((f) => row[f])]));
  }

  // The `id` column is the row's INDEX, written out explicitly rather than left
  // implicit in row order: a spreadsheet does not guarantee row order, and here
  // the index IS the id, so losing it would silently repoint every level string.
  lines.push(csvRow(["#IDTABLE", ...ID_FIELDS]));
  for (const space of ID_SPACES) {
    (doc.idTable[space] ?? []).forEach((node, id) => {
      lines.push(csvRow(["IDTABLE", space, id, node]));
    });
  }

  return lines.join("\n");
}

// ---------- reading ----------

/** Splits one CSV line, honouring "" quoting. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      out.push(cell);
      cell = "";
    } else {
      cell += ch;
    }
  }
  out.push(cell);
  return out;
}

export interface CsvImportIssue {
  line: number;
  message: string;
}

export interface CsvImportResult {
  doc: NodeGraphMap;
  issues: CsvImportIssue[];
}

function coerce(field: FieldDef, raw: string): unknown {
  const text = raw.trim();
  if (text === "") return undefined;
  switch (field.type) {
    case "bool":
      return /^(true|1|yes)$/i.test(text);
    case "int":
    case "number": {
      const n = Number(text);
      return Number.isFinite(n) ? n : undefined;
    }
    case "ref[]":
    case "string[]":
    case "int[]": {
      const parts = text.split(LIST_SEP).filter((p) => p !== "");
      return field.type === "int[]" ? parts.map(Number).filter(Number.isFinite) : parts;
    }
    case "slotConfig[]":
    case "processInput[]": {
      const key = field.type === "slotConfig[]" ? "name" : "ingredient";
      // A missing number defaults to 1 lane / point 0 rather than dropping the
      // row: a half-typed cell should still produce a usable tool.
      const fallback = field.type === "slotConfig[]" ? 1 : 0;
      return text
        .split(LIST_SEP)
        .filter((p) => p.trim() !== "")
        .map((part) => {
          const at = part.lastIndexOf(PAIR_SEP);
          const label = (at === -1 ? part : part.slice(0, at)).trim();
          const n = at === -1 ? NaN : Number(part.slice(at + 1));
          return { [key]: label, slot: Number.isFinite(n) ? n : fallback };
        })
        .filter((row) => row[key] !== "");
    }
    default:
      return text;
  }
}

const emptyDoc = (): NodeGraphMap => ({
  schemaVersion: 1,
  map: { id: "", name: "", gridWidth: 0, gridHeight: 0, dirtyStackHeight: 1, visibleRows: 3 },
  idTable: { ingredient: [], composite: [], group: [], tool: [], dirty: [] },
  vertices: { ingredient: [], tool: [], group: [], composite: [], dirty: [] },
  edges: { process: [], preservation: [], base: [], topping: [], option: [], leavesDirty: [] },
});

export function csvToGraph(text: string): CsvImportResult {
  const doc = emptyDoc();
  const issues: CsvImportIssue[] = [];
  const lines = text.split(/\r?\n/);

  // Column headers currently in force, per section. A `#` row replaces the
  // header for its section; rows before any header are reported, not guessed.
  let mapHeader: string[] | null = null;
  const vertexHeader = new Map<string, string[]>();
  const edgeHeader = new Map<string, string[]>();
  let idHeader: string[] | null = null;

  lines.forEach((line, i) => {
    const lineNo = i + 1;
    if (line.trim() === "") return;
    const cells = splitCsvLine(line);
    const tag = cells[0].trim();

    if (tag === "#MAP") {
      mapHeader = cells.slice(1).map((c) => c.trim());
      return;
    }
    if (tag === "#VERTEX") {
      vertexHeader.set(cells[1]?.trim() ?? "", cells.slice(2).map((c) => c.trim()));
      return;
    }
    if (tag === "#EDGE") {
      edgeHeader.set(cells[1]?.trim() ?? "", cells.slice(2).map((c) => c.trim()));
      return;
    }
    if (tag === "#IDTABLE") {
      idHeader = cells.slice(1).map((c) => c.trim());
      return;
    }
    if (tag.startsWith("#")) return; // an unknown section header: skipped with its rows below

    if (tag === "MAP") {
      const header = mapHeader ?? MAP_FIELDS;
      const row = cells.slice(1);
      const map = doc.map as unknown as Record<string, unknown>;
      header.forEach((name, c) => {
        const raw = (row[c] ?? "").trim();
        if (raw === "") return;
        if (name === "customerAvatars") map[name] = raw.split(LIST_SEP).filter(Boolean);
        else map[name] = name === "id" || name === "name" ? raw : Number(raw);
      });
      return;
    }

    if (tag === "VERTEX") {
      const kind = cells[1]?.trim() as VertexKindName;
      if (!VERTEX_KIND_NAMES.includes(kind)) {
        issues.push({ line: lineNo, message: `Unknown vertex kind "${cells[1]}"` });
        return;
      }
      const header = vertexHeader.get(kind);
      if (!header) {
        issues.push({ line: lineNo, message: `VERTEX row for "${kind}" before any #VERTEX header` });
        return;
      }
      const fields = new Map(vertexFields(kind).map((f) => [f.name, f]));
      const row = cells.slice(2);
      const out: Record<string, unknown> = {};
      header.forEach((name, c) => {
        const field = fields.get(name);
        if (!field) return; // a column the current schema no longer has
        const value = coerce(field, row[c] ?? "");
        if (value !== undefined) out[name] = value;
      });
      if (typeof out.name !== "string" || out.name === "") {
        issues.push({ line: lineNo, message: `${kind} row has no name` });
        return;
      }
      (doc.vertices[kind] as unknown as Record<string, unknown>[]).push(out);
      return;
    }

    if (tag === "EDGE") {
      const kind = cells[1]?.trim() as EdgeKindName;
      if (!EDGE_KIND_NAMES.includes(kind)) {
        issues.push({ line: lineNo, message: `Unknown edge kind "${cells[1]}"` });
        return;
      }
      const header = edgeHeader.get(kind);
      if (!header) {
        issues.push({ line: lineNo, message: `EDGE row for "${kind}" before any #EDGE header` });
        return;
      }
      const fields = new Map(edgeFields(kind).map((f) => [f.name, f]));
      const row = cells.slice(2);
      const out: Record<string, unknown> = {};
      header.forEach((name, c) => {
        const raw = (row[c] ?? "").trim();
        if (name === "from" || name === "to") {
          if (raw !== "") out[name] = raw;
          return;
        }
        const field = fields.get(name);
        if (!field) return;
        const value = coerce(field, raw);
        if (value !== undefined) out[name] = value;
      });
      if (typeof out.from !== "string" || typeof out.to !== "string") {
        issues.push({ line: lineNo, message: `${kind} edge is missing from/to` });
        return;
      }
      // `inputs` is required on a process edge and the sim indexes it directly.
      if (kind === "process" && !Array.isArray(out.inputs)) out.inputs = [];
      if (kind === "process" && typeof out.amount !== "number") out.amount = 1;
      (doc.edges[kind] as unknown as Record<string, unknown>[]).push(out);
      return;
    }

    if (tag === "IDTABLE") {
      const header = idHeader ?? ID_FIELDS;
      const row = cells.slice(1);
      const get = (name: string) => (row[header.indexOf(name)] ?? "").trim();
      const space = get("space") as IdSpace;
      if (!ID_SPACES.includes(space)) {
        issues.push({ line: lineNo, message: `Unknown id space "${space}"` });
        return;
      }
      const id = Number(get("id"));
      if (!Number.isInteger(id) || id < 0) {
        issues.push({ line: lineNo, message: `Id "${get("id")}" is not a non-negative integer` });
        return;
      }
      const node = get("node");
      if (node === "") {
        issues.push({ line: lineNo, message: `Id ${id} in the ${space} space names nothing` });
        return;
      }
      // Index-addressed, so a row out of order in the file still lands in the
      // right slot. A gap left by a missing row is reported by validateIdTable
      // rather than silently closed, which would renumber everything after it.
      const rows = doc.idTable[space];
      while (rows.length <= id) rows.push("");
      rows[id] = node;
      return;
    }

    issues.push({ line: lineNo, message: `Unrecognised row type "${tag}"` });
  });

  return { doc, issues };
}

import { ID_SPACES } from "./nodeIdTable.ts";
import type { IdSpace, NodeGraphMap } from "./nodeGraphTypes.ts";

export const GRAPH_LOOKUP_TAB = "GraphLookupData";
export const GRAPH_LOOKUP_START_ROW = 4;
export const GRAPH_LOOKUP_COLUMNS = 6;
const GRAPH_LOOKUP_CATEGORY_ORDER: IdSpace[] = ["ingredient", "group", "composite", "tool", "dirty"];

export interface GraphLookupColumns {
  map: number;
  category: number;
  indexData: number;
  price: number;
  speedMul: number;
  maxStack: number;
}

export const GRAPH_LOOKUP_DEFAULT_COLUMNS: GraphLookupColumns = {
  map: 0,
  category: 1,
  indexData: 2,
  price: 3,
  speedMul: 4,
  maxStack: 5,
};

export interface GraphLookupMap {
  index: number;
  doc: NodeGraphMap;
}

export interface GraphLookupRow {
  map: number;
  category: IdSpace;
  indexData: number;
  price: string;
  speedMul: string;
  maxStack: string;
}

const isIdSpace = (value: string): value is IdSpace =>
  (ID_SPACES as readonly string[]).includes(value);

const cell = (row: readonly string[], index: number): string => String(row[index] ?? "").trim();

/** Parses rows beneath the sheet's three-row header. Invalid tuple rows are ignored. */
export function parseGraphLookupRows(
  values: readonly (readonly string[])[],
  startRow = GRAPH_LOOKUP_START_ROW,
  columns: GraphLookupColumns = GRAPH_LOOKUP_DEFAULT_COLUMNS,
): GraphLookupRow[] {
  const rows: GraphLookupRow[] = [];
  for (const raw of values.slice(startRow - 1)) {
    const map = Number(cell(raw, columns.map));
    const category = cell(raw, columns.category).toLowerCase();
    const indexData = Number(cell(raw, columns.indexData));
    if (!Number.isInteger(map) || map < 1 || !isIdSpace(category) || !Number.isInteger(indexData) || indexData < 0) continue;
    rows.push({
      map,
      category,
      indexData,
      price: cell(raw, columns.price),
      speedMul: cell(raw, columns.speedMul),
      maxStack: cell(raw, columns.maxStack),
    });
  }
  return rows;
}

/** Emits every positional id row, including categories whose value columns are intentionally blank. */
export function graphLookupRows(maps: readonly GraphLookupMap[]): string[][] {
  const rows: string[][] = [];
  for (const source of [...maps].sort((a, b) => a.index - b.index)) {
    for (const category of GRAPH_LOOKUP_CATEGORY_ORDER) {
      source.doc.idTable[category].forEach((name, indexData) => {
        const vertex = source.doc.vertices[category].find((candidate) => candidate.name === name) as Record<string, unknown> | undefined;
        rows.push([
          String(source.index),
          category,
          String(indexData),
          category === "ingredient" ? optionalNumber(vertex?.price) : "",
          category === "tool" ? optionalNumber(vertex?.speedMul) : "",
          category === "dirty" ? optionalNumber(vertex?.maxStack) : "",
        ]);
      });
    }
  }
  return rows;
}

function optionalNumber(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

export interface ApplyGraphLookupResult {
  matched: number;
  changed: number;
  invalid: number;
}

/** Applies matching [map, category, index] tuples to graph vertices in place. */
export function applyGraphLookupRows(maps: readonly GraphLookupMap[], rows: readonly GraphLookupRow[]): ApplyGraphLookupResult {
  const byMap = new Map(maps.map((source) => [source.index, source.doc]));
  let matched = 0;
  let changed = 0;
  let invalid = 0;

  for (const row of rows) {
    const doc = byMap.get(row.map);
    const name = doc?.idTable[row.category]?.[row.indexData];
    const vertex = name ? doc?.vertices[row.category].find((candidate) => candidate.name === name) as Record<string, unknown> | undefined : undefined;
    if (!vertex) continue;
    matched++;

    const value = row.category === "ingredient" ? row.price : row.category === "tool" ? row.speedMul : row.category === "dirty" ? row.maxStack : null;
    const property = row.category === "ingredient" ? "price" : row.category === "tool" ? "speedMul" : row.category === "dirty" ? "maxStack" : null;
    if (value === null || property === null) continue;

    if (value === "") {
      if (property in vertex) {
        delete vertex[property];
        changed++;
      }
      continue;
    }
    const parsed = Number(value);
    const valid = Number.isFinite(parsed) &&
      (property === "speedMul" ? parsed > 0 : Number.isInteger(parsed) && (property === "price" ? parsed >= 0 : parsed > 0));
    if (!valid) {
      invalid++;
      continue;
    }
    if (vertex[property] !== parsed) {
      vertex[property] = parsed;
      changed++;
    }
  }
  return { matched, changed, invalid };
}

// The named-customer catalog: one global roster shared across every map,
// replacing the old per-map `customerAvatars` random-pool list. A level's
// customer string can pin an arrival to a specific row via `customerIndex`
// (see core/nodeParser.ts); an unset index means "random", filtered to
// Type=Normal rows of the current map at render time (ui/customerAvatar.ts).
//
// Bundled from customers.csv, mirroring nodeProject.ts's bundled-plus-draft
// shape: a localStorage draft (whole-catalog Import/Export, not per-row
// undo/history — the catalog changes rarely and as a whole file) wins once
// present, otherwise the bundled CSV.

import bundledCsv from "./config/general/customers.csv?raw";
import { parseCsv } from "./csvColumns.ts";

export interface CustomerCatalogEntry {
  index: number;
  id: string;
  name: string;
  desc: string;
  type: string;
  baseMap: string;
  /** The graph system's own map index (1/2/3/...) for `baseMap` — authored directly in the sheet rather than inferred, since `baseMap` alone can't be trusted against every map registry's naming (e.g. the legacy registry's "donut" vs the graph's "coffee"). */
  mapIndex: number;
  fileId: string;
  icon: string;
}

// Column 9 (between FileID and Icon) is a blank spacer in the source Google
// Sheet export — no header text, never a value. Kept as a real column here
// (read AND written back) purely for column-position fidelity with that
// sheet, so re-exporting a CSV pulled from Sheets diffs clean against it.
const CATALOG_HEADER = ["Index", "Id", "Name", "Desc", "Type", "BaseMap", "MapIndex", "FileID", "", "Icon"];

/** Parses the Index/Id/Name/Desc/Type/BaseMap/MapIndex/FileID/(spacer)/Icon CSV shape, header row optional. */
export function parseCustomersCsv(text: string): CustomerCatalogEntry[] {
  const rows = parseCsv(text).filter((r) => r.some((cell) => cell.trim() !== ""));
  if (rows.length === 0) return [];
  const body = rows[0][0]?.trim().toLowerCase() === "index" ? rows.slice(1) : rows;
  return body.map((r) => {
    const [index, id, name, desc, type, baseMap, mapIndex, fileId, , icon] = r;
    return {
      index: Number(index) || 0,
      id: id ?? "",
      name: name ?? "",
      desc: desc ?? "",
      type: type ?? "",
      baseMap: baseMap ?? "",
      mapIndex: Number(mapIndex) || 0,
      fileId: fileId ?? "",
      icon: icon ?? "",
    };
  });
}

function csvEscape(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function serializeCustomersCsv(entries: CustomerCatalogEntry[]): string {
  const rows = entries.map((e) => [e.index, e.id, e.name, e.desc, e.type, e.baseMap, e.mapIndex, e.fileId, "", e.icon]);
  return [CATALOG_HEADER, ...rows].map((r) => r.map(csvEscape).join(",")).join("\r\n");
}

const CATALOG_DRAFT_KEY = "cookorder-customer-catalog";
/** 2 — added the `mapIndex` field; a v1 draft has none, so it's discarded rather than loaded with mapIndex 0 for every row. */
const CATALOG_DRAFT_VERSION = 2;

interface CatalogDraft {
  version: number;
  entries: CustomerCatalogEntry[];
}

function readDraft(): CustomerCatalogEntry[] | null {
  // Module scope, not a click handler: a non-browser environment (the test
  // runner's default "node" environment has no `localStorage` at all) must
  // fall back quietly, the same way it would if the browser's storage were
  // simply empty — this is not a malformed-draft error worth logging.
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(CATALOG_DRAFT_KEY);
    if (!raw) return null;
    const draft = JSON.parse(raw) as Partial<CatalogDraft>;
    if (draft.version === CATALOG_DRAFT_VERSION && Array.isArray(draft.entries)) return draft.entries;
  } catch (err) {
    console.warn("Customer catalog draft could not be parsed — using the bundled catalog", err);
  }
  return null;
}

function persistDraft(entries: CustomerCatalogEntry[]): void {
  try {
    localStorage.setItem(
      CATALOG_DRAFT_KEY,
      JSON.stringify({ version: CATALOG_DRAFT_VERSION, entries } satisfies CatalogDraft),
    );
  } catch (err) {
    console.warn("Could not persist the customer catalog draft", err);
  }
}

/** Ambient roster, set once at startup and whenever the designer imports a new file — read directly rather than threaded through every view, the same idiom as GLOBAL_DEFS. */
let catalog: CustomerCatalogEntry[] = readDraft() ?? parseCustomersCsv(bundledCsv);

export function getCustomerCatalog(): CustomerCatalogEntry[] {
  return catalog;
}

/** Replaces the whole roster (an Import) and persists it as the new draft. */
export function setCustomerCatalog(entries: CustomerCatalogEntry[]): void {
  catalog = entries;
  persistDraft(entries);
}

/** Discards the draft and reverts to the bundled catalog. */
export function resetCustomerCatalog(): CustomerCatalogEntry[] {
  localStorage.removeItem(CATALOG_DRAFT_KEY);
  catalog = parseCustomersCsv(bundledCsv);
  return catalog;
}

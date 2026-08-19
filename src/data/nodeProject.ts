// The node-graph system's working state: which graph document is open, the
// levels that speak its id space, and the localStorage draft that survives a
// reload.
//
// Deliberately separate from the legacy draft in main.ts, under its own key:
// the two systems have different schemas and different failure modes, and a
// designer must be able to hit "Reset draft" on one without destroying work in
// the other.
//
// Levels come from a COMMITTED dataset checked in beside the graph. Committing
// it rather than deriving it at startup is what makes the node system's data a
// real artefact: it can be diffed, reviewed and hand-edited, and it does not
// silently change when the graph does.
//
// It is also the ONLY source. The legacy migration that used to fill in for a
// graph without committed levels is gone with the `runtime*Id` bridge fields it
// depended on; a graph with no CSV opens with a single empty level, which is
// the honest state rather than a silently synthesised one.
//
// The map list is SCANNED from config/nodegraph/maps/ rather than hand-listed —
// see `NODE_DOCS`.

import type { LevelData } from "./mapLoader.ts";
import type { NodeGraphMap } from "./nodeGraphTypes.ts";
import { importLevelsCsv } from "./sheetSource.ts";

/**
 * Draft storage is PER MAP.
 *
 * One shared key would mean opening a second map silently overwrote the first
 * one's unsaved work — the failure is invisible until the designer switches
 * back and finds their edits gone. A key per map makes every map's draft
 * independent, and `NODE_ACTIVE_KEY` remembers only which one to reopen.
 */
export const NODE_DRAFT_KEY = "cookorder-node-draft";
export const NODE_ACTIVE_KEY = "cookorder-node-active";
/** Ids of maps the designer created here, as opposed to the bundled ones. */
export const NODE_CUSTOM_KEY = "cookorder-node-maps";
/**
 * Bump when the stored shape changes; a stale draft is discarded, never loaded
 * blindly.
 *
 * 3 — `idTable` became a positional list of plain names (`string[]` per space),
 *     replacing `{ id, node, retired? }[]`, and the hardcoded `tables` block was
 *     dropped in favour of the `pickupable`/`orderable` flags.
 */
export const NODE_DRAFT_VERSION = 3;

const draftKey = (docId: string): string => `${NODE_DRAFT_KEY}:${docId}`;

export interface NodeProjectState {
  /** Which map this state belongs to — the key its draft is stored under. */
  docId: string;
  doc: NodeGraphMap;
  levels: LevelData[];
  /** Human-readable provenance, shown in the header. */
  origin: string;
}

interface NodeDraft {
  version: number;
  docId: string;
  doc: NodeGraphMap;
  levels: LevelData[];
  origin: string;
}

/** One row of the map picker. */
export interface NodeMapEntry {
  id: string;
  name: string;
  /** Bundled maps ship with the tool; custom ones exist only in this browser. */
  bundled: boolean;
  hasDraft: boolean;
}

export interface NodeDoc {
  /** Draft-storage key and picker identity — the slugged map name. */
  id: string;
  /** What the picker shows: "Map 2 — Coffee". */
  name: string;
  /** Position in the map order, from the filename. */
  index: number;
  doc: NodeGraphMap;
  levelsCsv?: string;
}

/**
 * Files under config/nodegraph/maps/, read at build time by Vite.
 *
 * `eager` because the map list has to exist synchronously: `loadNodeProject()`
 * runs at module scope in main.ts, before any await point, and a promise-shaped
 * registry would mean the shell renders a picker with nothing in it.
 */
const GRAPH_FILES = import.meta.glob("./config/nodegraph/maps/*.json", {
  eager: true,
}) as Record<string, { default: unknown }>;

const LEVEL_FILES = import.meta.glob("./config/nodegraph/maps/*.csv", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

/**
 * `Graph-2-Coffee.json` -> `{ index: 2, name: "Coffee" }`.
 *
 * Anything that does not match — no index, a non-numeric one, a different
 * prefix, a stray file — returns null and is skipped. The convention is the
 * whole contract here: with the list scanned rather than declared, a filename
 * typo is the only way a map can go missing, so it must be cheap to spot and
 * must never take the app down with it.
 */
export function parseMapFileName(
  path: string,
  prefix: "Graph" | "LevelData",
): { index: number; name: string } | null {
  const file = path.slice(path.lastIndexOf("/") + 1);
  const match = new RegExp(`^${prefix}-(\\d+)-(.+)\\.(json|csv)$`, "i").exec(file);
  if (!match) return null;
  const index = Number(match[1]);
  const name = match[2].trim();
  if (!Number.isInteger(index) || !name) return null;
  return { index, name };
}

/** The picker's identity for a map name: lowercase, punctuation collapsed to `-`. */
const slug = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "map";

/**
 * Every graph the tool ships with, discovered by scanning the maps folder.
 *
 * Level data is joined by INDEX, not by name, so `LevelData-1-Burger.csv`
 * follows `Graph-1-Burger.json` even if one of them is renamed — the index is
 * the identity, the name is a label.
 */
export const NODE_DOCS: NodeDoc[] = (() => {
  const levelsByIndex = new Map<number, string>();
  for (const [path, csv] of Object.entries(LEVEL_FILES)) {
    const parsed = parseMapFileName(path, "LevelData");
    if (!parsed) {
      console.warn(`Skipping ${path}: expected LevelData-{index}-{name}.csv`);
      continue;
    }
    levelsByIndex.set(parsed.index, csv);
  }

  const docs: NodeDoc[] = [];
  for (const [path, mod] of Object.entries(GRAPH_FILES)) {
    const parsed = parseMapFileName(path, "Graph");
    if (!parsed) {
      console.warn(`Skipping ${path}: expected Graph-{index}-{name}.json`);
      continue;
    }
    const doc = mod.default as NodeGraphMap | undefined;
    if (!doc?.vertices) {
      console.warn(`Skipping ${path}: not a graph document`);
      continue;
    }
    docs.push({
      id: slug(parsed.name),
      name: `Map ${parsed.index} — ${parsed.name}`,
      index: parsed.index,
      doc,
      levelsCsv: levelsByIndex.get(parsed.index),
    });
  }

  // Two graphs claiming one index would otherwise make "which map is 2?"
  // depend on filesystem order. Keep the first and say so.
  const seen = new Set<number>();
  return docs
    .sort((a, b) => a.index - b.index || a.name.localeCompare(b.name))
    .filter((d) => {
      if (seen.has(d.index)) {
        console.warn(`Skipping duplicate map index ${d.index}: ${d.name}`);
        return false;
      }
      seen.add(d.index);
      return true;
    });
})();

/**
 * A fresh project: the bundled graph plus its committed levels, or — if a graph
 * ships without them, or the committed file cannot be read — one empty level.
 */
export function freshNodeProject(docId = defaultNodeMapId()): NodeProjectState {
  const bundled = NODE_DOCS.find((d) => d.id === docId);
  if (!bundled) {
    // A custom map with no draft — it exists only as whatever the designer
    // saved, so an empty graph under its own id is the honest starting point.
    return { docId, ...blankNodeProject(docId, docId) };
  }
  const doc = structuredClone(bundled.doc);

  if (bundled.levelsCsv) {
    try {
      const levels = importLevelsCsv(bundled.levelsCsv);
      if (levels.length > 0) {
        return { docId, doc, levels, origin: `${bundled.name} · committed level dataset` };
      }
    } catch (err) {
      console.warn("Committed node levels could not be read — falling back to a live migration", err);
    }
  }

  // No committed levels for this graph yet — it used to fall back to migrating
  // the legacy snapshot, but that path needed `runtimeRawId`/`runtimeCookedId`
  // on every ingredient and those bridge fields are gone. The committed CSV is
  // now the only source, so this graph gets one empty level to design into.
  return { docId, doc, levels: [blankLevel(doc)], origin: `${bundled.name} · no committed levels` };
}

/**
 * An empty but VALID graph document.
 *
 * Empty rather than a copy of an existing map: a new map that starts as a
 * duplicate of burger looks finished and invites editing-by-deletion, which is
 * how a designer ends up with a half-erased burger wearing a new name. The five
 * id spaces are present and empty so the id table has somewhere to mint into
 * from the first node created.
 */
export function blankNodeGraph(id: string, name: string): NodeGraphMap {
  return {
    schemaVersion: 1,
    map: {
      id,
      name,
      gridWidth: 4,
      gridHeight: 4,
      dirtyStackHeight: 3,
      visibleRows: 3,
    },
    idTable: { ingredient: [], composite: [], group: [], tool: [], dirty: [] },
    vertices: { ingredient: [], tool: [], group: [], composite: [], dirty: [] },
    edges: { process: [], base: [], topping: [], option: [], leavesDirty: [] },
    layout: {},
    notes: [],
  };
}

/**
 * A valid, empty level sized to the graph's grid.
 *
 * Every view assumes a project HAS a level — `NodeDesignView` does
 * `levels.find(...) ?? levels[0]` and reads fields off the result, which is
 * `undefined` for an empty list, and Play builds a simulation from it. A map
 * with no levels therefore broke the moment it was opened. One empty level is
 * the honest floor: there is nothing to design against with zero.
 */
export function blankLevel(doc: NodeGraphMap, id = 1): LevelData {
  const cells = Math.max(1, (doc.map.gridWidth ?? 4) * (doc.map.gridHeight ?? 4));
  return {
    id,
    name: `Level ${id}`,
    weather: "Normal",
    levelTag: "Normal",
    featureUnlock: "",
    serveableSlots: 2,
    shuffleDistance: 0,
    // Three explicit empty lanes. `%%` is canonical and round-trips as
    // `[[], [], []]`, so a new level opens with the requested queue count
    // without inventing ingredient ids that may not exist in this graph.
    queueString: "%%",
    // One empty cell per grid position, so the grid editor renders the real
    // shape rather than a zero-width board the designer cannot click into.
    gridString: new Array(cells).fill("").join(","),
    customerString: "",
  };
}

/** Levels as given, or a single empty one — never an empty list. See `blankLevel`. */
function withAtLeastOneLevel(doc: NodeGraphMap, levels: LevelData[]): LevelData[] {
  return levels.length > 0 ? levels : [blankLevel(doc)];
}

function blankNodeProject(id: string, name: string): Omit<NodeProjectState, "docId"> {
  const doc = blankNodeGraph(id, name);
  return { doc, levels: [blankLevel(doc)], origin: `${name} · new map` };
}

/** Ids of maps created in this browser. Bundled maps are not listed here. */
function customIds(): string[] {
  try {
    const raw = localStorage.getItem(NODE_CUSTOM_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** Every map the picker offers: the bundled ones first, then anything created here. */
export function listNodeMaps(): NodeMapEntry[] {
  const has = (id: string) => localStorage.getItem(draftKey(id)) !== null;
  const entries: NodeMapEntry[] = NODE_DOCS.map((d) => ({
    id: d.id,
    name: d.name,
    bundled: true,
    hasDraft: has(d.id),
  }));
  for (const id of customIds()) {
    if (entries.some((e) => e.id === id)) continue;
    entries.push({ id, name: nameOfStoredMap(id) ?? id, bundled: false, hasDraft: has(id) });
  }
  return entries;
}

/** The display name a stored draft carries, so the picker shows renames. */
function nameOfStoredMap(id: string): string | null {
  try {
    const raw = localStorage.getItem(draftKey(id));
    if (!raw) return null;
    return (JSON.parse(raw) as Partial<NodeDraft>).doc?.map?.name ?? null;
  } catch {
    return null;
  }
}

/**
 * The map to open when nothing else says otherwise: the lowest-indexed bundled
 * graph.
 *
 * Falls back to a literal id when the scan found nothing at all — an empty or
 * misnamed maps folder is a data problem, and it should surface as one empty
 * map the designer can look at, not as a crash at module scope that blanks the
 * whole page before any error panel can render.
 */
export function defaultNodeMapId(): string {
  return NODE_DOCS[0]?.id ?? "map";
}

export function activeNodeMapId(): string {
  const stored = localStorage.getItem(NODE_ACTIVE_KEY);
  if (stored && listNodeMaps().some((m) => m.id === stored)) return stored;
  return defaultNodeMapId();
}

/**
 * Whether a stored document actually has the shape this build reads.
 *
 * The version stamp alone is not enough, because it only works if every shape
 * change remembers to bump it — and one did not: `idTable` went from
 * `{ id, node }[]` to a positional `string[]`, while the old guard asked only
 * that `doc.idTable` be truthy. An array of objects is truthy, so stale drafts
 * sailed through and blew up at first use, taking the whole page with them.
 *
 * So this checks the shape itself. It is deliberately structural and shallow —
 * enough that a reader can trust `idTable[space][i]` is a name and that the
 * vertex/edge buckets exist, not a full validation (that is
 * `validateNodeGraph`'s job, and it needs a well-formed document to run).
 */
function isCurrentShape(doc: NodeGraphMap | undefined): doc is NodeGraphMap {
  if (!doc || typeof doc !== "object" || !doc.map || !doc.vertices || !doc.edges) return false;
  const table = doc.idTable as Record<string, unknown> | undefined;
  if (!table || typeof table !== "object") return false;
  for (const space of ["ingredient", "composite", "group", "tool", "dirty"] as const) {
    const rows = table[space];
    // Absent is fatal (a reader would index into undefined); every present row
    // must be a plain name, which is exactly what the old wrapper objects fail.
    if (!Array.isArray(rows) || rows.some((row) => typeof row !== "string")) return false;
  }
  for (const bucket of ["ingredient", "tool", "group", "composite", "dirty"] as const) {
    if (!Array.isArray(doc.vertices[bucket])) return false;
  }
  for (const bucket of ["process", "base", "topping", "option", "leavesDirty"] as const) {
    if (!Array.isArray(doc.edges[bucket])) return false;
  }
  return true;
}

export function loadNodeProject(docId = activeNodeMapId()): NodeProjectState {
  try {
    const raw = localStorage.getItem(draftKey(docId));
    if (raw) {
      const draft = JSON.parse(raw) as Partial<NodeDraft>;
      // A brand-new map legitimately has no levels yet, so level count is not
      // part of the shape check — only that the graph itself is well-formed.
      if (draft.version === NODE_DRAFT_VERSION && isCurrentShape(draft.doc)) {
        return {
          docId,
          doc: draft.doc,
          // A draft saved before this guarantee existed can legitimately carry
          // an empty list, so the floor is applied on the way out too.
          levels: withAtLeastOneLevel(draft.doc, Array.isArray(draft.levels) ? draft.levels : []),
          origin: draft.origin ?? "local node draft",
        };
      }
      // A draft that fails the shape check is dropped rather than migrated:
      // unlike the legacy map, there is no "keep the levels, refresh the
      // definitions" split that is safe here — the levels are written in ids
      // the stored graph defines, so half a draft is worse than none.
      //
      // And it is deleted, not merely ignored. An unreadable draft left in
      // place is not recoverable work — no build reads it — but it does keep
      // `listNodeMaps()` reporting `hasDraft: true`, so the picker advertises
      // saved work that silently resolves to the bundled graph every time.
      console.info("Node draft did not match the current shape — discarded, starting from the bundled graph");
      localStorage.removeItem(draftKey(docId));
    }
  } catch (err) {
    console.warn("Node draft could not be parsed — discarded, starting from the bundled graph", err);
    try {
      localStorage.removeItem(draftKey(docId));
    } catch {
      // Storage is unavailable entirely; the fallback below still works.
    }
  }
  const fresh = freshNodeProject(docId);
  return { docId, doc: fresh.doc, levels: fresh.levels, origin: fresh.origin };
}

export function saveNodeProject(state: NodeProjectState): void {
  try {
    localStorage.setItem(
      draftKey(state.docId),
      JSON.stringify({ version: NODE_DRAFT_VERSION, ...state } satisfies NodeDraft),
    );
    localStorage.setItem(NODE_ACTIVE_KEY, state.docId);
  } catch (err) {
    console.warn("Could not persist the node draft", err);
  }
}

/**
 * Register and persist a new map, returning its opened state.
 *
 * It is saved immediately rather than on first edit: a map that exists only in
 * memory would vanish on reload, and the picker would have listed something
 * that is no longer there.
 */
export function createNodeMap(name: string): NodeProjectState {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "map";
  const taken = new Set(listNodeMaps().map((m) => m.id));
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;

  const state: NodeProjectState = { docId: id, ...blankNodeProject(id, name.trim() || id) };
  try {
    localStorage.setItem(NODE_CUSTOM_KEY, JSON.stringify([...customIds(), id]));
  } catch (err) {
    console.warn("Could not register the new map", err);
  }
  saveNodeProject(state);
  return state;
}

/**
 * Drop a map's draft. A BUNDLED map falls back to what ships with the tool; a
 * custom one has no fallback, so it is removed from the registry entirely.
 */
export function clearNodeDraft(docId = activeNodeMapId()): void {
  localStorage.removeItem(draftKey(docId));
  if (NODE_DOCS.some((d) => d.id === docId)) return;
  try {
    localStorage.setItem(NODE_CUSTOM_KEY, JSON.stringify(customIds().filter((id) => id !== docId)));
  } catch (err) {
    console.warn("Could not deregister the map", err);
  }
  if (localStorage.getItem(NODE_ACTIVE_KEY) === docId) localStorage.removeItem(NODE_ACTIVE_KEY);
}

/**
 * Drop EVERY node draft — all maps, the active-map pointer and the custom-map
 * registry — leaving only what ships with the tool.
 *
 * This is the recovery path, not a per-map action. `clearNodeDraft` can only
 * clear the map it is told about, and the map it defaults to is read from
 * `NODE_ACTIVE_KEY` — which is useless precisely when it matters most, because
 * a draft whose shape this build cannot read is also a draft that may have
 * broken the page before anything could offer a picker to choose from. Scanning
 * the key prefix means a draft is reachable even when its map is not.
 */
export function clearAllNodeDrafts(): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      // Collect first, remove after: removing during the scan reindexes the
      // store underneath it and skips the key that shifts into the free slot.
      if (key && key.startsWith(`${NODE_DRAFT_KEY}:`)) doomed.push(key);
    }
    for (const key of doomed) localStorage.removeItem(key);
    localStorage.removeItem(NODE_ACTIVE_KEY);
    localStorage.removeItem(NODE_CUSTOM_KEY);
  } catch (err) {
    console.warn("Could not clear the node drafts", err);
  }
}

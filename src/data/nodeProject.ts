// The node-graph system's working state: which graph document is open, the
// levels that speak its id space, and the localStorage draft that survives a
// reload.
//
// Deliberately separate from the legacy draft in main.ts, under its own key:
// the two systems have different schemas and different failure modes, and a
// designer must be able to hit "Reset draft" on one without destroying work in
// the other.
//
// Levels come from a COMMITTED dataset — config/nodegraph/levels/*.csv, checked
// in beside the graph. Committing it rather than deriving it at startup is what
// makes the node system's data a real artefact: it can be diffed, reviewed and
// hand-edited, and it does not silently change when the graph does.
//
// It is also now the ONLY source. The legacy migration that used to fill in for
// a graph without committed levels is gone with the `runtime*Id` bridge fields
// it depended on; a graph with no CSV opens with no levels, which is the honest
// state rather than a silently synthesised one.

import burgerJson from "./config/nodegraph/burger.json";
import burgerLevelsCsv from "./config/nodegraph/levels/burger-levels.csv?raw";
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
/** Bump when the stored shape changes; a stale draft is discarded, never loaded blindly. */
export const NODE_DRAFT_VERSION = 2;

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

/** Every graph document the tool ships with. One today; the registry is the extension point. */
export const NODE_DOCS: { id: string; name: string; doc: NodeGraphMap; levelsCsv?: string }[] = [
  {
    id: "burger",
    name: "Map 1 — Burger",
    doc: burgerJson as unknown as NodeGraphMap,
    levelsCsv: burgerLevelsCsv,
  },
];

/**
 * A fresh project: the bundled graph plus its committed levels, or — if a graph
 * ships without them, or the committed file cannot be read — a live migration
 * of the legacy snapshot.
 */
export function freshNodeProject(docId = NODE_DOCS[0].id): NodeProjectState {
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

  // No committed levels for this graph yet. An empty level list is the honest
  // state — it used to fall back to migrating the legacy snapshot, but that
  // path needed `runtimeRawId`/`runtimeCookedId` on every ingredient, and those
  // legacy bridge fields are gone. The committed CSV is now the only source.
  return { docId, doc, levels: [], origin: `${bundled.name} · no committed levels` };
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

function blankNodeProject(id: string, name: string): Omit<NodeProjectState, "docId"> {
  return { doc: blankNodeGraph(id, name), levels: [], origin: `${name} · new map` };
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

export function activeNodeMapId(): string {
  const stored = localStorage.getItem(NODE_ACTIVE_KEY);
  if (stored && listNodeMaps().some((m) => m.id === stored)) return stored;
  return NODE_DOCS[0].id;
}

export function loadNodeProject(docId = activeNodeMapId()): NodeProjectState {
  try {
    const raw = localStorage.getItem(draftKey(docId));
    if (raw) {
      const draft = JSON.parse(raw) as Partial<NodeDraft>;
      // A brand-new map legitimately has no levels yet, so level count is not
      // part of the shape check — only that the graph itself is well-formed.
      if (draft.version === NODE_DRAFT_VERSION && draft.doc?.vertices && draft.doc.idTable) {
        return {
          docId,
          doc: draft.doc,
          levels: Array.isArray(draft.levels) ? draft.levels : [],
          origin: draft.origin ?? "local node draft",
        };
      }
      // A draft that fails the shape check is dropped rather than migrated:
      // unlike the legacy map, there is no "keep the levels, refresh the
      // definitions" split that is safe here — the levels are written in ids
      // the stored graph defines, so half a draft is worse than none.
      console.info("Node draft did not match the current shape — starting from the bundled graph");
    }
  } catch (err) {
    console.warn("Node draft could not be parsed — starting from the bundled graph", err);
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

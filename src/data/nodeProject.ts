// The node-graph system's working state: which graph document is open, the
// levels that speak its id space, and the localStorage draft that survives a
// reload.
//
// Deliberately separate from the legacy draft in main.ts, under its own key:
// the two systems have different schemas and different failure modes, and a
// designer must be able to hit "Reset draft" on one without destroying work in
// the other.
//
// Levels come from a COMMITTED dataset — config/nodegraph/levels/*.csv, written
// by the Map Process tab's migration panel and checked in. Committing it rather
// than migrating at every startup is what makes the node system's data a real
// artefact: it can be diffed, reviewed and hand-edited, and it does not silently
// change when the graph does.
//
// Migration remains the fallback, so a graph with no committed levels yet still
// opens carrying every authored level rather than an empty map.

import burgerJson from "./config/nodegraph/burger.json";
import burgerLevelsCsv from "./config/nodegraph/levels/burger-levels.csv?raw";
import { MAP1_DATA } from "./configLoader.ts";
import type { LevelData } from "./mapLoader.ts";
import { migrateMap } from "./nodeGraphMigrate.ts";
import type { MigrationReport } from "./nodeGraphMigrate.ts";
import type { NodeGraphMap } from "./nodeGraphTypes.ts";
import { importLevelsCsv } from "./sheetSource.ts";

export const NODE_DRAFT_KEY = "cookorder-node-draft";
/** Bump when the stored shape changes; a stale draft is discarded, never loaded blindly. */
export const NODE_DRAFT_VERSION = 1;

export interface NodeProjectState {
  doc: NodeGraphMap;
  levels: LevelData[];
  /** Human-readable provenance, shown in the header. */
  origin: string;
}

interface NodeDraft {
  version: number;
  doc: NodeGraphMap;
  levels: LevelData[];
  origin: string;
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
export function freshNodeProject(docId = NODE_DOCS[0].id): NodeProjectState & { report?: MigrationReport } {
  const entry = NODE_DOCS.find((d) => d.id === docId) ?? NODE_DOCS[0];
  const doc = structuredClone(entry.doc);

  if (entry.levelsCsv) {
    try {
      const levels = importLevelsCsv(entry.levelsCsv);
      if (levels.length > 0) {
        return { doc, levels, origin: `${entry.name} · committed level dataset` };
      }
    } catch (err) {
      console.warn("Committed node levels could not be read — falling back to a live migration", err);
    }
  }

  const { levels, report } = migrateMap(MAP1_DATA, doc);
  return { doc, levels, origin: `${entry.name} · migrated from the legacy snapshot`, report };
}

export function loadNodeProject(): NodeProjectState {
  try {
    const raw = localStorage.getItem(NODE_DRAFT_KEY);
    if (raw) {
      const draft = JSON.parse(raw) as Partial<NodeDraft>;
      if (
        draft.version === NODE_DRAFT_VERSION &&
        draft.doc?.vertices &&
        draft.doc.idTable &&
        Array.isArray(draft.levels) &&
        draft.levels.length > 0
      ) {
        return { doc: draft.doc, levels: draft.levels, origin: draft.origin ?? "local node draft" };
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
  const fresh = freshNodeProject();
  return { doc: fresh.doc, levels: fresh.levels, origin: fresh.origin };
}

export function saveNodeProject(state: NodeProjectState): void {
  try {
    localStorage.setItem(
      NODE_DRAFT_KEY,
      JSON.stringify({ version: NODE_DRAFT_VERSION, ...state } satisfies NodeDraft),
    );
  } catch (err) {
    console.warn("Could not persist the node draft", err);
  }
}

export function clearNodeDraft(): void {
  localStorage.removeItem(NODE_DRAFT_KEY);
}

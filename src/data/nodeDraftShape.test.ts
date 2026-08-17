// The draft a previous build wrote must never reach code that cannot read it.
//
// This is a regression test for a real page-breaking bug: `idTable` changed
// from `{ id, node }[]` to a positional `string[]`, but the load guard only
// asked whether `doc.idTable` was truthy. An array of the OLD row objects is
// truthy, so a stale draft passed the check, loaded, and threw on first use —
// taking the whole page down with it, on every reload, until localStorage was
// cleared by hand.
//
// Two independent defences are pinned here, because either alone is brittle:
// the version stamp (which that change forgot to bump) and a structural check
// of the stored shape (which catches the next change that forgets too).

import { beforeEach, describe, expect, it } from "vitest";
import burgerJson from "./config/nodegraph/maps/Graph-1-Burger.json";
import {
  clearAllNodeDrafts,
  loadNodeProject,
  NODE_ACTIVE_KEY,
  NODE_CUSTOM_KEY,
  NODE_DRAFT_KEY,
  NODE_DRAFT_VERSION,
  saveNodeProject,
} from "./nodeProject.ts";
import type { NodeGraphMap } from "./nodeGraphTypes.ts";

/** A minimal in-memory localStorage — vitest runs without jsdom. */
class MemoryStorage {
  private data = new Map<string, string>();
  get length(): number {
    return this.data.size;
  }
  key(i: number): string | null {
    return [...this.data.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.data.set(k, v);
  }
  removeItem(k: string): void {
    this.data.delete(k);
  }
  clear(): void {
    this.data.clear();
  }
}

const store = new MemoryStorage();
globalThis.localStorage = store as unknown as Storage;

const draftKey = (id: string) => `${NODE_DRAFT_KEY}:${id}`;

/** Exactly what the pre-migration build persisted: version 2, wrapper-object rows. */
function staleDraft(): string {
  return JSON.stringify({
    version: 2,
    docId: "burger",
    origin: "local node draft",
    levels: [],
    doc: {
      ...structuredClone(burgerJson),
      idTable: {
        ingredient: [{ id: 0, node: "bun" }, { id: 1, node: "patty" }],
        composite: [{ id: 0, node: "burger" }],
        group: [{ id: 0, node: "burger-toppings" }],
        tool: [{ id: 0, node: "griddle" }],
        dirty: [{ id: 40, node: null, retired: "old-plate" }],
      },
    },
  });
}

beforeEach(() => store.clear());

/** Every row of every space is a plain name — the shape this build reads. */
const isPositional = (doc: NodeGraphMap): boolean =>
  Object.values(doc.idTable).every((rows) => rows.every((row) => typeof row === "string"));

describe("a draft from an older build is discarded, not loaded", () => {
  it("drops the wrapper-object idTable that used to crash the page", () => {
    store.setItem(draftKey("burger"), staleDraft());
    const loaded = loadNodeProject("burger");

    expect(isPositional(loaded.doc)).toBe(true);
    // Fell back to the bundled graph, not the two-row stub the draft carried.
    expect(loaded.doc.idTable.ingredient).toEqual(burgerJson.idTable.ingredient);
    expect(loaded.origin).not.toBe("local node draft");
  });

  it("drops it even when stamped with the CURRENT version", () => {
    // The structural half, checked on its own: this is the case a future shape
    // change that forgets to bump the version would produce, and the reason the
    // guard cannot rest on the stamp alone.
    const forged = { ...JSON.parse(staleDraft()), version: NODE_DRAFT_VERSION };
    store.setItem(draftKey("burger"), JSON.stringify(forged));

    expect(isPositional(loadNodeProject("burger").doc)).toBe(true);
  });

  it("still loads a well-formed current draft", () => {
    // The guard has to reject stale data without rejecting good data — a check
    // that dropped everything would also "fix" the crash, silently discarding
    // the designer's work on every reload.
    const doc = structuredClone(burgerJson) as unknown as NodeGraphMap;
    doc.map.name = "Edited by hand";
    saveNodeProject({ docId: "burger", doc, levels: [], origin: "local node draft" });

    const loaded = loadNodeProject("burger");
    expect(loaded.doc.map.name).toBe("Edited by hand");
    expect(loaded.origin).toBe("local node draft");
  });

  it("deletes the rejected draft rather than leaving it to lie about itself", () => {
    // No build can read it, so it is not recoverable work — but left in place
    // it keeps `listNodeMaps()` reporting hasDraft: true for a map whose draft
    // silently resolves to the bundled graph on every single load.
    store.setItem(draftKey("burger"), staleDraft());
    loadNodeProject("burger");
    expect(store.getItem(draftKey("burger"))).toBeNull();
  });

  it("survives a draft that is not even JSON", () => {
    store.setItem(draftKey("burger"), "{not json");
    expect(() => loadNodeProject("burger")).not.toThrow();
    expect(isPositional(loadNodeProject("burger").doc)).toBe(true);
  });
});

describe("clearing drafts reaches every map, not just the open one", () => {
  it("removes closed maps' drafts, the active pointer and the custom registry", () => {
    // The bug this covers: a stale draft under a CLOSED map survived the reset
    // and broke the next load. `clearNodeDraft` could not reach it — the map it
    // defaults to comes from NODE_ACTIVE_KEY, which names a different one.
    store.setItem(draftKey("burger"), staleDraft());
    store.setItem(draftKey("donut"), staleDraft());
    store.setItem(NODE_ACTIVE_KEY, "burger");
    store.setItem(NODE_CUSTOM_KEY, JSON.stringify(["donut"]));

    clearAllNodeDrafts();

    expect(store.getItem(draftKey("burger"))).toBeNull();
    expect(store.getItem(draftKey("donut"))).toBeNull();
    expect(store.getItem(NODE_ACTIVE_KEY)).toBeNull();
    expect(store.getItem(NODE_CUSTOM_KEY)).toBeNull();
  });

  it("leaves the legacy draft alone", () => {
    // The two systems have independent drafts by design; the node reset button
    // must not destroy legacy work as collateral.
    store.setItem("cookorder-draft-map", "legacy state");
    store.setItem(draftKey("burger"), staleDraft());

    clearAllNodeDrafts();

    expect(store.getItem("cookorder-draft-map")).toBe("legacy state");
  });
});

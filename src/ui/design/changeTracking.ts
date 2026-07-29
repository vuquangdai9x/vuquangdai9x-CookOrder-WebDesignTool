// Per-element change indicators for the Design sections: a dashed border on
// each cell/tile/lane/card showing how it differs from the last-saved state —
// green = added, yellow = modified, red = something inside it was removed.
//
// There's no natural stable id for a queue item or a customer (they're plain
// value objects), and elements get reordered by drag-and-drop, added, and
// removed independently of each other. To tell "this is the same thing, just
// edited" from "this is unrelated content" across a reorder, each item gets a
// `_cid` tag the moment it's created; it rides along through structuredClone
// (used everywhere drafts/history snapshots are copied) but is never read by
// the parser/serializer, so it never leaks into the saved string format.

export type ChangeStatus = "added" | "modified" | "removed-inside";

interface Tagged {
  _cid?: string;
}

let counter = 0;

/** Tags a freshly-created item with a new identity. Call this at every creation site. */
export function tagNew<T extends object>(obj: T): T {
  (obj as T & Tagged)._cid = `c${++counter}`;
  return obj;
}

/** Tags every item in an array that doesn't already have an identity (e.g. on initial parse). */
export function tagAllNew<T extends object>(items: T[]): T[] {
  for (const item of items) if (!cidOf(item)) tagNew(item);
  return items;
}

export function cidOf(obj: unknown): string | undefined {
  return (obj as Tagged | null | undefined)?._cid;
}

/** CSS class to apply for a status, or "" for unchanged — dashed border, color-coded. */
export function changeClass(status: ChangeStatus | null | undefined): string {
  return status ? `changed-${status}` : "";
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Status for a leaf item matched by `_cid` against a saved list (searched
 * across all of `savedGroups`, so moving between lanes/dishes isn't "added").
 * `same` compares the fields that count as a real edit (ignoring `_cid` itself).
 */
export function leafStatus<T>(
  item: T,
  savedGroups: T[][],
  same: (a: T, b: T) => boolean,
): ChangeStatus | null {
  const cid = cidOf(item);
  for (const group of savedGroups) {
    const saved = group.find((s) => cidOf(s) === cid);
    if (saved) return same(saved, item) ? null : "modified";
  }
  return "added";
}

/**
 * Status for a container matched by `_cid` (a lane, a customer card): "added"
 * if it's new; otherwise "removed-inside" if any child it had at save time is
 * no longer among its current children, else "modified" if `same` says its
 * own fields changed, else unchanged.
 */
export function containerStatus<T, C>(
  container: T,
  children: C[],
  savedContainers: T[],
  childrenOf: (c: T) => C[],
  childCid: (c: C) => string | undefined,
  same: (a: T, b: T) => boolean,
): ChangeStatus | null {
  const cid = cidOf(container);
  const saved = savedContainers.find((s) => cidOf(s) === cid);
  if (!saved) return "added";

  const currentCids = new Set(children.map(childCid));
  const lostAChild = childrenOf(saved).some((c) => !currentCids.has(childCid(c)));
  if (lostAChild) return "removed-inside";

  return same(saved, container) ? null : "modified";
}

export const queueItemSignature = (a: unknown, b: unknown) => sameValue(a, b);

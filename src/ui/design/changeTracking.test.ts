import { describe, expect, it } from "vitest";
import {
  cidOf,
  containerStatus,
  leafStatus,
  tagAllNew,
  tagNew,
} from "./changeTracking.ts";

interface Item {
  id: number;
  effects: number[];
}

const sameItem = (a: Item, b: Item) => a.id === b.id && JSON.stringify(a.effects) === JSON.stringify(b.effects);

describe("tagging", () => {
  it("assigns a unique cid that survives structuredClone", () => {
    const item = tagNew<Item>({ id: 1, effects: [] });
    const clone = structuredClone(item);
    expect(cidOf(clone)).toBe(cidOf(item));
  });

  it("only tags items missing a cid", () => {
    const items = [tagNew<Item>({ id: 1, effects: [] }), { id: 2, effects: [] }];
    const originalCid = cidOf(items[0]);
    tagAllNew(items);
    expect(cidOf(items[0])).toBe(originalCid); // untouched
    expect(cidOf(items[1])).toBeDefined(); // freshly assigned
  });
});

describe("leafStatus", () => {
  it("is null for an item unchanged since the saved snapshot", () => {
    const saved = tagAllNew<Item>([{ id: 1, effects: [] }]);
    const draft = structuredClone(saved);
    expect(leafStatus(draft[0], [saved], sameItem)).toBeNull();
  });

  it("is 'added' for a newly created item with no match in the saved lists", () => {
    const saved = tagAllNew<Item>([{ id: 1, effects: [] }]);
    const created = tagNew<Item>({ id: 2, effects: [] });
    expect(leafStatus(created, [saved], sameItem)).toBe("added");
  });

  it("is 'modified' when the same identity now has different content", () => {
    const saved = tagAllNew<Item>([{ id: 1, effects: [] }]);
    const draft = structuredClone(saved);
    draft[0].effects = [4, 5];
    expect(leafStatus(draft[0], [saved], sameItem)).toBe("modified");
  });

  it("is not 'added' when the item moved to a different group (e.g. another lane)", () => {
    const lane1 = tagAllNew([{ id: 1, effects: [] }]);
    const lane2: Item[] = [];
    const moved = lane1[0];
    // Search across both saved groups, as queueSection does across all lanes.
    expect(leafStatus(moved, [lane1, lane2], sameItem)).toBeNull();
  });
});

describe("containerStatus", () => {
  const childCid = (c: Item) => cidOf(c);
  const sameContainer = (a: { scalar: number }, b: { scalar: number }) => a.scalar === b.scalar;

  it("is 'added' for a brand new container", () => {
    const container = tagNew({ scalar: 0 });
    expect(containerStatus(container, [], [], () => [], childCid, sameContainer)).toBe("added");
  });

  it("is null when nothing about it changed", () => {
    const child = tagNew<Item>({ id: 1, effects: [] });
    const saved = tagNew({ scalar: 0 });
    const savedChildren = [child];
    const draft = structuredClone(saved);
    const draftChildren = structuredClone(savedChildren);
    expect(
      containerStatus(draft, draftChildren, [saved], () => savedChildren, childCid, sameContainer),
    ).toBeNull();
  });

  it("is 'removed-inside' when a child present at save time is gone now", () => {
    const child = tagNew<Item>({ id: 1, effects: [] });
    const saved = tagNew({ scalar: 0 });
    const savedChildren = [child];
    const draft = structuredClone(saved);
    expect(
      containerStatus(draft, [], [saved], () => savedChildren, childCid, sameContainer),
    ).toBe("removed-inside");
  });

  it("is 'modified' when a scalar field changed but no child was lost", () => {
    const saved = tagNew({ scalar: 0 });
    const draft = structuredClone(saved);
    draft.scalar = 5;
    expect(containerStatus(draft, [], [saved], () => [], childCid, sameContainer)).toBe("modified");
  });

  it("prioritises 'removed-inside' over 'modified' when both are true", () => {
    const child = tagNew<Item>({ id: 1, effects: [] });
    const saved = tagNew({ scalar: 0 });
    const savedChildren = [child];
    const draft = structuredClone(saved);
    draft.scalar = 9; // also modified
    expect(
      containerStatus(draft, [], [saved], () => savedChildren, childCid, sameContainer),
    ).toBe("removed-inside");
  });
});

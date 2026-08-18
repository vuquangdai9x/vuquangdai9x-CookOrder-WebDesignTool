// Which cells the queue overlay connects.
//
// The bug this file follows was a whole missing renderer: node Play never
// imported the group visuals at all, so linked ropes and combined rails simply
// did not draw. Porting it is only half the job — the pairing rules are subtle
// enough that a wrong one looks like a rendering glitch rather than a bug, so
// they are pinned here as pure functions, with no DOM.
//
// The drawing itself (SVG, clipping, z-order) is not covered: it needs layout,
// and this suite has no jsdom. It is verified in the browser instead.

import { describe, expect, it } from "vitest";
import { combinedAdjacentPairs, linkedChains } from "./groupOverlay.ts";
import type { GroupedQueue } from "./groupOverlay.ts";
import type { QueueGroupKind } from "../../core/types.ts";

/**
 * A queue from a picture: one string per COLUMN, top row first. A digit is that
 * cell's group, "." is ungrouped, " " is a hole.
 */
function queue(kinds: QueueGroupKind[], ...columns: string[]): GroupedQueue {
  return {
    groupKinds: kinds,
    queueGrid: columns.map((col) =>
      [...col].map((ch) => (ch === " " ? null : { group: ch === "." ? -1 : Number(ch) })),
    ),
  };
}

const at = (p: { x: number; y: number }) => [p.x, p.y];

describe("combined rails", () => {
  it("joins horizontally adjacent cells of one block", () => {
    const pairs = combinedAdjacentPairs(queue(["combined"], "0", "0"), 3);
    expect(pairs.map((p) => [at(p.a), at(p.b)])).toEqual([[[0, 0], [1, 0]]]);
  });

  it("joins vertically adjacent cells too", () => {
    const pairs = combinedAdjacentPairs(queue(["combined"], "00"), 3);
    expect(pairs.map((p) => [at(p.a), at(p.b)])).toEqual([[[0, 0], [0, 1]]]);
  });

  it("emits each shared edge ONCE", () => {
    // Right/down only. Checking all four directions would draw every rail
    // twice — invisible on screen, but it doubles the SVG on every rebuild.
    expect(combinedAdjacentPairs(queue(["combined"], "00", "00"), 3)).toHaveLength(4);
  });

  it("does not join two different groups that happen to touch", () => {
    expect(combinedAdjacentPairs(queue(["combined", "combined"], "0", "1"), 3)).toEqual([]);
  });

  it("ignores linked groups — they get ropes, not rails", () => {
    expect(combinedAdjacentPairs(queue(["linked"], "0", "0"), 3)).toEqual([]);
  });

  it("stops at the window edge, with no off-window extrapolation", () => {
    // Unlike a rope, a rail answers no "how far away" question, so a block
    // running past the window just shows its visible part.
    const pairs = combinedAdjacentPairs(queue(["combined"], "000"), 2);
    expect(pairs.map((p) => [at(p.a), at(p.b)])).toEqual([[[0, 0], [0, 1]]]);
  });

  it("carries the group index, so each block can take its own colour", () => {
    const pairs = combinedAdjacentPairs(queue(["combined", "combined"], "0.1", "0.1"), 3);
    expect(pairs.map((p) => p.group).sort()).toEqual([0, 1]);
  });
});

describe("linked chains", () => {
  it("collects a group's cells across columns", () => {
    expect(linkedChains(queue(["linked"], "0", "0")).map((c) => c.map(at))).toEqual([
      [[0, 0], [1, 0]],
    ]);
  });

  it("orders by COLUMN, not row", () => {
    // The rule that matters for a 3+ member chain. Linking never restricts
    // movement, so members drift onto different rows; a row-first sort would
    // then pair whichever members happen to share a row rather than whichever
    // are actually adjacent in the chain.
    const chain = linkedChains(queue(["linked"], "  0", "0", " 0"))[0];
    expect(chain.map(at)).toEqual([[0, 2], [1, 0], [2, 1]]);
  });

  it("keeps separate groups separate", () => {
    const chains = linkedChains(queue(["linked", "linked"], "0", "0", "1", "1"));
    expect(chains).toHaveLength(2);
    expect(chains.map((c) => c.length)).toEqual([2, 2]);
  });

  it("ignores combined groups and ungrouped cells", () => {
    expect(linkedChains(queue(["combined"], "0", "0"))).toEqual([]);
    expect(linkedChains(queue([], "..", ".."))).toEqual([]);
  });

  it("returns a lone member, which simply draws no segment", () => {
    // A chain whose partners were all consumed is still a group; the renderer
    // walks pairs, so a single cell yields nothing rather than throwing.
    expect(linkedChains(queue(["linked"], "0"))[0].map(at)).toEqual([[0, 0]]);
  });
});

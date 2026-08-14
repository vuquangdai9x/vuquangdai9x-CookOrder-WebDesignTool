import { describe, expect, it } from "vitest";
import { testMap } from "../core/testFixtures.ts";
import type { MapData } from "./mapLoader.ts";
import { validateMap } from "./validate.ts";

/** cooked id 2 has no tool recipe in testMap (raw 2 passes straight through as itself). */
const withUsageNum = (usageNum: number): MapData => ({
  ...testMap,
  levels: [],
  cookedIngredients: testMap.cookedIngredients.map((c) => (c.id === 2 ? { ...c, usageNum } : c)),
});

function mapWithLevel(map: MapData, overrides: { queueString: string; customerString: string }): MapData {
  return {
    ...map,
    levels: [
      {
        id: 1,
        name: "test",
        weather: "Normal",
        levelTag: "",
        featureUnlock: "",
        serveableSlots: 2,
        shuffleDistance: 0,
        gridString: ",,,,,,,,,",
        ...overrides,
      },
    ],
  };
}

const messagesStartingWith = (map: MapData, prefix: string) =>
  validateMap(map).filter((w) => w.message.startsWith(prefix)).map((w) => w.message);

describe("validateMap — supply/demand check (in use units, not physical pickup count)", () => {
  it("without usageNum, warns when orders outnumber the queue's raw pickups", () => {
    // 2 pickups queued (2 uses available, usageNum 1), 3 orders.
    const map = mapWithLevel(withUsageNum(1), {
      queueString: "2%2",
      customerString: "0;0;0;2|0;0;0;2|0;0;0;2",
    });
    expect(messagesStartingWith(map, "Not enough")).toEqual([
      "Not enough raw2: orders need 3 use(s), queues supply 2.",
    ]);
  });

  it("a usageNum-2 ingredient balances exactly when supply*usageNum lands on demand", () => {
    // 2 pickups * usageNum 2 = 4 uses available, matching 4 order occurrences exactly.
    const map = mapWithLevel(withUsageNum(2), {
      queueString: "2%2",
      customerString: "0;0;0;2|0;0;0;2|0;0;0;2|0;0;0;2",
    });
    expect(messagesStartingWith(map, "Not enough")).toHaveLength(0);
    expect(messagesStartingWith(map, "Leftover")).toHaveLength(0);
  });

  it("still warns for a usageNum ingredient when available uses fall short of demand", () => {
    // 2 pickups * usageNum 2 = 4 uses available, but 5 orders need it.
    const map = mapWithLevel(withUsageNum(2), {
      queueString: "2%2",
      customerString: "0;0;0;2|0;0;0;2|0;0;0;2|0;0;0;2|0;0;0;2",
    });
    expect(messagesStartingWith(map, "Not enough")).toEqual([
      "Not enough raw2: orders need 5 use(s), queues supply 4.",
    ]);
  });

  it("a usageNum ingredient that divides evenly into demand needs no rounding to balance", () => {
    // 1 pickup * usageNum 3 = 3 uses available, matching 3 orders exactly.
    const map = mapWithLevel(withUsageNum(3), {
      queueString: "2",
      customerString: "0;0;0;2|0;0;0;2|0;0;0;2",
    });
    expect(messagesStartingWith(map, "Not enough")).toHaveLength(0);
    expect(messagesStartingWith(map, "Leftover")).toHaveLength(0);
  });

  it("warns about leftover capacity when a usageNum ingredient's supply exceeds demand", () => {
    // 2 pickups * usageNum 2 = 4 uses available, but only 3 orders need it —
    // bottles are indivisible, so this 1-use surplus is unavoidable given 2
    // whole pickups; the level isn't broken, but it's worth flagging.
    const map = mapWithLevel(withUsageNum(2), {
      queueString: "2%2",
      customerString: "0;0;0;2|0;0;0;2|0;0;0;2",
    });
    expect(messagesStartingWith(map, "Not enough")).toHaveLength(0);
    expect(messagesStartingWith(map, "Leftover")).toEqual([
      "Leftover raw2: queues supply 4 use(s) but orders only need 3 — some capacity of a landed piece will go unused.",
    ]);
  });

  it("does not warn about leftover for a normal (usageNum 1) ingredient, even with surplus supply", () => {
    // 5 pickups queued, only 2 orders — an ordinary surplus is expected
    // slack, not a usageNum discretization artifact, so no "Leftover" noise.
    const map = mapWithLevel(withUsageNum(1), {
      queueString: "2,2,2,2,2",
      customerString: "0;0;0;2|0;0;0;2",
    });
    expect(messagesStartingWith(map, "Not enough")).toHaveLength(0);
    expect(messagesStartingWith(map, "Leftover")).toHaveLength(0);
  });
});

describe("validateMap — dead Hidden statuses", () => {
  // "#2" is the Hidden status. It masks a slot until it reaches the front row,
  // so a Hidden that starts there already can never mask anything.
  const hiddenWarnings = (queueString: string) =>
    messagesStartingWith(
      mapWithLevel(withUsageNum(1), { queueString, customerString: "0;0;0;2" }),
      "Hidden",
    );

  it("warns about a Hidden authored on the front row", () => {
    expect(hiddenWarnings("2#2,2")).toEqual([
      "Hidden on queue cell (0,0) does nothing — it already starts on the front row.",
    ]);
  });

  it("stays quiet for a Hidden that actually starts buried", () => {
    expect(hiddenWarnings("2,2#2")).toHaveLength(0);
  });

  it("warns when a Hidden's combined block already fronts, since the block reveals as a unit", () => {
    // Combined block on (0,0)+(0,1); the Hidden at (0,1) is revealed from the
    // start because its block is pickable from the start.
    expect(hiddenWarnings("2,2#2$0-0,0-1$")).toEqual([
      "Hidden on queue cell (0,1) does nothing — its combined block already starts on the " +
        "front row, so the whole block is revealed from the start.",
    ]);
  });

  it("stays quiet when the Hidden's combined block starts off the front row", () => {
    // Block on (0,1)+(0,2) — min-y is 1, so it genuinely masks for a while.
    expect(hiddenWarnings("2,2#2,2$0-1,0-2$")).toHaveLength(0);
  });

  it("stays quiet for a Hidden in a linked group — linked reveals member-by-member", () => {
    // A linked group is only pickable once every member is at row 0, so its
    // members reveal on the plain y === 0 rule and none of this applies.
    expect(hiddenWarnings("2,2#2%2,2$$0-1,1-1")).toHaveLength(0);
  });
});

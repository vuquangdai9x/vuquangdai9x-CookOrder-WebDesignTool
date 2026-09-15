import { describe, expect, it } from "vitest";
import type { EffectInstance, QueueItem } from "../../core/types.ts";
import { cidOf, tagNew } from "./changeTracking.ts";
import { compactQueueDraft } from "./queueCompact.ts";

const effect = (effectId = 1): EffectInstance => ({ effectId, params: [2] });
const ingredient = (id: number, amount = 1, effects: EffectInstance[] = []): QueueItem =>
  tagNew({ kind: "ingredient", id, effects, ...(amount > 1 ? { amount } : {}) });

describe("compactQueueDraft", () => {
  it("groups only adjacent same-ingredient chains in Group nearly mode", () => {
    const draft = {
      queues: [[ingredient(1), ingredient(1), ingredient(2), ingredient(1)]],
      groups: [],
    };
    const result = compactQueueDraft(draft, { capping: "all", scope: "nearby", effects: "keep" });

    expect(result.removed).toBe(1);
    expect(draft.queues[0].map((item) => [item.id, item.amount ?? 1])).toEqual([[1, 2], [2, 1], [1, 1]]);
  });

  it("collapses separated matches within each lane without merging across lanes", () => {
    const draft = {
      queues: [
        [ingredient(1), ingredient(2), ingredient(1)],
        [ingredient(1), ingredient(1)],
      ],
      groups: [],
    };
    compactQueueDraft(draft, { capping: "all", scope: "all-in-lane", effects: "keep" });

    expect(draft.queues[0].map((item) => [item.id, item.amount ?? 1])).toEqual([[1, 2], [2, 1]]);
    expect(draft.queues[1].map((item) => [item.id, item.amount ?? 1])).toEqual([[1, 2]]);
  });

  it("uses stackMax as the per-bag cap", () => {
    const draft = { queues: [[ingredient(1), ingredient(1), ingredient(1), ingredient(1), ingredient(1)]], groups: [] };
    compactQueueDraft(
      draft,
      { capping: "max", scope: "nearby", effects: "keep" },
      { stackRange: () => ({ min: 2, max: 3 }) },
    );

    expect(draft.queues[0].map((item) => item.amount ?? 1)).toEqual([3, 2]);
  });

  it("selects a fresh random stack-range target for each bag", () => {
    const draws = [0, 0.99];
    const draft = { queues: [[ingredient(1), ingredient(1), ingredient(1), ingredient(1), ingredient(1)]], groups: [] };
    compactQueueDraft(
      draft,
      { capping: "random", scope: "nearby", effects: "keep" },
      { stackRange: () => ({ min: 2, max: 3 }), random: () => draws.shift() ?? 0 },
    );

    expect(draft.queues[0].map((item) => item.amount ?? 1)).toEqual([2, 3]);
  });

  it("keeps every effect-bearing slot distinct in Keep effect mode", () => {
    const affected = ingredient(1, 1, [effect()]);
    const draft = { queues: [[ingredient(1), affected, ingredient(1), ingredient(1)]], groups: [] };
    compactQueueDraft(draft, { capping: "all", scope: "all-in-lane", effects: "keep" });

    expect(draft.queues[0]).toHaveLength(2);
    expect(draft.queues[0]).toContain(affected);
    expect(draft.queues[0].find((item) => item !== affected)?.amount).toBe(3);
    expect(affected.effects).toHaveLength(1);
  });

  it("removes effects from a merged bag in Break effect mode", () => {
    const first = ingredient(1, 1, [effect()]);
    const draft = { queues: [[first, ingredient(1, 1, [effect(2)]), ingredient(1)]], groups: [] };
    compactQueueDraft(draft, { capping: "all", scope: "nearby", effects: "break" });

    expect(draft.queues[0]).toEqual([first]);
    expect(first.amount).toBe(3);
    expect(first.effects).toEqual([]);
  });

  it("breaks groups touched by removed slots and keeps unrelated groups", () => {
    const a = ingredient(1);
    const b = ingredient(1);
    const c = ingredient(2);
    const d = ingredient(3);
    const draft = {
      queues: [[a, b, c, d]],
      groups: [
        { kind: "linked" as const, cids: [cidOf(b)!, cidOf(c)!] },
        { kind: "combined" as const, cids: [cidOf(c)!, cidOf(d)!] },
      ],
    };
    compactQueueDraft(draft, { capping: "all", scope: "nearby", effects: "keep" });

    expect(draft.groups).toEqual([{ kind: "combined", cids: [cidOf(c)!, cidOf(d)!] }]);
  });
});

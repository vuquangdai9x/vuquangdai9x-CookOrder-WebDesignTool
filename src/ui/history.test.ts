import { describe, expect, it, vi } from "vitest";
import { History } from "./history.ts";

interface Draft {
  items: number[];
}

describe("per-section history", () => {
  it("undoes and redoes to prior drafts", () => {
    const draft: Draft = { items: [] };
    const history = new History<Draft>(draft, () => {});

    draft.items.push(1);
    history.push("add 1", draft, 1);
    draft.items.push(2);
    history.push("add 2", draft, 1);

    expect(history.undo()?.items).toEqual([1]);
    expect(history.undo()?.items).toEqual([]);
    expect(history.undo()).toBeNull(); // at the initial state
    expect(history.redo()?.items).toEqual([1]);
  });

  it("tracks dirtiness against the last saved position", () => {
    const draft: Draft = { items: [] };
    const history = new History<Draft>(draft, () => {});
    expect(history.isDirty).toBe(false);

    draft.items.push(1);
    history.push("add", draft, 1);
    expect(history.isDirty).toBe(true);
    expect(history.counters).toEqual({ added: 1, removed: 0 });

    history.markSaved();
    expect(history.isDirty).toBe(false);
    expect(history.counters).toEqual({ added: 0, removed: 0 });

    // Undoing away from the saved position is dirty again.
    history.undo();
    expect(history.isDirty).toBe(true);
  });

  it("accumulates add/remove counters across several actions", () => {
    const draft: Draft = { items: [] };
    const history = new History<Draft>(draft, () => {});
    history.push("a", draft, 3, 0);
    history.push("b", draft, 1, 2);
    expect(history.counters).toEqual({ added: 4, removed: 2 });
  });

  it("drops the redo branch once a new action is pushed", () => {
    const draft: Draft = { items: [] };
    const history = new History<Draft>(draft, () => {});
    draft.items.push(1);
    history.push("add 1", draft);
    history.undo();
    expect(history.canRedo()).toBe(true);
    history.push("different", { items: [9] });
    expect(history.canRedo()).toBe(false);
  });

  it("keeps snapshots isolated from later mutations of the live draft", () => {
    const draft: Draft = { items: [1] };
    const history = new History<Draft>(draft, () => {});
    history.push("snapshot", draft);
    draft.items.push(2); // mutate after pushing
    expect(history.undo()?.items).toEqual([1]);
  });

  it("notifies on every change so the header can refresh", () => {
    const onChange = vi.fn();
    const history = new History<Draft>({ items: [] }, onChange);
    history.push("a", { items: [1] });
    history.undo();
    history.markSaved();
    expect(onChange).toHaveBeenCalledTimes(3);
  });
});

// Per-section undo/redo history. Each Design section (customers, grid, queue)
// owns one instance: the stack doubles as undo/redo and as the source of truth
// for the unsaved badge and the +N/-N add/remove counters.
// See docs/ToolDesign.md "Shared shell".

export interface HistoryEntry<T> {
  action: string;
  state: T;
  added: number;
  removed: number;
}

export class History<T> {
  private entries: HistoryEntry<T>[] = [];
  private index = -1;
  private savedIndex = -1;
  private clone: (state: T) => T;
  private onChange: () => void;

  constructor(initial: T, onChange: () => void, clone?: (state: T) => T) {
    this.clone = clone ?? ((s) => structuredClone(s));
    this.onChange = onChange;
    this.entries = [{ action: "initial", state: this.clone(initial), added: 0, removed: 0 }];
    this.index = 0;
    this.savedIndex = 0;
  }

  /** Pushes the post-action state. Call after mutating the draft. */
  push(action: string, state: T, added = 0, removed = 0): void {
    this.entries.splice(this.index + 1);
    this.entries.push({ action, state: this.clone(state), added, removed });
    this.index = this.entries.length - 1;
    this.onChange();
  }

  canUndo(): boolean {
    return this.index > 0;
  }

  canRedo(): boolean {
    return this.index < this.entries.length - 1;
  }

  undo(): T | null {
    if (!this.canUndo()) return null;
    this.index--;
    this.onChange();
    return this.clone(this.entries[this.index].state);
  }

  redo(): T | null {
    if (!this.canRedo()) return null;
    this.index++;
    this.onChange();
    return this.clone(this.entries[this.index].state);
  }

  /** Marks the current position as persisted (clears the unsaved badge). */
  markSaved(atIndex = this.index): void {
    this.savedIndex = atIndex;
    this.onChange();
  }

  /** Index to hand to markSaved() after an async save, so a mid-save edit isn't wrongly cleared. */
  get currentIndex(): number {
    return this.index;
  }

  /** The last-saved snapshot — the baseline change-tracking borders diff against. */
  get savedState(): T {
    return this.clone(this.entries[this.savedIndex].state);
  }

  get isDirty(): boolean {
    return this.index !== this.savedIndex;
  }

  /** Net adds/removes since the last save, for the +N / -N counters. */
  get counters(): { added: number; removed: number } {
    let added = 0;
    let removed = 0;
    const from = Math.min(this.savedIndex, this.index);
    const to = Math.max(this.savedIndex, this.index);
    for (let i = from + 1; i <= to; i++) {
      added += this.entries[i].added;
      removed += this.entries[i].removed;
    }
    return { added, removed };
  }

  get lastAction(): string {
    return this.entries[this.index]?.action ?? "";
  }

  /** Replaces the whole stack, e.g. after switching level. */
  reset(initial: T): void {
    this.entries = [{ action: "initial", state: this.clone(initial), added: 0, removed: 0 }];
    this.index = 0;
    this.savedIndex = 0;
    this.onChange();
  }
}

/**
 * Wires Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z on a section element. Only fires when the
 * event target is inside that section and not a text input.
 */
export function bindUndoRedoKeys(
  section: HTMLElement,
  handlers: { undo(): void; redo(): void },
): void {
  section.addEventListener("keydown", (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
    const key = e.key.toLowerCase();
    if (key === "z" && !e.shiftKey) {
      e.preventDefault();
      handlers.undo();
    } else if (key === "y" || (key === "z" && e.shiftKey)) {
      e.preventDefault();
      handlers.redo();
    }
  });
}

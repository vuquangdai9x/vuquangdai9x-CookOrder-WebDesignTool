// Shared shell for the three Design sections (Customer / Grid / Queue).
// Each owns its history, unsaved badge, +N/-N counters, Save button and kebab
// menu, per docs/ToolDesign.md "Shared shell".

import { showContextMenu } from "../contextMenu.ts";
import type { MenuItem } from "../contextMenu.ts";
import { button, el } from "../dom.ts";
import { bindUndoRedoKeys, History } from "../history.ts";

export interface SectionOptions<T> {
  title: string;
  saveLabel: string;
  initial: T;
  /** Rebuilds the section body from the current draft. */
  renderBody(draft: T, body: HTMLElement): void;
  /** Persists the draft (writes canonical strings back to the level). */
  save(draft: T): void;
  /** Extra kebab-menu entries beyond Undo/Redo. */
  menuItems?(draft: T): MenuItem[];
  /**
   * Fires after any commit. Lets sibling sections recompute cross-section
   * readouts live — e.g. the queue's Recipe Pieces counts depend on the
   * customer orders and the grid's ColorLocks.
   */
  onCommit?(): void;
}

/**
 * A Design section: header (title, dirty badge, counters, Save, kebab) plus a
 * body that the caller re-renders from the draft.
 */
export class Section<T> {
  readonly element: HTMLElement;
  draft: T;
  readonly history: History<T>;
  private body: HTMLElement;
  private badge: HTMLElement;
  private counters: HTMLElement;
  private opts: SectionOptions<T>;

  constructor(opts: SectionOptions<T>) {
    this.opts = opts;
    this.draft = structuredClone(opts.initial);
    this.badge = el("span", { class: "dirty-badge" }, ["🔴 Unsaved"]);
    this.counters = el("span", { class: "dirty-counters" });
    this.body = el("div", { class: "section-body" });
    this.history = new History<T>(this.draft, () => this.refreshHeader());

    const header = el("div", { class: "section-head" }, [
      el("h2", {}, [opts.title]),
      this.badge,
      this.counters,
      el("div", { class: "section-actions" }, [
        button(opts.saveLabel, () => this.commitSave(), { class: "primary" }),
        button("⋮", (e) => this.openMenu(e), { class: "kebab", title: "More actions" }),
      ]),
    ]);

    this.element = el("section", { class: "design-section", tabindex: "0" }, [
      header,
      this.body,
    ]);
    bindUndoRedoKeys(this.element, { undo: () => this.undo(), redo: () => this.redo() });
    this.refreshHeader();
  }

  /** Call after mutating `draft` to record history and re-render. */
  commit(action: string, added = 0, removed = 0): void {
    this.history.push(action, this.draft, added, removed);
    this.render();
    this.opts.onCommit?.();
  }

  render(): void {
    this.body.replaceChildren();
    this.opts.renderBody(this.draft, this.body);
    this.refreshHeader();
  }

  /** Replaces the draft wholesale (level switch) and resets history. */
  reset(next: T): void {
    this.draft = structuredClone(next);
    this.history.reset(this.draft);
    this.render();
  }

  get isDirty(): boolean {
    return this.history.isDirty;
  }

  private commitSave(): void {
    const savingIndex = this.history.currentIndex;
    this.opts.save(this.draft);
    this.history.markSaved(savingIndex);
    this.render();
  }

  private undo(): void {
    const state = this.history.undo();
    if (!state) return;
    this.draft = state;
    this.render();
  }

  private redo(): void {
    const state = this.history.redo();
    if (!state) return;
    this.draft = state;
    this.render();
  }

  private openMenu(event: MouseEvent): void {
    const items: MenuItem[] = [
      {
        label: `Undo${this.history.lastAction ? ` — ${this.history.lastAction}` : ""}`,
        disabled: !this.history.canUndo(),
        onSelect: () => this.undo(),
      },
      { label: "Redo", disabled: !this.history.canRedo(), onSelect: () => this.redo() },
      ...(this.opts.menuItems?.(this.draft) ?? []),
    ];
    showContextMenu(event, items, { title: this.opts.title });
  }

  private refreshHeader(): void {
    this.badge.style.display = this.history.isDirty ? "" : "none";
    const { added, removed } = this.history.counters;
    this.counters.textContent =
      this.history.isDirty && (added || removed) ? `+${added} / -${removed}` : "";
  }
}

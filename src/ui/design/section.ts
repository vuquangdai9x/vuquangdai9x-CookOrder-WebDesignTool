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
   * Lets the title act as a foldout: clicking it hides the body, leaving just
   * the header (with its dirty badge, string preview and actions) on screen.
   * Collapsed state lives on the section element, so it survives body
   * re-renders and level switches.
   */
  collapsible?: boolean;
  /**
   * Renders the draft's current canonical string (the same format saved to
   * the level) inline in the header, next to the title/Save/kebab, so a
   * designer can see the exact string a level would serialize to without
   * opening dev tools. Recomputed on every render.
   */
  stringPreview?(draft: T): string;
  /**
   * Extra buttons rendered in the header, before Save (e.g. the queue
   * section's "＋ Queue"). Built once at construction time with the `Section`
   * instance itself — not a snapshot of `draft` — so a click handler that
   * reads `section.draft`/calls `section.commit()` keeps working correctly
   * even after undo/redo or a level switch reassigns `draft` wholesale.
   */
  headerButtons?(section: Section<T>): HTMLElement[];
  /**
   * Fires after any commit. Lets sibling sections recompute cross-section
   * readouts live — e.g. the queue's Recipe Pieces counts depend on the
   * customer orders and the grid's ColorLocks.
   */
  onCommit?(): void;
  /**
   * Optional "Write to sheet" button + status, shown in the right-pinned
   * action group next to Save. Status compares the live draft's
   * stringPreview output against the string from the last successful write,
   * so it reads "written" / "changed since write" without any extra state
   * the caller has to track.
   */
  writeToSheet?: {
    label?: string;
    write(draft: T): Promise<void>;
  };
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
  private stringEl: HTMLElement | null = null;
  private opts: SectionOptions<T>;
  private writeStatusEl: HTMLElement | null = null;
  private writeBtn: HTMLButtonElement | null = null;
  private lastWrittenString: string | null = null;
  private writeError: string | null = null;
  private writing = false;

  constructor(opts: SectionOptions<T>) {
    this.opts = opts;
    this.draft = structuredClone(opts.initial);
    this.badge = el("span", { class: "dirty-badge" }, ["🔴 Unsaved"]);
    this.counters = el("span", { class: "dirty-counters" });
    this.body = el("div", { class: "section-body" });
    this.history = new History<T>(this.draft, () => this.refreshHeader());

    if (opts.stringPreview) this.stringEl = el("code", { class: "section-string" });

    // Left group (title + dirty status) stays put; the string preview (if
    // any) takes whatever's left in the middle; Save/kebab/Write are pinned
    // to the far right in their own no-wrap group — see .section-head in
    // style.css.
    const title = el("h2", {}, [opts.title]);
    if (opts.collapsible) {
      title.classList.add("section-fold");
      title.tabIndex = 0;
      title.title = "Click to fold this section away";
      const marker = el("span", { class: "section-fold-marker" }, ["▾"]);
      title.prepend(marker);
      const toggle = () => {
        const collapsed = this.element.classList.toggle("collapsed");
        this.body.hidden = collapsed;
        marker.textContent = collapsed ? "▸" : "▾";
        title.setAttribute("aria-expanded", String(!collapsed));
      };
      title.setAttribute("aria-expanded", "true");
      title.addEventListener("click", toggle);
      title.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        toggle();
      });
    }

    const left = el("div", { class: "section-head-left" }, [
      title,
      this.badge,
      this.counters,
    ]);

    const actions = el("div", { class: "section-actions" }, [
      ...(opts.headerButtons?.(this) ?? []),
    ]);
    if (opts.writeToSheet) {
      this.writeStatusEl = el("span", { class: "write-status" });
      this.writeBtn = button(opts.writeToSheet.label ?? "⇪ Write to sheet", () => this.doWrite(), {});
      actions.append(this.writeStatusEl, this.writeBtn);
    }
    actions.append(
      button(opts.saveLabel, () => this.commitSave(), { class: "primary" }),
      button("⋮", (e) => this.openMenu(e), { class: "kebab", title: "More actions" }),
    );

    const header = el("div", { class: "section-head" }, [
      left,
      ...(this.stringEl ? [this.stringEl] : []),
      actions,
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

  /**
   * `renderBody` rebuilds its content from scratch every call — a fresh DOM
   * subtree, so any scrollable element inside it (e.g. the customer card
   * row) is a brand-new node starting at scroll offset 0. Editing one field
   * deep in a long, already-scrolled list would otherwise silently snap the
   * view back to the start on every keystroke. A section opts in per element
   * by tagging it `data-scroll-key="some-stable-name"`; this captures each
   * tagged element's scroll offset before the rebuild and restores it onto
   * whichever new element carries the same key afterward.
   */
  render(): void {
    const scrollPositions = new Map<string, { left: number; top: number }>();
    this.body.querySelectorAll<HTMLElement>("[data-scroll-key]").forEach((el) => {
      scrollPositions.set(el.dataset.scrollKey!, { left: el.scrollLeft, top: el.scrollTop });
    });

    this.body.replaceChildren();
    this.opts.renderBody(this.draft, this.body);

    this.body.querySelectorAll<HTMLElement>("[data-scroll-key]").forEach((el) => {
      const pos = scrollPositions.get(el.dataset.scrollKey!);
      if (!pos) return;
      el.scrollLeft = pos.left;
      el.scrollTop = pos.top;
    });

    this.refreshHeader();
    if (this.stringEl && this.opts.stringPreview) {
      this.stringEl.textContent = this.opts.stringPreview(this.draft) || "(empty)";
    }
    this.refreshWriteStatus();
  }

  /** Replaces the draft wholesale (level switch) and resets history. */
  reset(next: T): void {
    this.draft = structuredClone(next);
    this.history.reset(this.draft);
    // A different level's draft has nothing to do with what was last
    // written to the sheet for the previous level.
    this.lastWrittenString = null;
    this.writeError = null;
    this.render();
  }

  get isDirty(): boolean {
    return this.history.isDirty;
  }

  /** The last-saved snapshot of this section's draft, for change-tracking borders. */
  get savedState(): T {
    return this.history.savedState;
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

  private async doWrite(): Promise<void> {
    const spec = this.opts.writeToSheet;
    if (!spec || this.writing) return;
    this.writing = true;
    this.writeError = null;
    if (this.writeBtn) this.writeBtn.disabled = true;
    this.refreshWriteStatus();
    try {
      await spec.write(this.draft);
      this.lastWrittenString = this.opts.stringPreview?.(this.draft) ?? null;
    } catch (err) {
      console.error(err);
      this.writeError = (err as Error).message;
    } finally {
      this.writing = false;
      if (this.writeBtn) this.writeBtn.disabled = false;
      this.refreshWriteStatus();
    }
  }

  private refreshWriteStatus(): void {
    if (!this.writeStatusEl) return;
    if (this.writing) {
      this.writeStatusEl.textContent = "⏳ Writing…";
      this.writeStatusEl.className = "write-status pending";
      return;
    }
    if (this.writeError) {
      this.writeStatusEl.textContent = `✗ ${this.writeError}`;
      this.writeStatusEl.className = "write-status failed";
      this.writeStatusEl.title = this.writeError;
      return;
    }
    if (this.lastWrittenString === null) {
      this.writeStatusEl.textContent = "";
      this.writeStatusEl.className = "write-status";
      this.writeStatusEl.removeAttribute("title");
      return;
    }
    const current = this.opts.stringPreview?.(this.draft);
    const upToDate = this.lastWrittenString === current;
    this.writeStatusEl.textContent = upToDate ? "✓ Written" : "● Changed since write";
    this.writeStatusEl.className = `write-status ${upToDate ? "ok" : "stale"}`;
    this.writeStatusEl.removeAttribute("title");
  }
}

// Map Process mode — the node editor.
//
// A graph document is edited here and nowhere else: vertices, edges, the id
// table, and the layout. Three decisions shape the whole view:
//
//  1. **The schema drives the UI.** The creatable-vertex palette, the
//     inspector's fields, the legal wiring matrix and the invariant severities
//     all come from config/nodegraph/schema.json at runtime. Adding a field is
//     a data edit, not a code edit.
//
//  2. **One History<NodeGraphMap> for the whole document.** Not per-panel:
//     vertices and edges are mutually referential, so a per-section stack could
//     undo a vertex back into existence without its edges, or vice versa. One
//     entry per COMPLETED GESTURE — a drag is one entry on pointerup, not one
//     per pointermove; an inspector field is one entry on blur, not per
//     keystroke; a rejected wire pushes nothing at all.
//
//  3. **Id-table maintenance is automatic and part of the same undo entry.**
//     Creating a servable/pickupable ingredient mints the next id, deleting one
//     tombstones it, renaming leaves the id alone. If those were separate undo
//     entries, one Ctrl+Z would leave the table and the graph disagreeing.
//
// DOM nodes on a CSS-transformed canvas with one SVG edge overlay, rather than
// a <canvas>: the vertices then render real `ui/icon.ts` artwork and get real
// focus/context-menu behaviour for free.

import Sortable from "sortablejs";

import { showContextMenu } from "../contextMenu.ts";
import { button, el } from "../dom.ts";
import { History, bindUndoRedoKeys } from "../history.ts";
import { cookedIconEl, dirtyIconEl, toolIconEl } from "../icon.ts";
import { autoLayout, layoutKey } from "./autoLayout.ts";
import type { Layout } from "./autoLayout.ts";
import { csvToGraph, graphToCsv } from "../../data/nodeGraphCsv.ts";
import { reorderToolProcesses } from "../../data/nodeGraphEdit.ts";
import {
  EDGE_KIND_NAMES,
  NODE_GRAPH_SCHEMA,
  VERTEX_KIND_NAMES,
  edgeAllowed,
  edgeKind,
  vertexFields,
  vertexKind,
} from "../../data/nodeGraphSchema.ts";
import { buildLookup, traceAll } from "../../data/nodeGraphResolve.ts";
import { validateNodeGraph } from "../../data/nodeGraphValidate.ts";
import { ID_SPACES, buildIdIndex, mintId, nextId, renameNode, retireId, reorderIdEntry } from "../../data/nodeIdTable.ts";
import { createNodeMap, listNodeMaps, loadNodeProject } from "../../data/nodeProject.ts";
import type { NodeProjectState } from "../../data/nodeProject.ts";
import type {
  EdgeKindName,
  FieldDef,
  GraphNote,
  IdSpace,
  NodeGraphMap,
  VertexKindName,
} from "../../data/nodeGraphTypes.ts";
import { downloadFile } from "../../data/sheetSource.ts";

/** Which id space a vertex kind mints into. */
const SPACE_OF: Record<VertexKindName, IdSpace> = {
  ingredient: "ingredient",
  tool: "tool",
  group: "group",
  composite: "composite",
  dirty: "dirty",
};

interface Selection {
  kind: VertexKindName;
  name: string;
}

const selKey = (target: Selection): string => `${target.kind}:${target.name}`;

/**
 * Which mouse button drives which gesture. Named because the mapping is the
 * whole point of the input model and reads as noise otherwise:
 *
 *   LEFT on a node      — move it (and everything else selected)
 *   LEFT on empty space — rubber-band a selection box
 *   RIGHT anywhere      — pan, INCLUDING over a node, so there is no dead zone
 *                         a designer can land on and find panning doesn't work
 *   RIGHT, no drag      — the custom menu for whatever is under the cursor
 *
 * The browser's own context menu is suppressed across the whole viewport, so
 * right-drag can be a pan without a menu flashing up at the end of it.
 */
const BUTTON_LEFT = 0;
const BUTTON_RIGHT = 2;

/** Below this a right-press is a click (menu), above it a drag (pan). */
const PAN_SLOP_PX = 4;

/**
 * A row drawn inside a node. A tool's rows are its recipes; a composite's are
 * its two assembly slots. Rows exist so a recipe or a slot can be a WIRING
 * TARGET in its own right — without them, "which of this tool's five recipes
 * did you just drop an ingredient into?" has no answer.
 */
type NodeRow =
  | { type: "process"; processIndex: number }
  | { type: "add-process" }
  | { type: "base" }
  | { type: "topping" };

const rowKey = (row: NodeRow): string =>
  row.type === "process" ? `process:${row.processIndex}` : row.type;
const sameRow = (a: NodeRow, b: NodeRow): boolean => rowKey(a) === rowKey(b);

/** Inverse of `rowKey`, for reading a row back off a dropped port's dataset. */
function parseRowKey(key: string | undefined): NodeRow | undefined {
  if (!key) return undefined;
  if (key.startsWith("process:")) return { type: "process", processIndex: Number(key.slice(8)) };
  if (key === "base" || key === "topping" || key === "add-process") return { type: key };
  return undefined;
}

/** One end of a wire: a node side, optionally narrowed to one of its rows. */
interface PortRef {
  kind: VertexKindName;
  name: string;
  side: "in" | "out";
  row?: NodeRow;
}

/**
 * The two derived mapping-table nodes. Not a data-model concept — nothing is
 * stored under these names; they only label the two views the canvas draws.
 */
type TableName = "pickupable" | "orderable";
const TABLE_NAMES: TableName[] = ["pickupable", "orderable"];

const NODE_W = 190;
/** Header block height. Port geometry is computed from these, not measured. */
const NODE_HEAD_H = 46;
const NODE_ROW_H = 22;

export class MapProcessView {
  private root: HTMLElement;
  private project: NodeProjectState;
  private onPersist: () => void;

  private history: History<NodeGraphMap>;
  private doc: NodeGraphMap;

  /**
   * The INSPECTED node — the one the side panel describes. Multi-select needs a
   * primary because an inspector for six nodes at once is not a useful thing to
   * render; `selected` below is the set the canvas highlights and drags.
   */
  private selection: Selection | null = null;
  /** Every selected node, as `kind:name`. Always contains `selection` when set. */
  private selected = new Set<string>();

  private canvas!: HTMLElement;
  private edgeLayer!: SVGSVGElement;
  private marquee!: HTMLElement;
  private sidePanel!: HTMLElement;
  private statusBar!: HTMLElement;
  private toolbar!: HTMLElement;

  private pan = { x: 0, y: 0 };
  private scale = 1;

  constructor(root: HTMLElement, project: NodeProjectState, onPersist: () => void) {
    this.root = root;
    this.project = project;
    this.onPersist = onPersist;
    this.doc = project.doc;
    this.history = new History<NodeGraphMap>(this.doc, () => this.refreshChrome());
    this.build();
  }

  get isDirty(): boolean {
    return this.history.isDirty;
  }

  // ---------- shell ----------

  private build(): void {
    this.toolbar = el("div", { class: "nodegraph-toolbar" });
    this.statusBar = el("div", { class: "nodegraph-status" });
    this.edgeLayer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.edgeLayer.classList.add("nodegraph-edges");
    this.marquee = el("div", { class: "nodegraph-marquee" });
    this.marquee.style.display = "none";
    this.canvas = el("div", { class: "nodegraph-canvas" });
    this.canvas.append(this.edgeLayer, this.marquee);

    const viewport = el("div", { class: "nodegraph-viewport" }, [this.canvas]);
    this.sidePanel = el("aside", { class: "nodegraph-side" });

    const section = el("section", { class: "section nodegraph-page", tabindex: "0" }, [
      this.toolbar,
      el("div", { class: "nodegraph-body" }, [viewport, this.sidePanel]),
      this.statusBar,
    ]);
    this.root.replaceChildren(section);

    bindUndoRedoKeys(section, { undo: () => this.undo(), redo: () => this.redo() });
    this.wireViewportGestures(viewport);
    this.wireSelectionKeys(section);

    // No persisted layout yet — lay the graph out once so the first open is
    // readable rather than a pile of nodes at the origin.
    if (!this.doc.layout || Object.keys(this.doc.layout).length === 0) {
      this.doc.layout = autoLayout(this.doc);
    }

    this.renderToolbar();
    this.renderGraph();
    this.renderSide();
    this.refreshChrome();
  }

  private refreshChrome(): void {
    this.renderToolbar();
    const { errors, warnings } = validateNodeGraph(this.doc);
    this.statusBar.replaceChildren(
      el("span", { class: errors.length ? "nodegraph-bad" : "nodegraph-good" }, [
        `${errors.length} error${errors.length === 1 ? "" : "s"}`,
      ]),
      el("span", { class: "nodegraph-warn" }, [
        `${warnings.length} warning${warnings.length === 1 ? "" : "s"}`,
      ]),
      el("span", {}, [
        `${this.doc.vertices.ingredient.length} ingredients · ${this.doc.vertices.tool.length} tools · ` +
          `${this.doc.vertices.group.length} groups · ${this.doc.vertices.composite.length} composites`,
      ]),
      el("span", { class: this.history.isDirty ? "nodegraph-bad" : "" }, [
        this.history.isDirty ? "unsaved" : "saved",
      ]),
    );
  }

  private renderToolbar(): void {
    const undoBtn = button("↶ Undo", () => this.undo(), {});
    const redoBtn = button("↷ Redo", () => this.redo(), {});
    undoBtn.disabled = !this.history.canUndo();
    redoBtn.disabled = !this.history.canRedo();

    this.toolbar.replaceChildren(
      this.mapPicker(),
      button("＋ New map", () => this.newMap(), { title: "Start an empty graph" }),
      button("＋ Add node", (e) => this.addNodeMenu(e), { title: "Create a vertex" }),
      undoBtn,
      redoBtn,
      button("⤢ Auto layout", () => this.applyAutoLayout(), { title: "Re-run the layered layout" }),
      button("⬇ JSON", () => this.exportJson(), { title: "Download this graph as JSON" }),
      button("⬇ CSV", () => this.exportCsv(), { title: "Download this graph as CSV" }),
      button("⬆ CSV", () => this.importCsv(), { title: "Replace this graph from a CSV file" }),
      button("💾 Save draft", () => this.save(), { class: "primary" }),
    );
  }

  /**
   * The map picker.
   *
   * Rebuilt on every toolbar render rather than kept as a field, because the
   * list itself is state: creating a map adds a row, and renaming one in the
   * inspector changes a label. A cached <select> would go stale in exactly the
   * moments a designer is looking at it.
   */
  private mapPicker(): HTMLElement {
    const select = el("select", { class: "nodegraph-map-picker", title: "Switch map" }) as HTMLSelectElement;
    for (const entry of listNodeMaps()) {
      const option = el("option", { value: entry.id }) as HTMLOptionElement;
      option.textContent = `${entry.name}${entry.bundled ? "" : " ·"}${entry.hasDraft ? " ✎" : ""}`;
      option.selected = entry.id === this.project.docId;
      select.append(option);
    }
    select.addEventListener("change", () => this.switchMap(select.value));
    return select;
  }

  /**
   * Open another map.
   *
   * Unsaved work is confirmed FIRST, before anything is loaded — switching is
   * the one gesture here that can silently discard a session's edits, and the
   * draft of the map being left is only written by an explicit save.
   */
  private switchMap(docId: string): void {
    if (docId === this.project.docId) return;
    if (this.history.isDirty && !confirm("This map has unsaved changes. Switch anyway and lose them?")) {
      this.renderToolbar(); // put the <select> back on the map we are still editing
      return;
    }
    this.adopt(loadNodeProject(docId));
  }

  private newMap(): void {
    const name = prompt("Name the new map:");
    if (name === null || name.trim() === "") return;
    if (this.history.isDirty && !confirm("This map has unsaved changes. Leave it and lose them?")) return;
    this.adopt(createNodeMap(name));
  }

  /**
   * Point the whole view at a different project.
   *
   * History is REPLACED, not extended: undo must not walk backwards out of one
   * map and into another, which would be both meaningless and a way to save the
   * wrong graph over the wrong draft.
   */
  private adopt(next: NodeProjectState): void {
    this.project.docId = next.docId;
    this.project.doc = next.doc;
    this.project.levels = next.levels;
    this.project.origin = next.origin;

    this.doc = next.doc;
    this.history = new History<NodeGraphMap>(this.doc, () => this.refreshChrome());
    this.selection = null;
    this.selected.clear();
    this.pan = { x: 0, y: 0 };
    this.scale = 1;

    if (!this.doc.layout || Object.keys(this.doc.layout).length === 0) {
      this.doc.layout = autoLayout(this.doc);
    }
    this.onPersist();
    this.renderGraph();
    this.renderSide();
    this.refreshChrome();
  }

  private save(): void {
    this.project.doc = this.doc;
    this.history.markSaved();
    this.onPersist();
  }

  // ---------- history ----------

  /** Commits one completed gesture. Everything that mutates the doc ends here. */
  private commit(action: string, added = 0, removed = 0): void {
    this.history.push(action, this.doc, added, removed);
    this.project.doc = this.doc;
    this.renderGraph();
    this.renderSide();
    this.refreshChrome();
  }

  private undo(): void {
    const state = this.history.undo();
    if (!state) return;
    this.applyState(state);
  }

  private redo(): void {
    const state = this.history.redo();
    if (!state) return;
    this.applyState(state);
  }

  private applyState(state: NodeGraphMap): void {
    this.doc = state;
    this.project.doc = state;
    // The selection may name a vertex that no longer exists at this point in
    // history; drop it rather than render an inspector for a ghost.
    if (this.selection && !this.vertexAt(this.selection)) this.selection = null;
    // The multi-selection can go stale the same way — an undone bulk create
    // leaves keys naming vertices this state does not have.
    for (const key of [...this.selected]) {
      if (!this.vertexAt(this.parseSelKey(key))) this.selected.delete(key);
    }
    this.renderGraph();
    this.renderSide();
    this.refreshChrome();
  }

  // ---------- canvas ----------

  private wireViewportGestures(viewport: HTMLElement): void {
    viewport.addEventListener("wheel", (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      const next = Math.min(2.5, Math.max(0.25, this.scale * factor));
      // Zoom about the pointer, so the thing under the cursor stays put.
      const rect = viewport.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      this.pan.x = px - ((px - this.pan.x) * next) / this.scale;
      this.pan.y = py - ((py - this.pan.y) * next) / this.scale;
      this.scale = next;
      this.applyTransform();
    });

    // The browser menu is suppressed for the WHOLE viewport, nodes included.
    // Right-drag is a pan, and a native menu appearing at the end of one would
    // make panning feel broken. Our own menus are opened from pointerup, where
    // we can tell a click from a drag.
    viewport.addEventListener("contextmenu", (e) => e.preventDefault());

    // Right-press is captured at the viewport so it wins over the node's own
    // pointerdown — panning must work with the cursor anywhere, including on
    // top of a node.
    viewport.addEventListener(
      "pointerdown",
      (e) => {
        if (e.button !== BUTTON_RIGHT) return;
        e.preventDefault();
        e.stopPropagation();
        this.beginPan(e);
      },
      { capture: true },
    );

    viewport.addEventListener("pointerdown", (e) => {
      if (e.button !== BUTTON_LEFT) return;
      // Only a press on genuinely empty canvas starts a marquee; a press on a
      // node is that node's own gesture.
      if (e.target !== viewport && e.target !== this.canvas && e.target !== this.edgeLayer) return;
      this.beginMarquee(e);
    });
  }

  /**
   * Right-drag pan. A right press that never moves is a CLICK, and opens the
   * menu for whatever sits under it — so the same button both pans and opens
   * menus without the two fighting.
   */
  private beginPan(down: PointerEvent): void {
    const startX = down.clientX - this.pan.x;
    const startY = down.clientY - this.pan.y;
    let panned = false;

    const move = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) > PAN_SLOP_PX) panned = true;
      if (!panned) return;
      this.canvas.classList.add("panning");
      this.pan.x = e.clientX - startX;
      this.pan.y = e.clientY - startY;
      this.applyTransform();
    };
    const up = (e: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      this.canvas.classList.remove("panning");
      if (panned) return;
      const node = (down.target as HTMLElement).closest?.(".nodegraph-node") as HTMLElement | null;
      const kind = node?.dataset.kind as VertexKindName | undefined;
      if (node && kind) this.nodeMenu({ kind, name: node.dataset.name ?? "" }, e);
      else this.canvasMenu(e);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  /**
   * Left-drag from empty canvas: a rubber-band box that selects everything it
   * touches on release. A press that never moves is a plain click, and clears
   * the selection — the gesture a designer reaches for to "get back to nothing".
   */
  private beginMarquee(down: PointerEvent): void {
    const additive = down.shiftKey;
    const before = new Set(this.selected);
    const origin = this.canvasPoint(down);
    let dragged = false;

    const move = (e: PointerEvent) => {
      const at = this.canvasPoint(e);
      if (!dragged && Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) <= PAN_SLOP_PX) return;
      dragged = true;

      const box = {
        x: Math.min(origin.x, at.x),
        y: Math.min(origin.y, at.y),
        w: Math.abs(at.x - origin.x),
        h: Math.abs(at.y - origin.y),
      };
      this.marquee.style.display = "block";
      this.marquee.style.left = `${box.x}px`;
      this.marquee.style.top = `${box.y}px`;
      this.marquee.style.width = `${box.w}px`;
      this.marquee.style.height = `${box.h}px`;

      // Live feedback: recompute from the ORIGINAL set every move, so dragging
      // the box back smaller unselects again instead of accumulating.
      this.selected = additive ? new Set(before) : new Set();
      for (const target of this.nodesIn(box)) this.selected.add(selKey(target));
      this.paintSelection();
    };

    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      this.marquee.style.display = "none";
      if (!dragged) {
        // A bare click on empty space: clear, unless Shift says "keep what I have".
        if (!additive) this.clearSelection();
        return;
      }
      // The inspector follows the last node the box caught, so a marquee of one
      // behaves exactly like clicking it.
      const first = [...this.selected][this.selected.size - 1];
      this.selection = first ? this.parseSelKey(first) : null;
      this.renderSide();
      this.paintSelection();
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  private wireSelectionKeys(section: HTMLElement): void {
    section.addEventListener("keydown", (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      // A designer typing in the inspector expects Ctrl+A to select the TEXT.
      // Stealing it there would make the field unusable.
      const inField = (e.target as HTMLElement)?.closest("input, textarea, select");
      if (inField) return;

      const key = e.key.toLowerCase();
      if (key === "a") {
        e.preventDefault();
        this.selectAll();
      } else if (key === "d") {
        e.preventDefault();
        this.clearSelection();
      }
    });
  }

  /** Right-click on empty canvas. The position is captured so the note lands where the menu opened. */
  private canvasMenu(e: PointerEvent): void {
    const at = this.canvasPoint(e);
    showContextMenu(
      e,
      [
        { label: "📝 Add note here", onSelect: () => this.addNote(at) },
        { label: "＋ Add node", separator: true, onSelect: () => this.addNodeMenu(e) },
        { label: "▣ Select all", onSelect: () => this.selectAll() },
        { label: "▢ Deselect all", onSelect: () => this.clearSelection() },
      ],
      { title: "Canvas" },
    );
  }

  private addNote(at: { x: number; y: number }): void {
    const text = prompt("Note:");
    if (text === null || text.trim() === "") return;
    this.doc = structuredClone(this.doc);
    if (!this.doc.notes) this.doc.notes = [];
    this.doc.notes.push({ id: `note-${Date.now().toString(36)}`, x: at.x, y: at.y, text: text.trim() });
    this.commit("add note", 1);
  }

  private editNote(id: string): void {
    const existing = this.doc.notes?.find((n) => n.id === id);
    if (!existing) return;
    const text = prompt("Note:", existing.text);
    if (text === null) return;
    this.doc = structuredClone(this.doc);
    // An emptied note is a deleted note — a blank sticky is only clutter.
    if (text.trim() === "") {
      this.doc.notes = (this.doc.notes ?? []).filter((n) => n.id !== id);
      this.commit("delete note", 0, 1);
      return;
    }
    const note = this.doc.notes?.find((n) => n.id === id);
    if (note) note.text = text.trim();
    this.commit("edit note");
  }

  private noteEl(note: GraphNote): HTMLElement {
    const box = el("div", { class: "nodegraph-note", "data-note": note.id }, [
      el("span", { class: "nodegraph-note-text" }, [note.text]),
    ]);
    box.style.left = `${note.x}px`;
    box.style.top = `${note.y}px`;

    box.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      this.editNote(note.id);
    });
    box.addEventListener("pointerdown", (e) => {
      if (e.button !== BUTTON_LEFT) return; // right-press belongs to the pan handler
      e.stopPropagation();
      const start = { x: note.x, y: note.y };
      let moved = false;
      const move = (ev: PointerEvent) => {
        moved = true;
        const x = start.x + (ev.clientX - e.clientX) / this.scale;
        const y = start.y + (ev.clientY - e.clientY) / this.scale;
        box.style.left = `${x}px`;
        box.style.top = `${y}px`;
        const live = this.doc.notes?.find((n) => n.id === note.id);
        if (live) {
          live.x = x;
          live.y = y;
        }
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        if (moved) {
          this.doc = structuredClone(this.doc);
          this.commit("move note");
        }
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
    return box;
  }

  /** Pointer position in CANVAS space, undoing the pan/zoom transform. */
  private canvasPoint(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: (e.clientX - rect.left) / this.scale, y: (e.clientY - rect.top) / this.scale };
  }

  /** Every vertex whose box intersects the given canvas-space rectangle. */
  private nodesIn(box: { x: number; y: number; w: number; h: number }): Selection[] {
    const hits: Selection[] = [];
    for (const kind of VERTEX_KIND_NAMES) {
      for (const vertex of this.doc.vertices[kind]) {
        const pos = this.positionOf(kind, vertex.name);
        const h = this.nodeHeight(kind, vertex.name);
        const overlaps =
          pos.x < box.x + box.w && pos.x + NODE_W > box.x && pos.y < box.y + box.h && pos.y + h > box.y;
        if (overlaps) hits.push({ kind, name: vertex.name });
      }
    }
    return hits;
  }

  private parseSelKey(key: string): Selection {
    const at = key.indexOf(":");
    return { kind: key.slice(0, at) as VertexKindName, name: key.slice(at + 1) };
  }

  // ---------- selection ----------

  /**
   * Repaint the selection WITHOUT rebuilding the graph.
   *
   * Marquee drag touches this on every pointermove, and a full `renderGraph()`
   * there would rebuild every node and re-lay every edge sixty times a second.
   * Selection is a class on an existing element, so toggling classes is both
   * correct and the only version that stays smooth.
   */
  private paintSelection(): void {
    for (const el of this.canvas.querySelectorAll<HTMLElement>(".nodegraph-node")) {
      const key = `${el.dataset.kind}:${el.dataset.name}`;
      el.classList.toggle("selected", this.selected.has(key));
      el.classList.toggle("primary", this.selection !== null && key === selKey(this.selection));
    }
    this.refreshChrome();
  }

  private clearSelection(): void {
    this.selected.clear();
    this.selection = null;
    this.renderSide();
    this.paintSelection();
  }

  private selectAll(): void {
    this.selected = new Set();
    for (const kind of VERTEX_KIND_NAMES) {
      for (const vertex of this.doc.vertices[kind]) this.selected.add(selKey({ kind, name: vertex.name }));
    }
    this.paintSelection();
  }

  /** Shift+click semantics: add if absent, remove if present. */
  private toggleSelected(target: Selection): void {
    const key = selKey(target);
    if (this.selected.delete(key)) {
      if (this.selection && selKey(this.selection) === key) {
        const next = [...this.selected][this.selected.size - 1];
        this.selection = next ? this.parseSelKey(next) : null;
      }
    } else {
      this.selected.add(key);
      this.selection = target;
    }
    this.renderSide();
    this.paintSelection();
  }

  private applyTransform(): void {
    this.canvas.style.transform = `translate(${this.pan.x}px, ${this.pan.y}px) scale(${this.scale})`;
  }

  private layout(): Layout {
    if (!this.doc.layout) this.doc.layout = {};
    return this.doc.layout;
  }

  private positionOf(kind: VertexKindName, name: string): { x: number; y: number } {
    return this.layout()[layoutKey(kind, name)] ?? { x: 40, y: 40 };
  }

  private applyAutoLayout(): void {
    this.doc = structuredClone(this.doc);
    this.doc.layout = autoLayout(this.doc);
    this.commit("auto layout");
  }

  private renderGraph(): void {
    this.canvas.replaceChildren(this.edgeLayer, this.marquee);

    for (const kind of VERTEX_KIND_NAMES) {
      for (const vertex of this.doc.vertices[kind]) {
        this.canvas.append(this.nodeEl(kind, vertex.name));
      }
    }
    for (const note of this.doc.notes ?? []) this.canvas.append(this.noteEl(note));
    this.canvas.append(...TABLE_NAMES.map((name) => this.tableNodeEl(name)));
    this.renderEdges();
    this.applyTransform();
  }

  /**
   * The inner rows a node shows, in order. The row index drives BOTH the DOM
   * and the port geometry below, which is why it is computed here rather than
   * measured from the DOM — a measured layout would make edge positions depend
   * on paint timing.
   */
  private rowsOf(kind: VertexKindName, name: string): NodeRow[] {
    if (kind === "tool") {
      const rows: NodeRow[] = [];
      this.doc.edges.process.forEach((edge, index) => {
        if (edge.from === name) rows.push({ type: "process", processIndex: index });
      });
      rows.push({ type: "add-process" });
      return rows;
    }
    // A composite always shows both slots, filled or not, so the shape of the
    // assembly is visible before anything is wired into it.
    if (kind === "composite") return [{ type: "base" }, { type: "topping" }];
    return [];
  }

  private nodeHeight(kind: VertexKindName, name: string): number {
    return NODE_HEAD_H + this.rowsOf(kind, name).length * NODE_ROW_H;
  }

  /**
   * Canvas-space position of one port.
   *
   * INPUTS sit on the LEFT edge and OUTPUTS on the RIGHT, always — so every
   * edge leaves a right edge and arrives at a left one, and the picture reads
   * as flow. That holds even where the stored direction is the other way
   * round: a `base` edge is stored composite -> ingredient, but the ingredient
   * is what FEEDS the assembly, so it is drawn ingredient-out -> composite-in.
   * See renderEdges().
   */
  private portPoint(ref: PortRef): { x: number; y: number } {
    const pos = this.positionOf(ref.kind, ref.name);
    const x = ref.side === "in" ? pos.x : pos.x + NODE_W;
    if (!ref.row) return { x, y: pos.y + NODE_HEAD_H / 2 };
    const rows = this.rowsOf(ref.kind, ref.name);
    const index = rows.findIndex((row) => sameRow(row, ref.row!));
    const at = index === -1 ? 0 : index;
    return { x, y: pos.y + NODE_HEAD_H + at * NODE_ROW_H + NODE_ROW_H / 2 };
  }

  private nodeEl(kind: VertexKindName, name: string): HTMLElement {
    const def = vertexKind(kind);
    const pos = this.positionOf(kind, name);
    const selected = this.selected.has(selKey({ kind, name }));
    const primary = this.selection?.kind === kind && this.selection.name === name;
    const vertex = this.doc.vertices[kind].find((v) => v.name === name) as
      | { name: string; displayName?: string; orderable?: boolean; usageNum?: number }
      | undefined;

    const node = el("div", {
      class: `nodegraph-node kind-${kind}${selected ? " selected" : ""}${primary ? " primary" : ""}`,
      "data-kind": kind,
      "data-name": name,
    });
    node.style.left = `${pos.x}px`;
    node.style.top = `${pos.y}px`;
    node.style.width = `${NODE_W}px`;
    node.style.minHeight = `${this.nodeHeight(kind, name)}px`;
    if (def?.color) node.style.setProperty("--node-color", def.color);

    node.append(
      el("div", { class: "np-head" }, [
        // The artwork sits in a fixed SQUARE box rather than flowing at its
        // natural size: source images vary in aspect ratio, and without a fixed
        // frame a tall one pushes the label around and the header height stops
        // matching NODE_HEAD_H \u2014 which is what the port geometry is computed
        // from. A square keeps every node's header identical.
        el("span", { class: "nodegraph-node-icon" }, [this.iconFor(kind, name)]),
        el("span", { class: "nodegraph-node-label" }, [
          el("strong", {}, [vertex?.displayName || name]),
          el("small", {}, [`${def?.label ?? kind} \u00b7 ${name}`]),
        ]),
      ]),
    );

    // An orderable is where a customer order STARTS, so it is worth spotting
    // from across the canvas rather than by opening the inspector.
    if (kind === "composite" && vertex?.orderable) {
      node.append(
        el("span", { class: "np-orderable", title: "Orderable \u2014 a customer may order this" }, ["\ud83c\udf74"]),
      );
    }

    // usageNum > 1 means ONE landed piece fills several dish slots \u2014 it changes
    // how much a pickup is worth and disables direct-serve, so it belongs on the
    // node rather than three clicks away in the inspector. 1 is the default and
    // would be noise on every node.
    if (kind === "ingredient" && (vertex?.usageNum ?? 1) > 1) {
      node.append(
        el(
          "span",
          {
            class: "np-usage",
            title: `Fills ${vertex?.usageNum} dish slots per landed piece`,
          },
          [String(vertex?.usageNum)],
        ),
      );
    }

    node.append(
      this.portEl({ kind, name, side: "in" }, "Incoming"),
      this.portEl({ kind, name, side: "out" }, "Drag to wire"),
    );

    const rows = this.rowsOf(kind, name);
    if (rows.length > 0) {
      const rowsEl = el("div", { class: "np-rows" });
      for (const row of rows) rowsEl.append(this.rowEl(kind, name, row));
      node.append(rowsEl);
    }

    node.addEventListener("pointerdown", (e) => {
      // Right-press is the viewport's pan gesture, captured before this fires;
      // let it through untouched.
      if (e.button !== BUTTON_LEFT) return;
      e.stopPropagation();
      const target = e.target as HTMLElement;
      if (target.closest(".np-port") || target.closest("button")) return; // their own handlers own this
      if (e.shiftKey) {
        this.toggleSelected({ kind, name });
        return;
      }
      this.beginDrag({ kind, name }, node, e);
    });
    return node;
  }

  // ---------- the mapping tables ----------
  //
  // Two nodes that are not vertices and hold no data of their own: they render
  // what is ALREADY TRUE of the graph. The Pickupable node lists every
  // ingredient flagged `pickupable`; the Orderable node lists every composite
  // flagged `orderable`. A wire is drawn to (or from) each one automatically.
  //
  // Derived, not authored, and therefore read-only. An earlier version let a
  // designer add, remove and reorder rows here, which made the same fact
  // editable in two places — the vertex's own flag and the table's membership —
  // and the two could disagree with nothing to say which was right. The flag in
  // the node inspector is now the single switch; toggling it re-renders, and
  // the wire appears or vanishes to match.
  //
  // The NUMBERING those nodes used to own lives in the Id Table panel instead,
  // where a row's position is its id and reordering is an explicit, confirmed
  // renumber. Membership and numbering are different questions, and they now
  // have different homes.
  //
  // Permanent by construction rather than by a guard: they are drawn outside
  // the vertex loops, so no code path can delete them and none has to refuse
  // to. Their positions live in `layout` under a `table:` prefix, which no
  // vertex key can collide with (a vertex key is "kind:name", and `table` is
  // not a vertex kind).

  private tableKey(which: TableName): string {
    return `table:${which}`;
  }

  private tablePos(which: TableName): { x: number; y: number } {
    const stored = this.layout()[this.tableKey(which)];
    if (stored) return stored;
    // First open: park them clear to the RIGHT of every vertex. Not at negative
    // x — the canvas starts unpanned at the origin, and a table off the left
    // edge would be invisible until the designer thought to pan for it.
    let right = 0;
    for (const kind of VERTEX_KIND_NAMES) {
      for (const vertex of this.doc.vertices[kind]) {
        right = Math.max(right, this.positionOf(kind, vertex.name).x + NODE_W);
      }
    }
    return { x: right + 120, y: which === "pickupable" ? 40 : 40 + 26 * NODE_ROW_H };
  }

  /**
   * The rows of a mapping table: every vertex currently carrying the flag,
   * in ID ORDER so the row a level string means is where you would look for it.
   *
   * A flagged vertex with no id still gets a row — with the id shown as "—".
   * Hiding it would make a real problem (something pickupable that level data
   * cannot name) invisible on the canvas; `WARN-UNTABLED-NODE` says the same
   * thing in the issues list.
   */
  private tableRows(which: TableName): { id: number | null; node: string }[] {
    const ids = buildIdIndex(this.doc.idTable);
    const space: IdSpace = which === "pickupable" ? "ingredient" : "composite";
    const flagged =
      which === "pickupable"
        ? this.doc.vertices.ingredient.filter((v) => v.pickupable).map((v) => v.name)
        : this.doc.vertices.composite.filter((v) => v.orderable).map((v) => v.name);

    return flagged
      .map((node) => ({ id: ids.byNode[space].get(node) ?? null, node }))
      .sort((a, b) => (a.id ?? Infinity) - (b.id ?? Infinity) || a.node.localeCompare(b.node));
  }

  private tableNodeEl(which: TableName): HTMLElement {
    const pos = this.tablePos(which);
    const rows = this.tableRows(which);
    const node = el("div", {
      class: `nodegraph-node nodegraph-table kind-table-${which}`,
      "data-table": which,
      title:
        which === "pickupable"
          ? "Every ingredient flagged pickupable. Read-only — toggle the flag on the ingredient itself."
          : "Every composite flagged orderable. Read-only — toggle the flag on the composite itself.",
    });
    node.style.left = `${pos.x}px`;
    node.style.top = `${pos.y}px`;
    node.style.width = `${NODE_W}px`;

    node.append(
      el("div", { class: "np-head" }, [
        el("span", { class: "nodegraph-node-icon" }, [
          el("span", { class: "icon" }, [which === "pickupable" ? "\u{1F4E5}" : "\u{1F37D}"]),
        ]),
        el("span", { class: "nodegraph-node-label" }, [
          el("strong", {}, [which === "pickupable" ? "Pickupable" : "Orderable"]),
          el("small", {}, [which === "pickupable" ? "queue id \u2192 ingredient" : "dish id \u2192 orderable"]),
        ]),
      ]),
    );

    const list = el("div", { class: "np-rows np-table-rows" });
    for (const entry of rows) {
      const side: "in" | "out" = which === "pickupable" ? "out" : "in";
      // A port dot, but purely a wire ANCHOR: no pointerdown handler, because
      // the membership it marks is not something a drag can change.
      const port = el("span", {
        class: `np-port np-${side} np-row-port np-port-static`,
        "data-table": which,
        "data-table-id": String(entry.id ?? -1),
        "data-side": side,
      });
      const label = el("span", { class: "np-row-label" }, [entry.id === null ? "\u2014" : String(entry.id)]);
      const value = el("span", { class: "np-row-value" }, [entry.node]);
      const row = el(
        "div",
        {
          class: `np-row np-table-row${entry.id === null ? " np-table-untabled" : ""}`,
          ...(entry.id === null
            ? { title: `"${entry.node}" has no id-table entry, so no level string can name it` }
            : {}),
        },
        which === "pickupable" ? [label, value, port] : [port, label, value],
      );
      list.append(row);
    }
    if (rows.length === 0) {
      list.append(
        el("div", { class: "np-row np-table-empty" }, [
          el("small", { class: "muted" }, [
            which === "pickupable" ? "No ingredient is pickupable yet." : "No composite is orderable yet.",
          ]),
        ]),
      );
    }
    node.append(list);

    node.addEventListener("pointerdown", (e) => {
      if (e.button !== BUTTON_LEFT) return;
      e.stopPropagation();
      this.beginTableDrag(which, node, e);
    });
    return node;
  }

  /** The tables move like nodes, but their position is the only thing a drag can change. */
  private beginTableDrag(which: TableName, node: HTMLElement, down: PointerEvent): void {
    const start = this.tablePos(which);
    let moved = false;
    const move = (e: PointerEvent) => {
      moved = true;
      const x = start.x + (e.clientX - down.clientX) / this.scale;
      const y = start.y + (e.clientY - down.clientY) / this.scale;
      node.style.left = `${x}px`;
      node.style.top = `${y}px`;
      this.layout()[this.tableKey(which)] = { x, y };
      this.renderEdges();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (moved) {
        this.doc = structuredClone(this.doc);
        this.commit(`move ${which} table`);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  /** Canvas-space point of one table row's port, found by the row's position in the list. */
  private tablePortPoint(which: TableName, node: string): { x: number; y: number } {
    const pos = this.tablePos(which);
    const at = this.tableRows(which).findIndex((r) => r.node === node);
    const y = pos.y + NODE_HEAD_H + Math.max(0, at) * NODE_ROW_H + NODE_ROW_H / 2;
    return { x: which === "pickupable" ? pos.x + NODE_W : pos.x, y };
  }

  /** One port dot. An output port starts a wire; an input port is a drop target. */
  private portEl(ref: PortRef, title: string): HTMLElement {
    const dot = el("span", {
      class: `np-port np-${ref.side}${ref.row ? " np-row-port" : ""}`,
      title,
      "data-side": ref.side,
      "data-kind": ref.kind,
      "data-name": ref.name,
      ...(ref.row ? { "data-row": rowKey(ref.row) } : {}),
    });
    if (ref.side === "out") {
      dot.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        this.beginWire(ref);
      });
    }
    return dot;
  }

  /**
   * One inner row. A tool's rows ARE its recipes — consumed ingredients on the
   * left, produced one on the right — so a recipe is built by wiring rather
   * than by typing names into a text field.
   */
  private rowEl(kind: VertexKindName, name: string, row: NodeRow): HTMLElement {
    if (row.type === "add-process") {
      return el("div", { class: "np-row np-row-add" }, [
        button("\uff0b process", () => this.addProcessRow(name), {
          title: "Add an empty recipe, then wire its input and output",
        }),
      ]);
    }

    if (row.type === "base" || row.type === "topping") {
      const edges = row.type === "base" ? this.doc.edges.base : this.doc.edges.topping;
      const edge = edges.find((e) => e.from === name);
      const wrap = el("div", { class: `np-row np-row-${row.type}` }, [
        this.portEl(
          { kind, name, side: "in", row },
          `Wire an ingredient, group or composite in as the ${row.type}`,
        ),
        el("span", { class: "np-row-label" }, [row.type]),
        el("span", { class: "np-row-value" }, [edge?.to ?? "\u2014"]),
      ]);
      if (edge) {
        wrap.append(
          button("\u2715", () => this.removeEdge(row.type === "base" ? "base" : "topping", name, edge.to), {
            class: "np-row-x",
            title: "Unwire",
          }),
        );
      }
      return wrap;
    }

    const edge = this.doc.edges.process[row.processIndex];
    return el("div", { class: "np-row np-row-process" }, [
      this.portEl({ kind, name, side: "in", row }, "Wire an ingredient in as this recipe's input"),
      el("span", { class: "np-row-label" }, [edge?.inputs.join(" + ") || "(no input)"]),
      el("span", { class: "np-row-arrow" }, ["\u2192"]),
      el("span", { class: "np-row-value" }, [edge?.to || "(no output)"]),
      button("\u2715", () => this.removeProcessRow(row.processIndex), {
        class: "np-row-x",
        title: "Remove this recipe",
      }),
      this.portEl({ kind, name, side: "out", row }, "Wire this recipe's output to an ingredient"),
    ]);
  }

  private renderEdges(): void {
    const svgNs = "http://www.w3.org/2000/svg";
    while (this.edgeLayer.firstChild) this.edgeLayer.removeChild(this.edgeLayer.firstChild);

    let maxX = 600;
    let maxY = 400;
    for (const kind of VERTEX_KIND_NAMES) {
      for (const vertex of this.doc.vertices[kind]) {
        const p = this.positionOf(kind, vertex.name);
        maxX = Math.max(maxX, p.x + NODE_W + 80);
        maxY = Math.max(maxY, p.y + this.nodeHeight(kind, vertex.name) + 80);
      }
    }
    // The mapping tables are the tallest things on the canvas — one row per id —
    // so leaving them out of the bounds would clip them and the wires into them.
    for (const which of TABLE_NAMES) {
      const p = this.tablePos(which);
      maxX = Math.max(maxX, p.x + NODE_W + 80);
      maxY = Math.max(maxY, p.y + NODE_HEAD_H + this.tableRows(which).length * NODE_ROW_H + 80);
    }
    this.canvas.style.width = `${maxX}px`;
    this.canvas.style.height = `${maxY}px`;
    this.edgeLayer.setAttribute("width", String(maxX));
    this.edgeLayer.setAttribute("height", String(maxY));

    const kindOf = new Map<string, VertexKindName>();
    for (const kind of VERTEX_KIND_NAMES) {
      for (const v of this.doc.vertices[kind]) kindOf.set(v.name, kind);
    }

    const draw = (from: PortRef, to: PortRef, kind: EdgeKindName, dataFrom: string, dataTo: string) => {
      const a = this.portPoint(from);
      const b = this.portPoint(to);
      const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
      const path = document.createElementNS(svgNs, "path");
      path.setAttribute("d", `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`);
      path.setAttribute("class", `nodegraph-edge edge-${kind}`);
      const def = edgeKind(kind);
      if (def?.style === "dashed") path.setAttribute("stroke-dasharray", "6 4");
      if (def?.style === "dotted") path.setAttribute("stroke-dasharray", "2 4");
      path.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.edgeMenu(kind, dataFrom, dataTo, e as MouseEvent);
      });
      this.edgeLayer.append(path);
    };

    // process: the tool's recipe ROW is both endpoint. Inputs arrive at the
    // row's left port; the output leaves its right port.
    this.doc.edges.process.forEach((edge, index) => {
      if (kindOf.get(edge.from) !== "tool") return;
      const row: NodeRow = { type: "process", processIndex: index };
      for (const input of edge.inputs) {
        if (!kindOf.has(input)) continue;
        draw(
          { kind: "ingredient", name: input, side: "out" },
          { kind: "tool", name: edge.from, side: "in", row },
          "process",
          edge.from,
          edge.to,
        );
      }
      if (kindOf.has(edge.to)) {
        draw(
          { kind: "tool", name: edge.from, side: "out", row },
          { kind: "ingredient", name: edge.to, side: "in" },
          "process",
          edge.from,
          edge.to,
        );
      }
    });

    // base / topping: stored composite -> member, DRAWN member -> composite,
    // because the member is what feeds the assembly.
    for (const rowType of ["base", "topping"] as const) {
      for (const edge of this.doc.edges[rowType]) {
        const memberKind = kindOf.get(edge.to);
        if (!memberKind || !kindOf.has(edge.from)) continue;
        draw(
          { kind: memberKind, name: edge.to, side: "out" },
          { kind: "composite", name: edge.from, side: "in", row: { type: rowType } },
          rowType,
          edge.from,
          edge.to,
        );
      }
    }

    // option: stored group -> member, drawn member -> group, same reason.
    for (const edge of this.doc.edges.option) {
      const memberKind = kindOf.get(edge.to);
      if (!memberKind || !kindOf.has(edge.from)) continue;
      draw(
        { kind: memberKind, name: edge.to, side: "out" },
        { kind: "group", name: edge.from, side: "in" },
        "option",
        edge.from,
        edge.to,
      );
    }

    // leavesDirty is the one assembly edge whose stored direction already
    // matches the flow: the composite produces the dirty object.
    for (const edge of this.doc.edges.leavesDirty) {
      if (!kindOf.has(edge.from) || !kindOf.has(edge.to)) continue;
      draw(
        { kind: "composite", name: edge.from, side: "out" },
        { kind: "dirty", name: edge.to, side: "in" },
        "leavesDirty",
        edge.from,
        edge.to,
      );
    }

    this.renderTableWires(svgNs, kindOf);
  }

  /**
   * The lookup wires: one per live table row, table row ↔ the node it names.
   *
   * Drawn in their own pass and their own class because they are NOT graph
   * edges — nothing in the runtime traverses them. They show the id
   * indirection, which is a different kind of fact from "this tool cooks that
   * ingredient", and styling them the same would invite reading them as flow.
   */
  private renderTableWires(svgNs: string, kindOf: Map<string, VertexKindName>): void {
    for (const which of TABLE_NAMES) {
      for (const entry of this.tableRows(which)) {
        const kind = kindOf.get(entry.node);
        if (!kind) continue; // the vertex vanished mid-edit; don't draw a wire to nowhere

        const port = this.tablePortPoint(which, entry.node);
        const nodeSide = this.portPoint({
          kind,
          name: entry.node,
          side: which === "pickupable" ? "in" : "out",
        });
        const [a, b] = which === "pickupable" ? [port, nodeSide] : [nodeSide, port];
        const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
        const path = document.createElementNS(svgNs, "path");
        path.setAttribute("d", `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`);
        path.setAttribute("class", `nodegraph-edge edge-lookup edge-lookup-${which}`);
        this.edgeLayer.append(path);
      }
    }
  }

  private iconFor(kind: VertexKindName, name: string): HTMLElement {
    // Icons resolve through the shell's ambient node icon source, which is
    // keyed by DATA ID — so a vertex with no id table entry yet simply falls
    // back to its emoji, which is the honest thing to show.
    const id = this.doc.idTable[SPACE_OF[kind]]?.findIndex((e) => e?.node === name) ?? -1;
    if (kind === "tool") {
      const vertex = this.doc.vertices.tool.find((v) => v.name === name);
      return toolIconEl(
        {
          id,
          name: vertex?.displayName ?? name,
          icon: vertex?.emoji ?? "🍳",
          fileId: vertex?.fileId,
          localImage: vertex?.localImage,
          numSlots: vertex?.numSlots ?? 1,
          cookingTime: vertex?.cookingTime ?? 1,
          recipes: [],
        },
        28,
      );
    }
    if (kind === "dirty") return dirtyIconEl(id, 28);
    if (kind === "ingredient") return cookedIconEl(id, 28);
    return el("span", { class: "icon" }, [kind === "group" ? "🧩" : "🍔"]);
  }

  private addProcessRow(tool: string): void {
    this.doc = structuredClone(this.doc);
    // An empty recipe is intentionally allowed to exist: it is the thing the
    // designer then wires an input and an output into. Validation reports it
    // until both ends are connected.
    this.doc.edges.process.push({ from: tool, to: "", inputs: [], amount: 1 });
    this.commit(`add recipe to ${tool}`, 1);
  }

  private removeProcessRow(index: number): void {
    this.doc = structuredClone(this.doc);
    this.doc.edges.process.splice(index, 1);
    this.commit("remove recipe", 0, 1);
  }

  // ---------- gestures ----------

  /**
   * Node drag: ONE history entry, pushed on pointerup, not per pointermove.
   *
   * Dragging a node that is part of a multi-selection moves the WHOLE
   * selection, which is the only reason to have multi-select at all. Pressing
   * an unselected node replaces the selection with it first — matching every
   * other canvas editor, where grabbing something you had not selected does not
   * silently carry your old selection along with it.
   */
  // `node` is no longer read: the drag moves every selected element, so each
  // one is looked up by data attribute rather than the pressed element being
  // special. Kept in the signature so the call site still reads as "drag THIS".
  private beginDrag(target: Selection, _node: HTMLElement, down: PointerEvent): void {
    if (!this.selected.has(selKey(target))) {
      this.selected = new Set([selKey(target)]);
    }
    this.selection = target;
    this.renderSide();
    this.paintSelection();

    // Snapshot every moving node's start position up front: reading positions
    // during the drag would compound rounding, and each move must be an
    // absolute offset from where the gesture began.
    const moving = [...this.selected].map((key) => {
      const sel = this.parseSelKey(key);
      return { sel, start: { ...this.positionOf(sel.kind, sel.name) } };
    });
    const originX = down.clientX;
    const originY = down.clientY;
    let moved = false;

    const move = (e: PointerEvent) => {
      const dx = (e.clientX - originX) / this.scale;
      const dy = (e.clientY - originY) / this.scale;
      moved = true;
      for (const { sel, start } of moving) {
        const x = start.x + dx;
        const y = start.y + dy;
        this.layout()[layoutKey(sel.kind, sel.name)] = { x, y };
        const elm = this.canvas.querySelector<HTMLElement>(
          `.nodegraph-node[data-kind="${sel.kind}"][data-name="${CSS.escape(sel.name)}"]`,
        );
        if (elm) {
          elm.style.left = `${x}px`;
          elm.style.top = `${y}px`;
        }
      }
      this.renderEdges();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (moved) {
        this.doc = structuredClone(this.doc);
        this.commit(moving.length > 1 ? `move ${moving.length} nodes` : `move ${target.name}`);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  /**
   * Wire drag: a rubber-band line from an OUTPUT port, dropped on an INPUT
   * port. Rejected wires push NO history entry.
   */
  private beginWire(from: PortRef): void {
    const svgNs = "http://www.w3.org/2000/svg";
    const line = document.createElementNS(svgNs, "line");
    line.setAttribute("class", "nodegraph-wire");
    const a = this.portPoint(from);
    line.setAttribute("x1", String(a.x));
    line.setAttribute("y1", String(a.y));
    line.setAttribute("x2", String(a.x));
    line.setAttribute("y2", String(a.y));
    this.edgeLayer.append(line);
    this.canvas.classList.add("wiring");

    const rect = this.canvas.getBoundingClientRect();
    const move = (e: PointerEvent) => {
      line.setAttribute("x2", String((e.clientX - rect.left) / this.scale));
      line.setAttribute("y2", String((e.clientY - rect.top) / this.scale));
    };
    const up = (e: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      line.remove();
      this.canvas.classList.remove("wiring");

      // A drop lands on an input PORT when the designer is precise, or anywhere
      // on the node when they are not — both mean "into this node".
      const element = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const port = element?.closest<HTMLElement>(".np-port.np-in");
      const node = element?.closest<HTMLElement>(".nodegraph-node");
      if (!port && !node) return;

      // The mapping tables are derived views: their membership follows the
      // `pickupable` / `orderable` flags, so a wire cannot be dropped onto one.
      if (element?.closest("[data-table]")) return;

      const to: PortRef = port
        ? {
            kind: port.dataset.kind as VertexKindName,
            name: port.dataset.name!,
            side: "in",
            row: parseRowKey(port.dataset.row),
          }
        : { kind: node!.dataset.kind as VertexKindName, name: node!.dataset.name!, side: "in" };
      this.completeWire(from, to, e);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  /**
   * Turns a dropped wire into a graph edit.
   *
   * The row on either end is what disambiguates: dropping into a tool's recipe
   * row edits THAT recipe's inputs, dragging out of one sets THAT recipe's
   * output, and dropping into a composite's base row makes a base edge rather
   * than a topping. Without rows this would need a menu on every drop.
   */
  private completeWire(from: PortRef, to: PortRef, e: PointerEvent): void {
    if (from.name === to.name && rowKey(from.row ?? { type: "base" }) === rowKey(to.row ?? { type: "base" })) {
      return;
    }

    // --- a recipe's input: ingredient out -> tool's process row in
    if (to.kind === "tool" && to.row?.type === "process") {
      if (from.kind !== "ingredient") {
        this.flashStatus("A recipe consumes ingredients — wire an ingredient in");
        return;
      }
      const edge = this.doc.edges.process[to.row.processIndex];
      if (!edge) return;
      if (edge.inputs.includes(from.name)) {
        this.flashStatus(`"${from.name}" is already an input of that recipe`);
        return;
      }
      this.doc = structuredClone(this.doc);
      this.doc.edges.process[to.row.processIndex].inputs.push(from.name);
      this.commit(`${from.name} → ${to.name} recipe`, 1);
      return;
    }

    // --- a recipe's output: tool's process row out -> ingredient in
    if (from.kind === "tool" && from.row?.type === "process") {
      const processIndex = from.row.processIndex;
      if (to.kind !== "ingredient") {
        this.flashStatus("A recipe produces an ingredient — wire it to one");
        return;
      }
      // INV-UNIQUE-PRODUCER, enforced at the gesture: exactly one recipe may
      // produce any ingredient, or a backward trace stops being deterministic.
      const producedElsewhere = this.doc.edges.process.some(
        (edge, index) => index !== processIndex && edge.to === to.name,
      );
      if (producedElsewhere) {
        this.flashStatus(`"${to.name}" already has a producer — remove that recipe first`);
        return;
      }
      this.doc = structuredClone(this.doc);
      this.doc.edges.process[processIndex].to = to.name;
      this.commit(`recipe → ${to.name}`);
      return;
    }

    // --- a composite slot: member out -> composite's base/topping row in
    if (to.kind === "composite" && (to.row?.type === "base" || to.row?.type === "topping")) {
      const kind: EdgeKindName = to.row.type;
      if (!edgeAllowed(kind, "composite", from.kind)) {
        this.flashStatus(`A ${from.kind} cannot be a composite's ${kind}`);
        return;
      }
      // Stored composite -> member, even though it was drawn the other way.
      this.addEdge(kind, to.name, from.name);
      return;
    }

    // --- a group option: member out -> group in
    if (to.kind === "group") {
      if (!edgeAllowed("option", "group", from.kind)) {
        this.flashStatus(`A ${from.kind} cannot be a group option`);
        return;
      }
      this.addEdge("option", to.name, from.name);
      return;
    }

    // --- everything else keeps the stored direction (composite -> dirty).
    const legal = EDGE_KIND_NAMES.filter((kind) => edgeAllowed(kind, from.kind, to.kind));
    if (legal.length === 0) {
      this.flashStatus(`No edge may run from a ${from.kind} to a ${to.kind}`);
      return;
    }
    if (legal.length === 1) {
      this.addEdge(legal[0], from.name, to.name);
      return;
    }
    showContextMenu(
      e as unknown as MouseEvent,
      legal.map((kind) => ({
        label: edgeKind(kind)?.label ?? kind,
        onSelect: () => this.addEdge(kind, from.name, to.name),
      })),
      { title: `${from.name} → ${to.name}` },
    );
  }

  private addEdge(kind: EdgeKindName, from: string, to: string): void {
    const def = edgeKind(kind);
    const list = this.doc.edges[kind] as { from: string; to: string }[];
    if (list.some((edge) => edge.from === from && edge.to === to)) {
      this.flashStatus("That edge already exists");
      return;
    }
    if (def?.maxIncomingPerTarget !== undefined) {
      const incoming = list.filter((edge) => edge.to === to).length;
      if (incoming >= def.maxIncomingPerTarget) {
        this.flashStatus(`"${to}" already has its one ${def.label.toLowerCase()} — remove it first`);
        return;
      }
    }
    if (def?.maxOutgoingPerSource !== undefined) {
      const outgoing = list.filter((edge) => edge.from === from).length;
      if (outgoing >= def.maxOutgoingPerSource) {
        this.flashStatus(`"${from}" already has its one ${def.label.toLowerCase()}`);
        return;
      }
    }

    this.doc = structuredClone(this.doc);
    const fresh: Record<string, unknown> = { from, to };
    for (const field of edgeKind(kind)?.fields ?? []) {
      if (field.default !== undefined) fresh[field.name] = field.default;
    }
    // A process edge without inputs/amount is not a recipe the sim can read.
    if (kind === "process") {
      fresh.inputs = fresh.inputs ?? [];
      fresh.amount = fresh.amount ?? 1;
    }
    (this.doc.edges[kind] as unknown as Record<string, unknown>[]).push(fresh);
    this.commit(`wire ${kind} ${from} → ${to}`, 1);
  }

  private removeEdge(kind: EdgeKindName, from: string, to: string): void {
    this.doc = structuredClone(this.doc);
    const list = this.doc.edges[kind] as { from: string; to: string }[];
    const at = list.findIndex((edge) => edge.from === from && edge.to === to);
    if (at === -1) return;
    list.splice(at, 1);
    this.commit(`unwire ${kind} ${from} → ${to}`, 0, 1);
  }

  private edgeMenu(kind: EdgeKindName, from: string, to: string, e: MouseEvent): void {
    showContextMenu(
      e,
      [{ label: "✕ Remove edge", danger: true, onSelect: () => this.removeEdge(kind, from, to) }],
      { title: `${edgeKind(kind)?.label ?? kind}: ${from} → ${to}` },
    );
  }

  // ---------- create / delete ----------

  private addNodeMenu(e: MouseEvent): void {
    showContextMenu(
      e,
      NODE_GRAPH_SCHEMA.vertexKinds.map((k) => ({
        label: `＋ ${k.label}`,
        onSelect: () => this.addVertex(k.kind),
      })),
      { title: "Add node" },
    );
  }

  private addVertex(kind: VertexKindName): void {
    const base = `new-${kind}`;
    let name = base;
    let n = 1;
    while (this.doc.vertices[kind].some((v) => v.name === name)) name = `${base}-${++n}`;

    this.doc = structuredClone(this.doc);
    const fresh: Record<string, unknown> = { name, displayName: name };
    for (const field of vertexFields(kind)) {
      if (field.default !== undefined && fresh[field.name] === undefined) fresh[field.name] = field.default;
    }
    // Required numeric fields with no declared default would otherwise land as
    // undefined and read as NaN in the sim.
    if (kind === "tool") {
      fresh.numSlots = fresh.numSlots ?? 1;
      fresh.cookingTime = fresh.cookingTime ?? 1;
    }
    (this.doc.vertices[kind] as unknown as Record<string, unknown>[]).push(fresh);

    // Mint in the SAME entry as the vertex creation, so one undo never leaves
    // the id table and the graph disagreeing.
    if (this.needsId(kind, fresh)) mintId(this.doc.idTable, SPACE_OF[kind], name);

    this.layout()[layoutKey(kind, name)] = {
      x: 40 - this.pan.x / this.scale + 40,
      y: 40 - this.pan.y / this.scale + 40,
    };
    this.selection = { kind, name };
    this.selected = new Set([selKey(this.selection)]);
    this.commit(`add ${kind} ${name}`, 1);
  }

  /** Only vertices a level string can reference need an id. */
  /**
   * Only nodes a level string can NAME need an id.
   *
   * An ingredient earns one by being servable or pickupable; a composite by
   * being orderable — those flags are exactly what makes a node reachable from
   * queue and dish strings. Everything else (groups, tools, dirty objects) is
   * referenced structurally and always gets one.
   */
  private needsId(kind: VertexKindName, vertex: Record<string, unknown>): boolean {
    if (kind === "ingredient") return Boolean(vertex.servable || vertex.pickupable);
    if (kind === "composite") return Boolean(vertex.orderable);
    return true;
  }

  private deleteVertex(target: Selection): void {
    const usedBy = this.levelsReferencing(target);
    const warning =
      usedBy.length > 0
        ? `"${target.name}" is still referenced by ${usedBy.length} level(s): ${usedBy.slice(0, 5).join(", ")}${usedBy.length > 5 ? "…" : ""}.\n\nDeleting it tombstones its id, so those levels will fail validation until you fix them.\n\nDelete anyway?`
        : `Delete "${target.name}" and every edge touching it?`;
    if (!confirm(warning)) return;

    this.doc = structuredClone(this.doc);
    const list = this.doc.vertices[target.kind] as { name: string }[];
    const at = list.findIndex((v) => v.name === target.name);
    if (at === -1) return;
    list.splice(at, 1);

    // Cascade: a vertex and its edges leave together, in ONE undo entry. A
    // per-section stack would let undo resurrect one without the other.
    let removed = 1;
    for (const kind of EDGE_KIND_NAMES) {
      const edges = this.doc.edges[kind] as { from: string; to: string; inputs?: string[] }[];
      const before = edges.length;
      this.doc.edges[kind] = edges.filter(
        (edge) => edge.from !== target.name && edge.to !== target.name,
      ) as never;
      removed += before - (this.doc.edges[kind] as unknown[]).length;
    }
    // A process edge may also NAME it as an input.
    for (const edge of this.doc.edges.process) {
      edge.inputs = edge.inputs.filter((input) => input !== target.name);
    }

    retireId(this.doc.idTable, SPACE_OF[target.kind], target.name);
    delete this.layout()[layoutKey(target.kind, target.name)];
    this.selection = null;
    this.selected.delete(selKey(target));
    this.commit(`delete ${target.kind} ${target.name}`, 0, removed);
  }

  /** Level names whose strings still resolve through this vertex's id. */
  private levelsReferencing(target: Selection): string[] {
    const id = this.doc.idTable[SPACE_OF[target.kind]]?.findIndex((e) => e?.node === target.name) ?? -1;
    if (id === -1) return [];
    return this.levelsUsingId(SPACE_OF[target.kind], id);
  }

  /**
   * Level names whose strings index into `id` of `space`.
   *
   * Deliberately over-inclusive for the ingredient space: a bare number in a
   * queue or dish string has no marker saying which space it belongs to, so
   * this matches any standalone occurrence. Over-reporting inflates a warning;
   * under-reporting would let a renumber quietly break a level.
   */
  private levelsUsingId(space: IdSpace, id: number): string[] {
    const token = space === "composite" ? `{c${id}:` : space === "group" ? `{g${id}:` : null;
    const bare = new RegExp(`(^|[^0-9])${id}([^0-9]|$)`);
    const out: string[] = [];
    for (const level of this.project.levels) {
      if (token) {
        if (level.customerString.includes(token)) out.push(level.name);
        continue;
      }
      if (space !== "ingredient") continue; // tool/dirty ids appear in no level string
      if (bare.test(level.customerString) || bare.test(level.queueString)) out.push(level.name);
    }
    return out;
  }

  private nodeMenu(target: Selection, e: MouseEvent): void {
    // Right-clicking inside a multi-selection acts on the whole selection;
    // right-clicking outside it means "I mean this one", so the selection
    // collapses to it first.
    const inSelection = this.selected.has(selKey(target));
    if (!inSelection) this.select(target);
    const count = this.selected.size;
    const many = inSelection && count > 1;

    showContextMenu(
      e,
      [
        { label: "✎ Inspect", onSelect: () => this.select(target) },
        { label: "⧉ Duplicate", onSelect: () => this.duplicateVertex(target) },
        {
          label: many ? `✕ Delete ${count} nodes` : "✕ Delete",
          danger: true,
          separator: true,
          onSelect: () => (many ? this.deleteSelection() : this.deleteVertex(target)),
        },
      ],
      { title: many ? `${count} nodes selected` : target.name },
    );
  }

  /**
   * Delete every selected vertex as ONE undo entry.
   *
   * Not a loop over `deleteVertex` — that would prompt once per node and push
   * one history entry each, so a half-undone bulk delete would be reachable.
   */
  private deleteSelection(): void {
    const targets = [...this.selected].map((key) => this.parseSelKey(key));
    const used = targets.flatMap((t) => this.levelsReferencing(t));
    const unique = [...new Set(used)];
    const warning =
      unique.length > 0
        ? `${targets.length} node(s) are still referenced by ${unique.length} level(s): ${unique.slice(0, 5).join(", ")}${unique.length > 5 ? "…" : ""}.\n\nDeleting tombstones their ids, so those levels will fail validation until you fix them.\n\nDelete anyway?`
        : `Delete ${targets.length} nodes and every edge touching them?`;
    if (!confirm(warning)) return;

    this.doc = structuredClone(this.doc);
    const names = new Set(targets.map((t) => t.name));
    let removed = 0;

    for (const target of targets) {
      const list = this.doc.vertices[target.kind] as { name: string }[];
      const at = list.findIndex((v) => v.name === target.name);
      if (at === -1) continue;
      list.splice(at, 1);
      removed++;
      retireId(this.doc.idTable, SPACE_OF[target.kind], target.name);
      delete this.layout()[layoutKey(target.kind, target.name)];
    }

    for (const kind of EDGE_KIND_NAMES) {
      const edges = this.doc.edges[kind] as { from: string; to: string }[];
      const before = edges.length;
      this.doc.edges[kind] = edges.filter((e) => !names.has(e.from) && !names.has(e.to)) as never;
      removed += before - (this.doc.edges[kind] as unknown[]).length;
    }
    for (const edge of this.doc.edges.process) {
      edge.inputs = edge.inputs.filter((input) => !names.has(input));
    }

    this.selected.clear();
    this.selection = null;
    this.commit(`delete ${targets.length} nodes`, 0, removed);
  }

  private duplicateVertex(target: Selection): void {
    const source = this.doc.vertices[target.kind].find((v) => v.name === target.name);
    if (!source) return;
    let name = `${target.name}-copy`;
    let n = 1;
    while (this.doc.vertices[target.kind].some((v) => v.name === name)) name = `${target.name}-copy-${++n}`;

    this.doc = structuredClone(this.doc);
    const copy = { ...structuredClone(source), name } as Record<string, unknown>;
    (this.doc.vertices[target.kind] as unknown as Record<string, unknown>[]).push(copy);
    if (this.needsId(target.kind, copy)) mintId(this.doc.idTable, SPACE_OF[target.kind], name);
    const at = this.positionOf(target.kind, target.name);
    this.layout()[layoutKey(target.kind, name)] = { x: at.x + 24, y: at.y + 24 };
    this.selection = { kind: target.kind, name };
    this.selected = new Set([selKey(this.selection)]);
    this.commit(`duplicate ${target.name}`, 1);
  }

  private select(target: Selection): void {
    this.selection = target;
    this.selected = new Set([selKey(target)]);
    this.renderGraph();
    this.renderSide();
  }

  private vertexAt(target: Selection): Record<string, unknown> | undefined {
    return this.doc.vertices[target.kind].find((v) => v.name === target.name) as
      | Record<string, unknown>
      | undefined;
  }

  // ---------- side panel ----------

  private renderSide(): void {
    this.sidePanel.replaceChildren(
      this.inspectorPanel(),
      this.issuesPanel(),
      this.tracePanel(),
      this.idTablePanel(),
    );
  }

  private inspectorPanel(): HTMLElement {
    const body = el("div", { class: "nodegraph-panel-body" });
    if (!this.selection) {
      body.append(el("p", { class: "muted" }, ["Select a node to edit it."]));
      return this.panel("Inspector", body);
    }
    const target = this.selection;
    const vertex = this.vertexAt(target);
    if (!vertex) {
      body.append(el("p", { class: "muted" }, ["That node no longer exists."]));
      return this.panel("Inspector", body);
    }

    // Generated from schema.json's fields[] — there is no per-kind form.
    for (const field of vertexFields(target.kind)) {
      body.append(this.fieldRow(target, vertex, field));
    }

    // Artwork fields (emoji / localImage / fileId) resolve through the icon
    // layer's own load-and-fallback chain, which caches by URL. Editing a path
    // therefore does not repaint on its own — this button forces the redraw so
    // a designer can see whether the path they typed actually resolves.
    body.append(
      el("div", { class: "nodegraph-field nodegraph-field-wide" }, [
        button("🔄 Refresh visual", () => this.refreshVisual(target), {
          title: "Redraw this node's icon after changing its emoji, local image path or Drive file id",
        }),
      ]),
    );

    if (target.kind === "group") body.append(this.groupOptionsEditor(target.name));
    if (target.kind === "tool") body.append(this.recipeEditor(target.name));

    body.append(
      el("div", { class: "nodegraph-edge-list" }, [
        el("strong", {}, ["Edges"]),
        ...this.edgesTouching(target.name).map(({ kind, from, to }) =>
          el("div", { class: "nodegraph-edge-row" }, [
            el("span", {}, [`${edgeKind(kind)?.label ?? kind}: ${from} → ${to}`]),
            button("✕", () => this.removeEdge(kind, from, to), { title: "Remove this edge" }),
          ]),
        ),
      ]),
    );
    return this.panel("Inspector", body);
  }

  /** Redraws one node in place, so an artwork edit shows without a full re-render. */
  private refreshVisual(target: Selection): void {
    const existing = this.canvas.querySelector<HTMLElement>(
      `.nodegraph-node[data-kind="${target.kind}"][data-name="${CSS.escape(target.name)}"]`,
    );
    const fresh = this.nodeEl(target.kind, target.name);
    if (existing) existing.replaceWith(fresh);
    else this.canvas.append(fresh);
  }

  /**
   * Per-option caps for a group.
   *
   * The GROUP's own `maxQuantity` bounds how many picks it takes in total; each
   * OPTION's bounds how many of that one item. A toppings group capped at 3
   * whose cheese option is capped at 1 means "three toppings, at most one of
   * them cheese" — two different limits that the old SINGLE/MULTIPLE split
   * used to blur together.
   */
  private groupOptionsEditor(group: string): HTMLElement {
    const wrap = el("div", { class: "nodegraph-edge-list" }, [el("strong", {}, ["Option limits"])]);
    const options = this.doc.edges.option.filter((edge) => edge.from === group);
    if (options.length === 0) {
      wrap.append(el("small", { class: "muted" }, ["No options wired in yet."]));
      return wrap;
    }
    for (const edge of options) {
      const input = el("input", {
        type: "number",
        value: String(edge.maxQuantity ?? -1),
        title: "Max copies of THIS option in one dish; -1 = unlimited",
      }) as HTMLInputElement;
      input.addEventListener("change", () => {
        const next = Number(input.value);
        this.doc = structuredClone(this.doc);
        const target = this.doc.edges.option.find((o) => o.from === group && o.to === edge.to);
        if (target) target.maxQuantity = Number.isFinite(next) ? next : -1;
        this.commit(`limit ${edge.to} in ${group}`);
      });
      wrap.append(el("div", { class: "nodegraph-edge-row" }, [el("span", {}, [edge.to]), input]));
    }
    return wrap;
  }

  /** Amount / duration / chainTools for each of a tool's recipes; inputs and output are wired. */
  private recipeEditor(tool: string): HTMLElement {
    const wrap = el("div", { class: "nodegraph-edge-list" }, [el("strong", {}, ["Recipes"])]);
    const rows = this.doc.edges.process
      .map((edge, index) => ({ edge, index }))
      .filter(({ edge }) => edge.from === tool);
    if (rows.length === 0) {
      wrap.append(el("small", { class: "muted" }, ['Use "＋ process" on the node to add one.']));
      return wrap;
    }

    // Recipe order is not cosmetic: `advanceTools` walks a tool's processes in
    // graph order, so which recipe claims a free slot first is decided here.
    // That is why reordering is a real edit with a real undo entry, and why the
    // node's own rows have to follow — a designer must be able to see the order
    // they just set without opening the inspector to check.
    const list = el("div", { class: "nodegraph-recipe-list" });
    Sortable.create(list, {
      animation: 120,
      handle: ".nodegraph-recipe-grip",
      onEnd: (e) => {
        if (e.oldIndex === undefined || e.newIndex === undefined || e.oldIndex === e.newIndex) return;
        this.reorderProcess(tool, e.oldIndex, e.newIndex);
      },
    });
    wrap.append(list);

    for (const { edge, index } of rows) {
      const numberField = (label: string, value: number | undefined, apply: (n: number | undefined) => void) => {
        const input = el("input", { type: "number", value: value === undefined ? "" : String(value) }) as HTMLInputElement;
        input.addEventListener("change", () => {
          const raw = input.value.trim();
          const n = Number(raw);
          this.doc = structuredClone(this.doc);
          apply(raw === "" ? undefined : Number.isFinite(n) ? n : undefined);
          this.commit(`set ${tool} recipe ${label}`);
        });
        return el("label", { class: "inline-field" }, [label, input]);
      };
      list.append(
        el("div", { class: "nodegraph-recipe-row" }, [
          el("span", { class: "nodegraph-recipe-grip", title: "Drag to reorder" }, ["⠿"]),
          el("code", {}, [`${edge.inputs.join("+") || "?"} → ${edge.to || "?"}`]),
          numberField("amount", edge.amount, (n) => {
            this.doc.edges.process[index].amount = n ?? 1;
          }),
          numberField("duration", edge.duration, (n) => {
            if (n === undefined) delete this.doc.edges.process[index].duration;
            else this.doc.edges.process[index].duration = n;
          }),
        ]),
      );
    }
    return wrap;
  }

  /**
   * Move one of a tool's recipes, by position WITHIN THAT TOOL.
   *
   * The permutation lives in `data/nodeGraphEdit.ts` so it can be tested without
   * a DOM; this is only the gesture-to-commit wiring. A no-op drop returns the
   * same object, which is how a drag dropped where it started avoids pushing an
   * undo entry.
   */
  private reorderProcess(tool: string, from: number, to: number): void {
    const next = reorderToolProcesses(this.doc, tool, from, to);
    if (next === this.doc) return;
    this.doc = next;
    this.commit(`reorder ${tool} recipes`);
  }

  private edgesTouching(name: string): { kind: EdgeKindName; from: string; to: string }[] {
    const out: { kind: EdgeKindName; from: string; to: string }[] = [];
    for (const kind of EDGE_KIND_NAMES) {
      for (const edge of this.doc.edges[kind] as { from: string; to: string }[]) {
        if (edge.from === name || edge.to === name) out.push({ kind, from: edge.from, to: edge.to });
      }
    }
    return out;
  }

  /**
   * One inspector row, typed from the schema. Committed on BLUR, not on
   * keystroke — otherwise typing a five-letter name would push five undo
   * entries and Ctrl+Z would walk back one character at a time.
   */
  private fieldRow(
    target: Selection,
    vertex: Record<string, unknown>,
    field: FieldDef,
  ): HTMLElement {
    const current = vertex[field.name];
    const label = el("label", {}, [field.name + (field.required ? " *" : "")]);
    if (field.description) label.title = field.description;

    let input: HTMLInputElement | HTMLSelectElement;
    if (field.type === "bool") {
      input = el("input", { type: "checkbox" }) as HTMLInputElement;
      (input as HTMLInputElement).checked = Boolean(current);
      input.addEventListener("change", () =>
        this.commitField(target, field, (input as HTMLInputElement).checked),
      );
    } else if (field.type === "enum") {
      input = el("select", {}) as HTMLSelectElement;
      for (const option of field.options ?? []) {
        input.append(el("option", { value: option }, [option]));
      }
      (input as HTMLSelectElement).value = String(current ?? field.default ?? "");
      input.addEventListener("change", () =>
        this.commitField(target, field, (input as HTMLSelectElement).value),
      );
    } else {
      const numeric = field.type === "int" || field.type === "number";
      const list = field.type === "ref[]" || field.type === "int[]";
      input = el("input", {
        type: numeric ? "number" : "text",
        value: list ? (Array.isArray(current) ? current.join("|") : "") : String(current ?? ""),
      }) as HTMLInputElement;
      if (list) input.title = 'Separate items with "|"';
      input.addEventListener("blur", () => {
        const raw = (input as HTMLInputElement).value;
        if (numeric) {
          const n = Number(raw);
          this.commitField(target, field, raw === "" ? undefined : Number.isFinite(n) ? n : undefined);
        } else if (list) {
          const items = raw.split("|").map((s) => s.trim()).filter(Boolean);
          this.commitField(target, field, field.type === "int[]" ? items.map(Number) : items);
        } else {
          this.commitField(target, field, raw === "" ? undefined : raw);
        }
      });
    }

    return el("div", { class: "nodegraph-field" }, [label, input]);
  }

  private commitField(target: Selection, field: FieldDef, value: unknown): void {
    const vertex = this.vertexAt(target);
    if (!vertex) return;
    const before = vertex[field.name];
    if (before === value || (Array.isArray(before) && JSON.stringify(before) === JSON.stringify(value))) {
      return; // a blur with no change must not push a history entry
    }

    if (field.name === "name") {
      const next = String(value ?? "").trim();
      if (next === "" || this.doc.vertices[target.kind].some((v) => v.name === next)) {
        this.flashStatus("A node name must be unique and non-empty");
        this.renderSide();
        return;
      }
      this.doc = structuredClone(this.doc);
      const moved = this.vertexAt(target)!;
      // Rename is FREE: only the `node` field of the id entry changes, so every
      // committed level that references this id keeps pointing at it.
      renameNode(this.doc.idTable, SPACE_OF[target.kind], target.name, next);
      this.rewriteReferences(target.name, next);
      moved.name = next;
      const pos = this.positionOf(target.kind, target.name);
      delete this.layout()[layoutKey(target.kind, target.name)];
      this.layout()[layoutKey(target.kind, next)] = pos;
      this.selection = { kind: target.kind, name: next };
      this.commit(`rename ${target.name} → ${next}`);
      return;
    }

    this.doc = structuredClone(this.doc);
    const editing = this.vertexAt(target)!;
    if (value === undefined) delete editing[field.name];
    else editing[field.name] = value;

    // A flag that makes a node addressable from level data is what earns it an
    // id — servable/pickupable for an ingredient, orderable for a composite.
    // Minting here rather than on create means the id space only ever holds
    // things a level string can actually name.
    //
    // These are also exactly the flags the two mapping-table nodes derive their
    // membership from, so the wires redraw with them: `commit()` re-renders the
    // graph, and the tables are rebuilt from the flags on every render.
    const addressability =
      (target.kind === "ingredient" && (field.name === "servable" || field.name === "pickupable")) ||
      (target.kind === "composite" && field.name === "orderable");
    if (addressability && this.needsId(target.kind, editing)) {
      mintId(this.doc.idTable, SPACE_OF[target.kind], target.name);
    }
    this.commit(`set ${target.name}.${field.name}`);
  }

  /** Points every edge (and every process `inputs` entry) at a renamed vertex. */
  private rewriteReferences(from: string, to: string): void {
    for (const kind of EDGE_KIND_NAMES) {
      for (const edge of this.doc.edges[kind] as { from: string; to: string }[]) {
        if (edge.from === from) edge.from = to;
        if (edge.to === from) edge.to = to;
      }
    }
    for (const edge of this.doc.edges.process) {
      edge.inputs = edge.inputs.map((input) => (input === from ? to : input));
    }
    for (const edge of this.doc.edges.process) {
      if (edge.chainTools) edge.chainTools = edge.chainTools.map((t) => (t === from ? to : t));
    }
  }

  private issuesPanel(): HTMLElement {
    const { errors, warnings } = validateNodeGraph(this.doc);
    const body = el("div", { class: "nodegraph-panel-body" });
    if (errors.length === 0 && warnings.length === 0) {
      body.append(el("p", { class: "nodegraph-good" }, ["No issues."]));
    }
    for (const issue of [...errors, ...warnings]) {
      const row = el("div", { class: `nodegraph-issue ${errors.includes(issue) ? "bad" : "warn"}` }, [
        el("strong", {}, [issue.invariantId]),
        el("span", {}, [issue.message]),
      ]);
      if (issue.vertexName) {
        row.style.cursor = "pointer";
        row.addEventListener("click", () => {
          const kind = VERTEX_KIND_NAMES.find((k) =>
            this.doc.vertices[k].some((v) => v.name === issue.vertexName),
          );
          if (kind) this.select({ kind, name: issue.vertexName! });
        });
      }
      body.append(row);
    }
    return this.panel(`Validation (${errors.length}/${warnings.length})`, body);
  }

  private tracePanel(): HTMLElement {
    const body = el("div", { class: "nodegraph-panel-body" });
    try {
      const lookup = buildLookup(this.doc);
      const traces = traceAll(this.doc);
      if (traces.length === 0) {
        body.append(el("p", { class: "muted" }, ["No orderable composite yet."]));
      }
      for (const trace of traces) {
        const ok = trace.unreachable.length === 0;
        body.append(
          el("div", { class: `nodegraph-trace ${ok ? "good" : "bad"}` }, [
            el("strong", {}, [ok ? "✓ " : "✗ ", trace.orderable]),
            el("small", {}, [
              `${trace.leaves.length} pickups · depth ${trace.maxDepth} · ` +
                (trace.variantCount === null ? "unbounded variants" : `${trace.variantCount} variants`),
            ]),
            ...(ok
              ? []
              : [el("small", { class: "nodegraph-bad" }, [`unreachable: ${trace.unreachable.join(", ")}`])]),
          ]),
        );
      }
      body.append(el("small", { class: "muted" }, [`${lookup.orderables.length} orderable(s)`]));
    } catch (err) {
      body.append(el("p", { class: "nodegraph-bad" }, [(err as Error).message]));
    }
    return this.panel("Traceback", body);
  }

  /**
   * The id table, one reorderable list per space.
   *
   * A row's POSITION is the number level strings carry, so dragging a row is a
   * renumber, not a re-sort — every id from the smaller of the two positions
   * onward changes meaning. That is a real thing a designer may want (rebuild
   * the queue alphabet), so it is allowed; it is also destructive to committed
   * data, so it is confirmed first with the affected level count in hand.
   */
  private idTablePanel(): HTMLElement {
    const body = el("div", { class: "nodegraph-panel-body nodegraph-idtable" });
    for (const space of ID_SPACES) {
      const entries = this.doc.idTable[space] ?? [];
      const list = el("div", { class: "nodegraph-idrows" });
      Sortable.create(list, {
        animation: 120,
        handle: ".nodegraph-idgrip",
        onEnd: (e) => {
          if (e.oldIndex === undefined || e.newIndex === undefined) return;
          this.reorderIdRow(space, e.oldIndex, e.newIndex);
        },
      });
      entries.forEach((entry, id) => {
        list.append(
          el("div", { class: `nodegraph-idrow${entry?.node ? "" : " retired"}` }, [
            el("span", { class: "nodegraph-idgrip", title: "Drag to reorder — this renumbers" }, ["⠿"]),
            el("code", {}, [String(id)]),
            el("span", {}, [entry?.node ?? `${entry?.retired ?? "?"} (retired)`]),
          ]),
        );
      });
      body.append(
        el("div", { class: "nodegraph-idspace" }, [
          el("strong", {}, [`${space} (next ${nextId(this.doc.idTable, space)})`]),
          list,
        ]),
      );
    }
    // The only hand action: mint an id for a node that has none yet. The ids
    // themselves are never editable — that is what makes them safe.
    const untabled = this.untabledNodes();
    if (untabled.length > 0) {
      body.append(
        el("div", { class: "nodegraph-idspace" }, [
          el("strong", {}, ["Not addressable from level data"]),
          ...untabled.map(({ kind, name }) =>
            el("div", { class: "nodegraph-idrow" }, [
              el("span", {}, [`${kind}: ${name}`]),
              button("Mint id", () => {
                this.doc = structuredClone(this.doc);
                mintId(this.doc.idTable, SPACE_OF[kind], name);
                this.commit(`mint id for ${name}`);
              }),
            ]),
          ),
        ]),
      );
    }
    return this.panel("Id table", body);
  }

  /**
   * Move a row within its id space. Confirms first, because everything from
   * `min(from,to)` onward is renumbered and every level string indexing into
   * that range starts meaning something else.
   */
  private reorderIdRow(space: IdSpace, from: number, to: number): void {
    if (from === to) return;
    const rows = this.doc.idTable[space] ?? [];
    const affected = new Set<string>();
    for (let id = Math.min(from, to); id < rows.length; id++) {
      for (const name of this.levelsUsingId(space, id)) affected.add(name);
    }
    if (
      affected.size > 0 &&
      !confirm(
        `Moving this row renumbers the ${space} ids from ${Math.min(from, to)} onward.

` +
          `${affected.size} committed level(s) index into that range and will start meaning something different.

Continue?`,
      )
    ) {
      this.renderSide(); // put the dragged row back where it was
      return;
    }
    this.doc = { ...this.doc, idTable: reorderIdEntry(this.doc.idTable, space, from, to) };
    this.commit(`reorder ${space} id ${from} → ${to}`);
  }

  private untabledNodes(): Selection[] {
    const out: Selection[] = [];
    for (const kind of VERTEX_KIND_NAMES) {
      for (const vertex of this.doc.vertices[kind] as unknown as Record<string, unknown>[]) {
        if (!this.needsId(kind, vertex)) continue;
        const has = this.doc.idTable[SPACE_OF[kind]]?.some((e) => e?.node === vertex.name);
        if (!has) out.push({ kind, name: String(vertex.name) });
      }
    }
    return out;
  }

  private panel(title: string, body: HTMLElement): HTMLElement {
    return el("div", { class: "nodegraph-panel" }, [el("h3", {}, [title]), body]);
  }

  private flashStatus(message: string): void {
    const note = el("span", { class: "nodegraph-bad" }, [message]);
    this.statusBar.append(note);
    setTimeout(() => note.remove(), 4000);
  }

  // ---------- import / export ----------

  private exportJson(): void {
    // Unknown `_*` keys are preserved by structuredClone, so an unmodified
    // export diffs clean against the file it came from.
    const text = JSON.stringify(this.doc, null, 2);
    downloadFile(`${this.doc.map.id || "graph"}.json`, text, "application/json");
  }

  private exportCsv(): void {
    downloadFile(`${this.doc.map.id || "graph"}.csv`, graphToCsv(this.doc), "text/csv");
  }

  private importCsv(): void {
    const input = el("input", { type: "file", accept: ".csv,text/csv" }) as HTMLInputElement;
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const { doc, issues } = csvToGraph(String(reader.result));
        const vertexCount = VERTEX_KIND_NAMES.reduce((n, k) => n + doc.vertices[k].length, 0);
        if (vertexCount === 0) {
          alert(`No vertices found in ${file.name}. Nothing was changed.`);
          return;
        }
        const summary = issues.length
          ? `\n\n${issues.length} row(s) could not be read:\n` +
            issues.slice(0, 8).map((i) => `  line ${i.line}: ${i.message}`).join("\n") +
            (issues.length > 8 ? "\n  …" : "")
          : "";
        if (!confirm(`Replace the current graph with ${vertexCount} vertices from ${file.name}?${summary}`)) {
          return;
        }
        this.doc = doc;
        this.doc.layout = autoLayout(this.doc);
        this.selection = null;
        this.selected.clear();
        this.commit(`import ${file.name}`);
      };
      reader.readAsText(file);
    });
    input.click();
  }
}

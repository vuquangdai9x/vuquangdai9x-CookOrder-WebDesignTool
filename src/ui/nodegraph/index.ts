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

import { showContextMenu } from "../contextMenu.ts";
import { button, el } from "../dom.ts";
import { History, bindUndoRedoKeys } from "../history.ts";
import { cookedIconEl, dirtyIconEl, toolIconEl } from "../icon.ts";
import { autoLayout, layoutKey } from "./autoLayout.ts";
import type { Layout } from "./autoLayout.ts";
import { csvToGraph, graphToCsv } from "../../data/nodeGraphCsv.ts";
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
import { ID_SPACES, mintId, nextId, renameNode, retireId } from "../../data/nodeIdTable.ts";
import type { NodeProjectState } from "../../data/nodeProject.ts";
import type {
  EdgeKindName,
  FieldDef,
  IdSpace,
  NodeGraphMap,
  VertexKindName,
} from "../../data/nodeGraphTypes.ts";
import { downloadFile, levelsCsv } from "../../data/sheetSource.ts";
import { MAP1_DATA } from "../../data/configLoader.ts";
import { migrateMap } from "../../data/nodeGraphMigrate.ts";
import type { MigrationReport } from "../../data/nodeGraphMigrate.ts";
import type { LevelData } from "../../data/mapLoader.ts";

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
  private selection: Selection | null = null;

  private canvas!: HTMLElement;
  private edgeLayer!: SVGSVGElement;
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
    this.canvas = el("div", { class: "nodegraph-canvas" });
    this.canvas.append(this.edgeLayer);

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
      el("strong", {}, [this.doc.map.name || this.doc.map.id || "Untitled map"]),
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

    viewport.addEventListener("pointerdown", (e) => {
      if (e.target !== viewport && e.target !== this.canvas && e.target !== this.edgeLayer) return;
      const startX = e.clientX - this.pan.x;
      const startY = e.clientY - this.pan.y;
      const move = (ev: PointerEvent) => {
        this.pan.x = ev.clientX - startX;
        this.pan.y = ev.clientY - startY;
        this.applyTransform();
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      // Clicking empty space clears the selection — a plain, expected gesture.
      this.selection = null;
      this.renderSide();
      this.renderGraph();
    });
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
    this.canvas.replaceChildren(this.edgeLayer);

    for (const kind of VERTEX_KIND_NAMES) {
      for (const vertex of this.doc.vertices[kind]) {
        this.canvas.append(this.nodeEl(kind, vertex.name));
      }
    }
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
    const selected = this.selection?.kind === kind && this.selection.name === name;
    const vertex = this.doc.vertices[kind].find((v) => v.name === name) as
      | { name: string; displayName?: string; orderable?: boolean }
      | undefined;

    const node = el("div", {
      class: `nodegraph-node kind-${kind}${selected ? " selected" : ""}`,
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
      e.stopPropagation();
      const target = e.target as HTMLElement;
      if (target.closest(".np-port") || target.closest("button")) return; // their own handlers own this
      this.beginDrag({ kind, name }, node, e);
    });
    node.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.nodeMenu({ kind, name }, e);
    });
    return node;
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
  }

  private iconFor(kind: VertexKindName, name: string): HTMLElement {
    // Icons resolve through the shell's ambient node icon source, which is
    // keyed by DATA ID — so a vertex with no id table entry yet simply falls
    // back to its emoji, which is the honest thing to show.
    const entry = this.doc.idTable[SPACE_OF[kind]]?.find((e) => e.node === name);
    const id = entry?.id ?? -1;
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

  /** Node drag: ONE history entry, pushed on pointerup, not per pointermove. */
  private beginDrag(target: Selection, node: HTMLElement, down: PointerEvent): void {
    this.selection = target;
    this.renderSide();
    for (const other of this.canvas.querySelectorAll(".nodegraph-node.selected")) {
      other.classList.remove("selected");
    }
    node.classList.add("selected");

    const start = this.positionOf(target.kind, target.name);
    const originX = down.clientX;
    const originY = down.clientY;
    let moved = false;

    const move = (e: PointerEvent) => {
      const x = start.x + (e.clientX - originX) / this.scale;
      const y = start.y + (e.clientY - originY) / this.scale;
      moved = true;
      node.style.left = `${x}px`;
      node.style.top = `${y}px`;
      this.layout()[layoutKey(target.kind, target.name)] = { x, y };
      this.renderEdges();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (moved) {
        this.doc = structuredClone(this.doc);
        this.commit(`move ${target.name}`);
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
    this.commit(`add ${kind} ${name}`, 1);
  }

  /** Only vertices a level string can reference need an id. */
  private needsId(kind: VertexKindName, vertex: Record<string, unknown>): boolean {
    if (kind === "ingredient") return Boolean(vertex.servable || vertex.pickupable);
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
    this.commit(`delete ${target.kind} ${target.name}`, 0, removed);
  }

  /** Level names whose strings still resolve through this vertex's id. */
  private levelsReferencing(target: Selection): string[] {
    const entry = this.doc.idTable[SPACE_OF[target.kind]]?.find((e) => e.node === target.name);
    if (!entry) return [];
    const token =
      target.kind === "composite" ? `{c${entry.id}:` : target.kind === "group" ? `{g${entry.id}:` : null;
    const out: string[] = [];
    for (const level of this.project.levels) {
      if (token && level.customerString.includes(token)) {
        out.push(level.name);
        continue;
      }
      if (target.kind === "ingredient") {
        const idPattern = new RegExp(`(^|[^0-9])${entry.id}([^0-9]|$)`);
        if (idPattern.test(level.customerString) || idPattern.test(level.queueString)) out.push(level.name);
      }
    }
    return out;
  }

  private nodeMenu(target: Selection, e: MouseEvent): void {
    showContextMenu(
      e,
      [
        { label: "✎ Inspect", onSelect: () => this.select(target) },
        {
          label: "⧉ Duplicate",
          onSelect: () => this.duplicateVertex(target),
        },
        { label: "✕ Delete", danger: true, separator: true, onSelect: () => this.deleteVertex(target) },
      ],
      { title: target.name },
    );
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
    this.commit(`duplicate ${target.name}`, 1);
  }

  private select(target: Selection): void {
    this.selection = target;
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
      this.migrationPanel(),
      this.idTablePanel(),
    );
  }

  /**
   * The migration, run INSIDE the tool against the graph as it stands now.
   *
   * Deliberately not a build step: the migration has to be re-runnable as the
   * graph grows, and its report — which dishes could not be placed, which ids
   * no vertex claims — is a review artefact a designer needs to see next to the
   * graph that caused it. The "Download levels CSV" button produces exactly the
   * file that gets committed under config/nodegraph/levels/, which is the same
   * export-then-commit loop the rest of this tool uses.
   */
  private migrationPanel(): HTMLElement {
    const body = el("div", { class: "nodegraph-panel-body" });
    let result: { levels: LevelData[]; report: MigrationReport };
    try {
      result = migrateMap(MAP1_DATA, this.doc);
    } catch (err) {
      body.append(el("p", { class: "nodegraph-bad" }, [`Migration failed: ${(err as Error).message}`]));
      return this.panel("Migration", body);
    }
    const { levels, report } = result;

    const line = (label: string, value: string, bad = false) =>
      el("div", { class: `nodegraph-idrow${bad ? " " : ""}` }, [
        el("span", { class: bad ? "nodegraph-bad" : "" }, [`${label}: ${value}`]),
      ]);

    body.append(
      line("levels", String(levels.length)),
      line("ids in use with no vertex", String(report.unmappedInUse.length), report.unmappedInUse.length > 0),
      line("dishes not placed", String(report.unplacedDishes.length), report.unplacedDishes.length > 0),
      line("vertices with no legacy counterpart", String(report.newVertices.length)),
    );

    for (const unmapped of report.unmappedInUse.slice(0, 6)) {
      body.append(
        el("div", { class: "nodegraph-issue bad" }, [
          el("strong", {}, [`${unmapped.space} id ${unmapped.id}`]),
          el("span", {}, [`used by level(s) ${unmapped.levels.join(", ")} but no vertex claims it`]),
        ]),
      );
    }
    for (const unplaced of report.unplacedDishes.slice(0, 6)) {
      body.append(
        el("div", { class: "nodegraph-issue warn" }, [
          el("strong", {}, [`level ${unplaced.levelId}, customer ${unplaced.customer + 1}`]),
          el("span", {}, [unplaced.reason]),
        ]),
      );
    }
    if (report.newVertices.length > 0) {
      body.append(el("small", { class: "muted" }, [`new: ${report.newVertices.join(", ")}`]));
    }

    body.append(
      button("⬇ Download levels CSV", () => {
        downloadFile(`${this.doc.map.id || "graph"}-levels.csv`, levelsCsv({ ...MAP1_DATA, levels }));
      }, { title: "The file to commit under config/nodegraph/levels/" }),
      button("↻ Re-migrate into this session", () => {
        if (!confirm("Replace the node levels in this session with a fresh migration?")) return;
        this.project.levels = levels;
        this.onPersist();
      }),
    );
    return this.panel("Migration", body);
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
      wrap.append(
        el("div", { class: "nodegraph-recipe-row" }, [
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

    // Making an ingredient servable/pickupable is what makes it addressable
    // from level data, so that is when it earns an id.
    if (target.kind === "ingredient" && (field.name === "servable" || field.name === "pickupable")) {
      if (this.needsId(target.kind, editing)) mintId(this.doc.idTable, "ingredient", target.name);
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

  private idTablePanel(): HTMLElement {
    const body = el("div", { class: "nodegraph-panel-body nodegraph-idtable" });
    for (const space of ID_SPACES) {
      const entries = this.doc.idTable[space] ?? [];
      body.append(
        el("div", { class: "nodegraph-idspace" }, [
          el("strong", {}, [`${space} (next ${nextId(this.doc.idTable, space)})`]),
          ...entries.map((entry) =>
            el("div", { class: `nodegraph-idrow${entry.node === null ? " retired" : ""}` }, [
              el("code", {}, [String(entry.id)]),
              el("span", {}, [entry.node ?? `${entry.retired ?? "?"} (retired)`]),
            ]),
          ),
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

  private untabledNodes(): Selection[] {
    const out: Selection[] = [];
    for (const kind of VERTEX_KIND_NAMES) {
      for (const vertex of this.doc.vertices[kind] as unknown as Record<string, unknown>[]) {
        if (!this.needsId(kind, vertex)) continue;
        const has = this.doc.idTable[SPACE_OF[kind]]?.some((e) => e.node === vertex.name);
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
        this.commit(`import ${file.name}`);
      };
      reader.readAsText(file);
    });
    input.click();
  }
}

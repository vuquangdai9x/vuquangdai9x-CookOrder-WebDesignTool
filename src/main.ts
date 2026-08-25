import "./style.css";
import "./core/effects.ts"; // register built-in behaviors once
import { GLOBAL_DEFS } from "./data/configLoader.ts";
import {
  clearAllNodeDrafts,
  defaultNodeMapId,
  loadNodeProject,
  saveNodeProject,
} from "./data/nodeProject.ts";
import type { NodeProjectState } from "./data/nodeProject.ts";
import { MapProcessView } from "./ui/nodegraph/index.ts";
import { LevelPathView } from "./ui/levelpath/index.ts";
import { NodeDesignView } from "./ui/nodedesign/index.ts";
import { NodePlayView } from "./ui/nodeplay/index.ts";
import { NodeRemoteDataView } from "./ui/noderemote/index.ts";
import { nodeIconSource } from "./ui/nodegraph/iconAdapter.ts";
import type { NodeIconSource } from "./ui/nodegraph/iconAdapter.ts";
import { button, el } from "./ui/dom.ts";
import { setIconMap } from "./ui/icon.ts";
import { preloadMapWithOverlay } from "./ui/preloadOverlay.ts";

type Mode = "mapproc" | "lpath" | "ndesign" | "nplay" | "nremote";

interface ModeDef {
  id: Mode;
  label: string;
}

const MODES: ModeDef[] = [
  { id: "mapproc", label: "Map Process" },
  { id: "lpath", label: "Level Path" },
  { id: "ndesign", label: "Design" },
  { id: "nplay", label: "Play" },
  { id: "nremote", label: "Remote Data" },
];

const modeDef = (id: Mode): ModeDef | undefined => MODES.find((m) => m.id === id);

const app = document.querySelector<HTMLDivElement>("#app")!;

/** Node-graph working state, loaded from its own draft. */
let node: NodeProjectState = loadNodeProject();
let nodeLevelId = node.levels[0]?.id ?? 1;

let mode: Mode = "nplay";
let nodePlayView: NodePlayView | null = null;

/**
 * Whether each mounted view has unsaved work. Views register here on mount, so
 * the "leave anyway?" guard doesn't have to know which of the four views is up.
 */
let dirtyProviders: (() => boolean)[] = [];
const anyDirty = () => dirtyProviders.some((f) => f());

/** Icon sources already preloaded, keyed by graph document identity. */
const preloaded = new WeakSet<object>();
/** One icon source per graph document, so its identity is stable across renders. */
const nodeIconSources = new WeakMap<object, NodeIconSource>();

/**
 * Bumped by every render. `render()` awaits the preload, and a mode switch
 * during that await starts a second render — without this counter the first
 * one would resume and pair the LAST writer's icon map with the FIRST mount.
 */
let renderGeneration = 0;

/** Spreadsheet id the Remote Data tab reads/writes — editable there. */
let sheetIdInput = "";

function saveNodeDraft(): void {
  saveNodeProject(node);
}

/** Adopt another node map without replacing the shared state object held by mounted views. */
function selectNodeMap(docId: string): void {
  if (docId === node.docId) return;
  const next = loadNodeProject(docId);
  node.docId = next.docId;
  node.doc = next.doc;
  node.levels = next.levels;
  node.origin = next.origin;
  nodeLevelId = node.levels[0]?.id ?? 1;
  saveNodeDraft();
  void render();
}

function iconSourceFor(): NodeIconSource {
  let source = nodeIconSources.get(node.doc);
  if (!source) {
    source = nodeIconSource(node.doc);
    nodeIconSources.set(node.doc, source);
  }
  return source;
}

async function render(): Promise<void> {
  const generation = ++renderGeneration;
  const source = iconSourceFor();

  setIconMap(source);
  if (!preloaded.has(source)) {
    await preloadMapWithOverlay(source, GLOBAL_DEFS);
    preloaded.add(source);
    // A mode switch during that await already started a newer render, which
    // has set its own icon map. Resuming here would mount this mode's view
    // under the other one's icons.
    if (generation !== renderGeneration) return;
    setIconMap(source);
  }

  nodePlayView?.destroy();
  nodePlayView = null;
  dirtyProviders = [];

  const header = el("header", {}, [
    el("h1", {}, ["🍳 CookOrder"]),
    el("nav", { class: "mode-tabs" }, [
      ...MODES.map((m) =>
        button(m.label, () => switchMode(m.id), {
          class: mode === m.id ? "active" : "",
        }),
      ),
    ]),
    el("div", { class: "data-actions" }, [
      el("span", { class: "data-origin" }, [originLabel()]),
      button("♻ Reset node draft", () => resetNodeDraft(), {
        class: "full-btn",
        title: "Discard every Map Process draft and reload the bundled graphs",
      }),
    ]),
  ]);

  const main = el("main", {});
  const footer = el("footer", {}, ["Cook Order Game Design Tool - by daivq"]);
  app.replaceChildren(header, main, footer);

  // A view that throws must not leave an empty page with no way out.
  try {
    mount(mode, main);
  } catch (err) {
    console.error(err);
    main.replaceChildren(
      el("div", { class: "warnings" }, [
        el("strong", {}, [`${modeDef(mode)?.label ?? mode} mode failed to load`]),
        el("p", {}, [(err as Error).message]),
        el("p", {}, [
          "This usually means the saved draft no longer matches the current data schema.",
        ]),
        button("♻ Reset node draft and reload", () => {
          if (!confirm("Discard every Map Process draft, then reload?")) return;
          clearAllNodeDrafts();
          location.reload();
        }, { class: "danger" }),
      ]),
    );
  }
}

function originLabel(): string {
  return sheetIdInput.trim() ? `${node.origin} · sheet ${sheetIdInput.slice(0, 8)}…` : node.origin;
}

/**
 * The mount table. Every mode has an entry; a missing one is an error panel
 * rather than a silent fallback to some other mode.
 */
function mount(target: Mode, main: HTMLElement): void {
  switch (target) {
    case "mapproc": {
      const view = new MapProcessView(main, node, () => {
        saveNodeDraft();
        // Map Process can switch the open MAP under us, and the selected level
        // belongs to whichever map was open before. Re-anchor it rather than
        // carry an id that names nothing in the new map's dataset.
        if (!node.levels.some((l) => l.id === nodeLevelId)) nodeLevelId = node.levels[0]?.id ?? 1;
        void render();
      });
      dirtyProviders.push(() => view.isDirty);
      return;
    }
    case "lpath": {
      // Level Path spans EVERY map, so it saves each map's draft itself rather
      // than routing through saveNodeDraft (which only knows the open one).
      new LevelPathView(main, {
        project: node,
        defs: GLOBAL_DEFS,
        onOpenDesign: (docId, levelId) => openNodeLevel(docId, levelId, "ndesign"),
        onOpenPlay: (docId, levelId) => openNodeLevel(docId, levelId, "nplay"),
        onReloadShell: () => {
          // The open map's draft was discarded underneath us; reload it from
          // storage so the in-memory copy stops being a ghost of deleted data.
          const fresh = loadNodeProject(defaultNodeMapId());
          node.docId = fresh.docId;
          node.doc = fresh.doc;
          node.levels = fresh.levels;
          node.origin = fresh.origin;
          nodeLevelId = node.levels[0]?.id ?? 1;
          void render();
        },
      });
      return;
    }
    case "ndesign": {
      const view = new NodeDesignView(main, node, GLOBAL_DEFS, saveNodeDraft, nodeLevelId, (id) => {
        nodeLevelId = id;
      }, selectNodeMap);
      dirtyProviders.push(() => view.isDirty);
      return;
    }
    case "nplay": {
      nodePlayView = new NodePlayView(main, node, nodeLevelId, (id) => {
        nodeLevelId = id;
        void render();
      }, selectNodeMap);
      return;
    }
    case "nremote": {
      new NodeRemoteDataView(
        main,
        node,
        () => sheetIdInput,
        (id) => {
          sheetIdInput = id;
        },
        (levelId) => openInNodeDesign(levelId),
        (docId, levelId) => {
          if (docId !== node.docId) {
            const next = loadNodeProject(docId);
            node.docId = next.docId;
            node.doc = next.doc;
            node.levels = next.levels;
            node.origin = next.origin;
            saveNodeDraft();
          }
          nodeLevelId = levelId;
          switchMode("ndesign");
        },
      );
      return;
    }
    default: {
      // Exhaustiveness: adding a Mode without a mount is a compile error here,
      // and an unrecognised one at runtime says so instead of booting Play.
      const unreachable: never = target;
      main.append(
        el("div", { class: "warnings" }, [
          el("strong", {}, [`Unknown mode "${String(unreachable)}"`]),
          el("p", {}, ["Pick a tab above."]),
        ]),
      );
    }
  }
}

/** The Remote Data tab's "Open in Design" — the node Design mode. */
function openInNodeDesign(levelId: number): void {
  nodeLevelId = levelId;
  mode = "ndesign";
  void render();
}

/**
 * Open one level of one map in a given mode — Level Path's Design and Play
 * buttons, which can point at a map the app does not currently have loaded.
 */
function openNodeLevel(docId: string, levelId: number, target: Mode): void {
  if (docId !== node.docId) {
    const next = loadNodeProject(docId);
    node.docId = next.docId;
    node.doc = next.doc;
    node.levels = next.levels;
    node.origin = next.origin;
    saveNodeDraft();
  }
  nodeLevelId = levelId;
  mode = target;
  void render();
}

/**
 * Clears EVERY Map Process draft, not just the open map's.
 *
 * It used to clear only the active one, which is the wrong scope for a button
 * whose whole purpose is recovering from stale stored data: the drafts that
 * break a build are the ones written by an older build, and those sit under
 * whichever maps happen to be closed. Clearing one and leaving the rest means
 * the next map switch reintroduces exactly the failure this was meant to undo.
 */
function resetNodeDraft(): void {
  if (!confirm("Discard ALL Map Process drafts (every map) and reload the bundled graphs?")) return;
  clearAllNodeDrafts();
  node = loadNodeProject();
  nodeLevelId = node.levels[0]?.id ?? 1;
  void render();
}

function switchMode(next: Mode): void {
  if (next !== mode && anyDirty()) {
    if (!confirm("Some sections have unsaved changes. Leave this mode anyway?")) return;
  }
  mode = next;
  void render();
}

window.addEventListener("beforeunload", (e) => {
  if (anyDirty()) e.preventDefault();
});

void render();

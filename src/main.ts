import "./style.css";
import "./core/effects.ts"; // register built-in behaviors once
import {
  serializeCustomers,
  serializeGrid,
  serializeQueues,
} from "./core/parser.ts";
import { toMapDef } from "./data/mapLoader.ts";
import type { MapData } from "./data/mapLoader.ts";
import { toPlayableLevelConfig } from "./data/playLevel.ts";
import { GLOBAL_DEFS, MAP1_DATA } from "./data/configLoader.ts";
import { clearAllNodeDrafts, loadNodeProject, saveNodeProject } from "./data/nodeProject.ts";
import type { NodeProjectState } from "./data/nodeProject.ts";
import {
  exportProjectCsv,
  GoogleSheetApiSource,
  importLevelsCsv,
  SHEET_ID,
  SheetAuthRequiredError,
  SheetPermissionError,
} from "./data/sheetSource.ts";
import { DesignView } from "./ui/design/index.ts";
import { PlayView } from "./ui/play/index.ts";
import { RemoteDataView } from "./ui/remote/index.ts";
import { MapProcessView } from "./ui/nodegraph/index.ts";
import { NodeDesignView } from "./ui/nodedesign/index.ts";
import { NodePlayView } from "./ui/nodeplay/index.ts";
import { NodeRemoteDataView } from "./ui/noderemote/index.ts";
import { nodeIconSource } from "./ui/nodegraph/iconAdapter.ts";
import type { NodeIconSource } from "./ui/nodegraph/iconAdapter.ts";
import { showContextMenu } from "./ui/contextMenu.ts";
import { button, el } from "./ui/dom.ts";
import { setIconMap } from "./ui/icon.ts";
import { preloadMapWithOverlay } from "./ui/preloadOverlay.ts";
import { hideBlockingOverlay, showBlockingOverlay } from "./ui/loadingOverlay.ts";
import { showSheetPermissionDialog } from "./ui/sheetPermissionDialog.ts";

/**
 * Seven modes: four on the node-graph system, three on the untouched legacy
 * one. The `n`-prefixed ids are the new stack; the bare ones are legacy and
 * keep their original ids so a bookmarked draft/session keeps working.
 */
type Mode = "mapproc" | "ndesign" | "nplay" | "nremote" | "design" | "play" | "remote";
type ModeGroup = "node" | "legacy";

interface ModeDef {
  id: Mode;
  label: string;
  group: ModeGroup;
}

/**
 * ONE list drives both the tab bar and the mount table below. The previous
 * shell was an `if / else if / else` in which `play` was the ELSE branch — an
 * unrecognised mode silently booted legacy Play instead of saying anything.
 * With a table there is no else branch to fall into: an unknown mode is a
 * missing key, and that renders an error panel.
 */
const MODES: ModeDef[] = [
  { id: "mapproc", label: "Map Process", group: "node" },
  { id: "ndesign", label: "Design", group: "node" },
  { id: "nplay", label: "Play", group: "node" },
  { id: "nremote", label: "Remote Data", group: "node" },
  { id: "design", label: "Design-Legacy", group: "legacy" },
  { id: "play", label: "Play-Legacy", group: "legacy" },
  { id: "remote", label: "Remote Data-Legacy", group: "legacy" },
];

const modeDef = (id: Mode): ModeDef | undefined => MODES.find((m) => m.id === id);

const app = document.querySelector<HTMLDivElement>("#app")!;
const DRAFT_KEY = "cookorder-draft-map";
/**
 * Bump whenever the stored shape changes. Drafts outlive schema changes, so a
 * stale one must be migrated rather than loaded blindly — restoring a draft
 * that predates the cooking-tool model left the page blank. v3 moved
 * gridWidth/gridHeight/dirtyStackHeight from per-level to per-map and added
 * disabledRawIds/disabledCookedIds to MapDef; a v2 draft has none of those,
 * which would otherwise render the grid with NaN dimensions. v4 added
 * dirtyObjects to MapDef; a v3 draft has no such array, which crashed image
 * preload (`map.dirtyObjects is not iterable`) instead of falling back.
 *
 * The node-graph system has its own key and its own version — see
 * data/nodeProject.ts. Resetting one draft must never destroy the other.
 */
const DRAFT_VERSION = 4;

interface Draft {
  version: number;
  map: MapData;
}

const restored = loadDraft();

/** Legacy working state. The editors mutate `map`; CSV export writes exactly it. */
const legacy = {
  map: (restored?.map ?? structuredClone(MAP1_DATA)) as MapData,
  /** Shared by Design-Legacy and Play-Legacy so switching modes never resets the open level. */
  levelId: 0,
  dataOrigin: restored
    ? restored.migrated
      ? "local draft (levels kept, definitions refreshed)"
      : "local draft"
    : "bundled Map 1 snapshot",
};
legacy.levelId = legacy.map.levels[0]?.id ?? 1;

/** Node-graph working state, loaded from its own draft. */
let node: NodeProjectState = loadNodeProject();
let nodeLevelId = node.levels[0]?.id ?? 1;

let mode: Mode = "play";
let playView: PlayView | null = null;
let nodePlayView: NodePlayView | null = null;

/**
 * Whether each mounted view has unsaved work. Views register here on mount, so
 * the "leave anyway?" guards don't have to know which of seven views is up —
 * previously this was a single `designView?.isDirty`, which silently stopped
 * protecting anything the moment a second editable mode existed.
 */
let dirtyProviders: (() => boolean)[] = [];
const anyDirty = () => dirtyProviders.some((f) => f());

/**
 * Icon sources already preloaded. A WeakSet, not a single identity slot: with
 * two alternating sources (legacy map / node graph), one slot would miss on
 * EVERY switch and re-run the whole preload each time.
 */
const preloaded = new WeakSet<object>();
/** One icon source per graph document, so its identity is stable across renders. */
const nodeIconSources = new WeakMap<object, NodeIconSource>();

/**
 * Bumped by every render. `render()` awaits the preload, and a mode switch
 * during that await starts a second render — without this counter the first
 * one would resume and pair the LAST writer's icon map with the FIRST mount.
 */
let renderGeneration = 0;

/** Spreadsheet id the Remote Data tabs read/write — editable there, shared by both. */
let sheetIdInput = SHEET_ID;

function loadDraft(): { map: MapData; migrated: boolean } | null {
  let stored: unknown;
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    stored = JSON.parse(raw);
  } catch (err) {
    console.warn("Draft could not be parsed — starting from the bundled snapshot", err);
    return null;
  }

  const draft = stored as Partial<Draft> & Partial<MapData>;
  // v1 drafts were the bare map; v2+ wrap it so the version travels with it.
  const candidate = (draft.map ?? draft) as Partial<MapData>;
  if (!candidate || !Array.isArray(candidate.levels) || candidate.levels.length === 0) {
    console.warn("Draft has no levels — starting from the bundled snapshot");
    return null;
  }

  const current =
    draft.version === DRAFT_VERSION &&
    Array.isArray(candidate.tools) &&
    candidate.rawIngredients?.every((r) => typeof r.numSlices === "number") &&
    typeof candidate.gridWidth === "number" &&
    typeof candidate.gridHeight === "number" &&
    typeof candidate.dirtyStackHeight === "number" &&
    Array.isArray(candidate.disabledRawIds) &&
    Array.isArray(candidate.disabledCookedIds) &&
    Array.isArray(candidate.dirtyObjects);
  if (current) return { map: candidate as MapData, migrated: false };

  // Only the level edits are the designer's own work; everything else now comes
  // from src/data/config, so take the fresh definitions and keep the levels.
  console.info("Migrating an older draft: keeping level edits, refreshing definitions");
  return {
    map: { ...structuredClone(MAP1_DATA), levels: candidate.levels as MapData["levels"] },
    migrated: true,
  };
}

function saveDraft(): void {
  try {
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({ version: DRAFT_VERSION, map: legacy.map } satisfies Draft),
    );
  } catch (err) {
    console.warn("Could not persist draft", err);
  }
}

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

/** The icon/preload source for the active mode — one ambient map, chosen per group. */
function iconSourceFor(group: ModeGroup): MapData | NodeIconSource {
  if (group === "legacy") return legacy.map;
  let source = nodeIconSources.get(node.doc);
  if (!source) {
    source = nodeIconSource(node.doc);
    nodeIconSources.set(node.doc, source);
  }
  return source;
}

async function render(): Promise<void> {
  const generation = ++renderGeneration;
  const def = modeDef(mode);
  const source = iconSourceFor(def?.group ?? "legacy");

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

  playView?.destroy();
  playView = null;
  nodePlayView?.destroy();
  nodePlayView = null;
  dirtyProviders = [];

  const header = el("header", {}, [
    el("h1", {}, ["🍳 CookOrder"]),
    el("nav", { class: "mode-tabs" }, [
      ...MODES.map((m) =>
        button(m.label, () => switchMode(m.id), {
          class: [mode === m.id ? "active" : "", m.group === "legacy" ? "legacy-tab" : ""]
            .filter(Boolean)
            .join(" "),
        }),
      ),
    ]),
    el("div", { class: "data-actions" }, [
      el("span", { class: "data-origin" }, [originLabel()]),
      button("⬇ Export CSV", () => exportProjectCsv([legacy.map]), {
        class: "full-btn",
        title: "Download this map's level data as CSV",
      }),
      button("⬆ Import CSV", () => importCsvFile(), {
        class: "full-btn",
        title: "Replace this map's levels from a levels CSV file",
      }),
      button("♻ Reset draft", () => resetDraft(), {
        class: "full-btn",
        title: "Discard the legacy local draft and reload the bundled snapshot",
      }),
      button("♻ Reset node draft", () => resetNodeDraft(), {
        class: "full-btn",
        title: "Discard every Map Process draft and reload the bundled graphs",
      }),
      // Same actions, collapsed behind one button for narrow windows — CSS
      // swaps which of these two groups is visible (see .data-actions).
      button("⋮", (e) =>
        showContextMenu(
          e,
          [
            { label: "⬇ Export CSV", onSelect: () => exportProjectCsv([legacy.map]) },
            { label: "⬆ Import CSV", onSelect: () => importCsvFile() },
            { label: "♻ Reset draft", danger: true, separator: true, onSelect: () => resetDraft() },
            {
              label: "♻ Reset node draft",
              danger: true,
              onSelect: () => resetNodeDraft(),
            },
          ],
          { title: "Data" },
        ),
      { class: "kebab collapsed-btn", title: "Data actions" }),
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
        el("strong", {}, [`${def?.label ?? mode} mode failed to load`]),
        el("p", {}, [(err as Error).message]),
        el("p", {}, [
          "This usually means the saved draft no longer matches the current data schema.",
        ]),
        // Clears BOTH systems' drafts, not just the legacy one. This is the
        // only way out of a page that fails to mount, so it cannot be the one
        // that leaves half the stored state behind: a node-graph draft the
        // build can no longer read would survive the reset and break the very
        // next load, with the same panel and the same useless button.
        button("♻ Reset ALL drafts and reload", () => {
          if (!confirm("Discard BOTH the legacy draft and every Map Process draft, then reload?")) {
            return;
          }
          localStorage.removeItem(DRAFT_KEY);
          clearAllNodeDrafts();
          location.reload();
        }, { class: "danger" }),
      ]),
    );
  }
}

function originLabel(): string {
  const group = modeDef(mode)?.group ?? "legacy";
  const base = group === "node" ? node.origin : legacy.dataOrigin;
  return sheetIdInput.trim() ? `${base} · sheet ${sheetIdInput.slice(0, 8)}…` : base;
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
    case "design": {
      const view = new DesignView(main, legacy.map, GLOBAL_DEFS, saveDraft, legacy.levelId, (id) => {
        legacy.levelId = id;
      });
      dirtyProviders.push(() => view.isDirty);
      return;
    }
    case "play": {
      const parsed = toMapDef(legacy.map);
      const rawLevel = parsed.levels.find((l) => l.id === legacy.levelId) ?? parsed.levels[0];
      if (!rawLevel) {
        main.append(el("p", {}, ["No levels to play."]));
        return;
      }
      // Design mode edits/shows the real ids; Play mode is the only place
      // a map's disabled ingredients (e.g. Map 1's bun) actually disappear.
      const level = toPlayableLevelConfig(parsed, rawLevel);
      playView = new PlayView(main, parsed, level, (id) => {
        legacy.levelId = id;
        void render();
      });
      return;
    }
    case "remote": {
      new RemoteDataView(
        main,
        legacy.map,
        () => sheetIdInput,
        (id) => {
          sheetIdInput = id;
        },
        () => {
          saveDraft();
          void render();
        },
        (levelId) => openInDesign(levelId),
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

/**
 * Switches to Design-Legacy with the given level selected — the legacy Remote
 * Data tab's "Open in Design" button.
 */
function openInDesign(levelId: number): void {
  legacy.levelId = levelId;
  mode = "design";
  void render();
}

/** The node Remote Data tab's "Open in Design" — the node Design mode. */
function openInNodeDesign(levelId: number): void {
  nodeLevelId = levelId;
  mode = "ndesign";
  void render();
}

/**
 * Replaces the working map's levels from a levels CSV file (the format
 * levelsCsv()/exportProjectCsv() write) — a file picker + FileReader round
 * trip since the browser has no filesystem access otherwise. Only the level
 * list changes; map-level fields (grid size, ingredients, tools) are untouched
 * since the CSV no longer carries definitions.
 */
function importCsvFile(): void {
  if (anyDirty()) {
    if (!confirm("Unsaved changes will be overwritten. Import CSV?")) return;
  }
  const input = el("input", { type: "file", accept: ".csv,text/csv" }) as HTMLInputElement;
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const levels = importLevelsCsv(String(reader.result));
        if (levels.length === 0) throw new Error("CSV has no level rows");
        legacy.map = { ...legacy.map, levels };
        legacy.levelId = legacy.map.levels[0].id;
        legacy.dataOrigin = `imported CSV (${file.name})`;
        saveDraft();
        void render();
      } catch (err) {
        alert(`Could not import CSV: ${(err as Error).message}`);
      }
    };
    reader.readAsText(file);
  });
  input.click();
}

function resetDraft(): void {
  if (!confirm("Discard the LEGACY local draft and reload the bundled snapshot?")) return;
  localStorage.removeItem(DRAFT_KEY);
  legacy.map = structuredClone(MAP1_DATA);
  legacy.dataOrigin = "bundled Map 1 snapshot";
  legacy.levelId = legacy.map.levels[0]?.id ?? 1;
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

/**
 * Loads live level data via the Sheets API.
 *
 * `interactive` distinguishes two very different situations:
 * - `true` (button/menu click): shows the blocking overlay, and passes
 *   through to a token request that may pop up Google's account/consent
 *   picker — safe here because we're still inside the click's call stack.
 * - `false` (silent startup check): no overlay, no popup — either an
 *   existing Google session silently grants a token, or we quietly give up
 *   and leave the bundled/draft data in place (the user can still sign in
 *   interactively from the Remote Data tab, which shares this same token).
 */
async function loadFromSheet(interactive: boolean): Promise<void> {
  // No id typed in yet — most people opening this tool for the first time,
  // since no default is checked into source (see SHEET_ID). A silent startup
  // check just stays quiet on local data; an explicit click says why nothing
  // happened rather than firing a request that can only fail.
  if (!sheetIdInput.trim()) {
    if (interactive) alert("Paste a spreadsheet ID into the Sheet ID field first.");
    return;
  }

  if (interactive && anyDirty()) {
    if (!confirm("Unsaved changes will be overwritten. Reload?")) return;
  }

  if (interactive) {
    legacy.dataOrigin = "loading from Google Sheet…";
    showBlockingOverlay("Loading data from Google Sheet…");
    await render();
  }

  try {
    const project = await new GoogleSheetApiSource(interactive, sheetIdInput).loadProject();
    const fresh = project.maps[0];
    legacy.map = {
      ...legacy.map,
      gridWidth: fresh.gridWidth,
      gridHeight: fresh.gridHeight,
      dirtyStackHeight: fresh.dirtyStackHeight,
      levels: fresh.levels.map((l, i) => ({
        ...legacy.map.levels[i],
        id: l.id,
        name: l.name,
        weather: l.weather,
        levelTag: l.levelTag,
        featureUnlock: l.featureUnlock,
        serveableSlots: l.serveableSlots,
        shuffleDistance: l.shuffleDistance,
        // l.queueGroups must be passed — otherwise every combined/linked
        // group in the project is silently wiped the next time a sheet
        // reload rebuilds this string (serializeQueues's group param
        // defaults to [] for callers that don't know about grouping).
        queueString: serializeQueues(l.queues, l.queueGroups),
        gridString: serializeGrid(l.grid),
        customerString: serializeCustomers(l.customers),
      })),
    };
    saveDraft();
    legacy.dataOrigin = "live Google Sheet";
  } catch (err) {
    console.error(err);
    if (err instanceof SheetAuthRequiredError) {
      // A silent check finding no session yet is the normal first-open state
      // for every new browser/tab — stay quiet and just offer the sign-in
      // button, rather than reporting it as a failure.
      if (interactive) legacy.dataOrigin = `sign-in failed (${err.message}) — bundled snapshot`;
    } else if (err instanceof SheetPermissionError) {
      legacy.dataOrigin = `sheet load failed (${err.message}) — bundled snapshot`;
      showSheetPermissionDialog({ sheetId: sheetIdInput });
    } else {
      legacy.dataOrigin = `sheet load failed (${(err as Error).message}) — bundled snapshot`;
    }
  }
  if (interactive) hideBlockingOverlay();
  await render();
}

window.addEventListener("beforeunload", (e) => {
  if (anyDirty()) e.preventDefault();
});

/**
 * The GIS OAuth client's authorized JavaScript origins are pinned to a fixed
 * set of hosts and don't include arbitrary localhost dev ports — a silent
 * check there doesn't fail quietly, it can pop an "origin_mismatch" Google
 * error page. Skip the automatic check entirely when running locally; the
 * user can still click "Sign in with Google" manually if they want to.
 */
const isLocalDev =
  location.hostname === "localhost" ||
  location.hostname === "127.0.0.1" ||
  location.hostname === "";

// Render immediately with local data (draft/bundled) so the page is never
// blank while we check for a Google session, then upgrade in the background:
// a returning, already-signed-in user gets live data moments later, a first
// visit just gets a "Sign in with Google" button instead of any error.
// Skipped entirely with no sheetId typed in (the common case, since no
// default is checked into source — see SHEET_ID): there's nothing to load
// yet, so there's no reason to trigger a Google auth check at all.
void render();
if (!isLocalDev && sheetIdInput.trim()) void loadFromSheet(false);

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
import { showContextMenu } from "./ui/contextMenu.ts";
import { button, el } from "./ui/dom.ts";
import { setIconMap } from "./ui/icon.ts";
import { preloadMapWithOverlay } from "./ui/preloadOverlay.ts";
import { hideBlockingOverlay, showBlockingOverlay } from "./ui/loadingOverlay.ts";
import { showSheetPermissionDialog } from "./ui/sheetPermissionDialog.ts";

type Mode = "design" | "play" | "remote";

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
 */
const DRAFT_VERSION = 4;

interface Draft {
  version: number;
  map: MapData;
}

const restored = loadDraft();

/** Working copy the editors mutate; CSV export writes exactly this. */
let map: MapData = restored?.map ?? structuredClone(MAP1_DATA);
let mode: Mode = "play";
let dataOrigin = restored
  ? restored.migrated
    ? "local draft (levels kept, definitions refreshed)"
    : "local draft"
  : "bundled Map 1 snapshot";
/** Shared between Design and Play mode so switching modes never resets which level is open — see DesignView's onLevelChange and PlayView's onSelectLevel below. */
let currentLevelId = map.levels[0]?.id ?? 1;
let playView: PlayView | null = null;
let designView: DesignView | null = null;
/** Identity of the map last preloaded, so a same-map re-render doesn't re-preload. */
let preloadedMapRef: MapData | null = null;
/** Spreadsheet id the Remote Data tab reads/writes — editable there. No default is baked in (see SHEET_ID); only someone who pastes in their own project's id gets live data. */
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
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ version: DRAFT_VERSION, map } satisfies Draft));
  } catch (err) {
    console.warn("Could not persist draft", err);
  }
}

async function render(): Promise<void> {
  setIconMap(map);
  // Only a genuine map change (new object identity) triggers a preload —
  // switching mode/level within the same map reuses what's already loaded.
  if (map !== preloadedMapRef) {
    await preloadMapWithOverlay(map, GLOBAL_DEFS);
    preloadedMapRef = map;
  }

  playView?.destroy();
  playView = null;
  designView = null;

  const header = el("header", {}, [
    el("h1", {}, ["🍳 CookOrder"]),
    el("nav", { class: "mode-tabs" }, [
      button("Design", () => switchMode("design"), {
        class: mode === "design" ? "active" : "",
      }),
      button("Play", () => switchMode("play"), {
        class: mode === "play" ? "active" : "",
      }),
      button("Remote Data", () => switchMode("remote"), {
        class: mode === "remote" ? "active" : "",
      }),
    ]),
    el("div", { class: "data-actions" }, [
      el("span", { class: "data-origin" }, [
        sheetIdInput.trim() ? `${dataOrigin} · sheet ${sheetIdInput.slice(0, 8)}…` : dataOrigin,
      ]),
      button("⬇ Export CSV", () => exportProjectCsv([map]), {
        class: "full-btn",
        title: "Download this map's level data as CSV",
      }),
      button("⬆ Import CSV", () => importCsvFile(), {
        class: "full-btn",
        title: "Replace this map's levels from a levels CSV file",
      }),
      button("♻ Reset draft", () => resetDraft(), {
        class: "full-btn",
        title: "Discard the local draft and reload the bundled snapshot",
      }),
      // Same actions, collapsed behind one button for narrow windows — CSS
      // swaps which of these two groups is visible (see .data-actions).
      button("⋮", (e) =>
        showContextMenu(
          e,
          [
            { label: "⬇ Export CSV", onSelect: () => exportProjectCsv([map]) },
            { label: "⬆ Import CSV", onSelect: () => importCsvFile() },
            { label: "♻ Reset draft", danger: true, separator: true, onSelect: () => resetDraft() },
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
    if (mode === "design") {
      designView = new DesignView(main, map, GLOBAL_DEFS, saveDraft, currentLevelId, (id) => {
        currentLevelId = id;
      });
    } else if (mode === "remote") {
      new RemoteDataView(
        main,
        map,
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
    } else {
      const parsed = toMapDef(map);
      const rawLevel = parsed.levels.find((l) => l.id === currentLevelId) ?? parsed.levels[0];
      if (!rawLevel) {
        main.append(el("p", {}, ["No levels to play."]));
        return;
      }
      // Design mode edits/shows the real ids; Play mode is the only place
      // a map's disabled ingredients (e.g. Map 1's bun) actually disappear.
      const level = toPlayableLevelConfig(parsed, rawLevel);
      playView = new PlayView(main, parsed, level, (id) => {
        currentLevelId = id;
        void render();
      });
    }
  } catch (err) {
    console.error(err);
    main.replaceChildren(
      el("div", { class: "warnings" }, [
        el("strong", {}, [
          `${mode === "design" ? "Design" : mode === "remote" ? "Remote Data" : "Play"} mode failed to load`,
        ]),
        el("p", {}, [(err as Error).message]),
        el("p", {}, [
          "This usually means the saved draft no longer matches the current data schema.",
        ]),
        button("♻ Reset draft and reload", () => {
          localStorage.removeItem(DRAFT_KEY);
          location.reload();
        }),
      ]),
    );
  }
}

/**
 * Switches to Design mode with the given level selected — the Remote Data
 * tab's "Open in Design" button. Guards the same way switchMode("design")
 * does when leaving Design mode dirty; entering it has nothing to guard.
 */
function openInDesign(levelId: number): void {
  currentLevelId = levelId;
  mode = "design";
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
  if (designView?.isDirty) {
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
        map = { ...map, levels };
        currentLevelId = map.levels[0].id;
        dataOrigin = `imported CSV (${file.name})`;
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
  if (!confirm("Discard the local draft and reload the bundled snapshot?")) return;
  localStorage.removeItem(DRAFT_KEY);
  map = structuredClone(MAP1_DATA);
  dataOrigin = "bundled Map 1 snapshot";
  currentLevelId = map.levels[0]?.id ?? 1;
  void render();
}

function switchMode(next: Mode): void {
  if (mode === "design" && designView?.isDirty) {
    if (!confirm("Some sections have unsaved changes. Leave Design mode anyway?")) return;
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

  if (interactive && designView?.isDirty) {
    if (!confirm("Unsaved changes will be overwritten. Reload?")) return;
  }

  if (interactive) {
    dataOrigin = "loading from Google Sheet…";
    showBlockingOverlay("Loading data from Google Sheet…");
    await render();
  }

  try {
    const project = await new GoogleSheetApiSource(interactive, sheetIdInput).loadProject();
    const fresh = project.maps[0];
    map = {
      ...map,
      gridWidth: fresh.gridWidth,
      gridHeight: fresh.gridHeight,
      dirtyStackHeight: fresh.dirtyStackHeight,
      levels: fresh.levels.map((l, i) => ({
        ...map.levels[i],
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
    dataOrigin = "live Google Sheet";
  } catch (err) {
    console.error(err);
    if (err instanceof SheetAuthRequiredError) {
      // A silent check finding no session yet is the normal first-open state
      // for every new browser/tab — stay quiet and just offer the sign-in
      // button, rather than reporting it as a failure.
      if (interactive) dataOrigin = `sign-in failed (${err.message}) — bundled snapshot`;
    } else if (err instanceof SheetPermissionError) {
      dataOrigin = `sheet load failed (${err.message}) — bundled snapshot`;
      showSheetPermissionDialog({ sheetId: sheetIdInput });
    } else {
      dataOrigin = `sheet load failed (${(err as Error).message}) — bundled snapshot`;
    }
  }
  if (interactive) hideBlockingOverlay();
  await render();
}

window.addEventListener("beforeunload", (e) => {
  if (designView?.isDirty) e.preventDefault();
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

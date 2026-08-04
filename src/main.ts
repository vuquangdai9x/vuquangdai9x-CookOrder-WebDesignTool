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
  SHEET_ID,
  SheetAuthRequiredError,
  SheetPermissionError,
} from "./data/sheetSource.ts";
import { DesignView } from "./ui/design/index.ts";
import { PlayView } from "./ui/play/index.ts";
import { showContextMenu } from "./ui/contextMenu.ts";
import { button, el } from "./ui/dom.ts";
import { setIconMap } from "./ui/icon.ts";
import { preloadMapWithOverlay } from "./ui/preloadOverlay.ts";
import { hideBlockingOverlay, showBlockingOverlay } from "./ui/loadingOverlay.ts";
import { showSheetPermissionDialog } from "./ui/sheetPermissionDialog.ts";

type Mode = "design" | "play";

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
let mode: Mode = "design";
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
/** Set when the startup silent sign-in check found no Google session/consent yet. */
let needsSignIn = false;
/** Spreadsheet id "Load from Sheet" reads from — editable in the header, defaults to the bundled SHEET_ID. */
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
    ]),
    el("div", { class: "data-actions" }, [
      el("span", { class: "data-origin" }, [`${dataOrigin} · sheet ${sheetIdInput.slice(0, 8)}…`]),
      sheetIdField(),
      // Clicking either loads the sheet; the label just sets the right
      // expectation — a fresh browser/tab has no Google session yet, so the
      // first click always shows the account/consent picker.
      needsSignIn
        ? button("🔑 Sign in with Google", () => void loadFromSheet(true), {
            class: "full-btn",
            title: "Sign in to read the linked Google Sheet",
          })
        : button("⟳ Load from Sheet", () => void loadFromSheet(true), {
            class: "full-btn",
            title: "Re-read the linked Google Sheet",
          }),
      button("⬇ Export CSV", () => exportProjectCsv([map]), {
        class: "full-btn",
        title: "Download levels + definitions as CSV",
      }),
      button("♻ Reset draft", () => resetDraft(), {
        class: "full-btn",
        title: "Discard the local draft and reload the bundled snapshot",
      }),
      // Same three actions, collapsed behind one button for narrow windows —
      // CSS swaps which of these two groups is visible (see .data-actions).
      button("⋮", (e) =>
        showContextMenu(
          e,
          [
            {
              label: needsSignIn ? "🔑 Sign in with Google" : "⟳ Load from Sheet",
              onSelect: () => void loadFromSheet(true),
            },
            { label: "⬇ Export CSV", onSelect: () => exportProjectCsv([map]) },
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
        el("strong", {}, [`${mode === "design" ? "Design" : "Play"} mode failed to load`]),
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

/** Text input for a custom spreadsheet id, defaulting to the currently effective one — lets a designer point "Load from Sheet" at a different spreadsheet with the same tab layout. */
function sheetIdField(): HTMLElement {
  const input = el("input", {
    type: "text",
    value: sheetIdInput,
    class: "sheet-id-input",
  }) as HTMLInputElement;
  input.addEventListener("change", () => {
    sheetIdInput = input.value.trim() || SHEET_ID;
    input.value = sheetIdInput;
  });
  return el("label", { class: "field small sheet-id-field", title: "Spreadsheet ID to read from" }, [
    "Sheet ID",
    input,
  ]);
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
 *   and flip `needsSignIn` so the header offers a sign-in button instead.
 */
async function loadFromSheet(interactive: boolean): Promise<void> {
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
    needsSignIn = false;
  } catch (err) {
    console.error(err);
    if (err instanceof SheetAuthRequiredError) {
      needsSignIn = true;
      // A silent check finding no session yet is the normal first-open state
      // for every new browser/tab — stay quiet and just offer the sign-in
      // button, rather than reporting it as a failure.
      if (interactive) dataOrigin = `sign-in failed (${err.message}) — bundled snapshot`;
    } else if (err instanceof SheetPermissionError) {
      dataOrigin = `sheet load failed (${err.message}) — bundled snapshot`;
      showSheetPermissionDialog();
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
void render();
if (!isLocalDev) void loadFromSheet(false);

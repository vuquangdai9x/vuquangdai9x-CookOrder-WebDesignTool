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
import { exportProjectCsv, GoogleSheetCsvSource, SHEET_ID } from "./data/sheetSource.ts";
import { DesignView } from "./ui/design/index.ts";
import { PlayView } from "./ui/play/index.ts";
import { showContextMenu } from "./ui/contextMenu.ts";
import { button, el } from "./ui/dom.ts";
import { setIconMap } from "./ui/icon.ts";
import { preloadMapWithOverlay } from "./ui/preloadOverlay.ts";

type Mode = "design" | "play";

const app = document.querySelector<HTMLDivElement>("#app")!;
const DRAFT_KEY = "cookorder-draft-map";
/**
 * Bump whenever the stored shape changes. Drafts outlive schema changes, so a
 * stale one must be migrated rather than loaded blindly — restoring a draft
 * that predates the cooking-tool model left the page blank. v3 moved
 * gridWidth/gridHeight/dirtyStackHeight from per-level to per-map and added
 * disabledRawIds/disabledCookedIds to MapDef; a v2 draft has none of those,
 * which would otherwise render the grid with NaN dimensions.
 */
const DRAFT_VERSION = 3;

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
let playLevelId = map.levels[0]?.id ?? 1;
let playView: PlayView | null = null;
let designView: DesignView | null = null;
/** Identity of the map last preloaded, so a same-map re-render doesn't re-preload. */
let preloadedMapRef: MapData | null = null;

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
    Array.isArray(candidate.disabledCookedIds);
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
      el("span", { class: "data-origin" }, [`${dataOrigin} · sheet ${SHEET_ID.slice(0, 8)}…`]),
      button("⟳ Load from Sheet", () => void reloadFromSheet(), {
        class: "full-btn",
        title: "Re-read the linked Google Sheet (read-only)",
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
            { label: "⟳ Load from Sheet", onSelect: () => void reloadFromSheet() },
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
      designView = new DesignView(main, map, GLOBAL_DEFS, saveDraft);
    } else {
      const parsed = toMapDef(map);
      const rawLevel = parsed.levels.find((l) => l.id === playLevelId) ?? parsed.levels[0];
      if (!rawLevel) {
        main.append(el("p", {}, ["No levels to play."]));
        return;
      }
      // Design mode edits/shows the real ids; Play mode is the only place
      // a map's disabled ingredients (e.g. Map 1's bun) actually disappear.
      const level = toPlayableLevelConfig(parsed, rawLevel);
      playView = new PlayView(main, parsed, level, (id) => {
        playLevelId = id;
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

function resetDraft(): void {
  if (!confirm("Discard the local draft and reload the bundled snapshot?")) return;
  localStorage.removeItem(DRAFT_KEY);
  map = structuredClone(MAP1_DATA);
  dataOrigin = "bundled Map 1 snapshot";
  void render();
}

function switchMode(next: Mode): void {
  if (mode === "design" && designView?.isDirty) {
    if (!confirm("Some sections have unsaved changes. Leave Design mode anyway?")) return;
  }
  mode = next;
  void render();
}

async function reloadFromSheet(): Promise<void> {
  if (designView?.isDirty && !confirm("Unsaved changes will be overwritten. Reload?")) return;
  dataOrigin = "loading from Google Sheet…";
  await render();
  try {
    const project = await new GoogleSheetCsvSource().loadProject();
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
        queueString: serializeQueues(l.queues),
        gridString: serializeGrid(l.grid),
        customerString: serializeCustomers(l.customers),
      })),
    };
    saveDraft();
    dataOrigin = "live Google Sheet";
  } catch (err) {
    console.error(err);
    dataOrigin = `sheet load failed (${(err as Error).message}) — bundled snapshot`;
  }
  await render();
}

window.addEventListener("beforeunload", (e) => {
  if (designView?.isDirty) e.preventDefault();
});

// Best-effort: pull the latest data from the sheet on every open. Falls back
// to the local draft/bundled snapshot (already rendered by reloadFromSheet's
// own first render()) if the sheet is unreachable.
void reloadFromSheet();

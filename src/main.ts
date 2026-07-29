import "./style.css";
import "./core/effects.ts"; // register built-in behaviors once
import {
  serializeCustomers,
  serializeGrid,
  serializeQueues,
} from "./core/parser.ts";
import { toMapDef } from "./data/mapLoader.ts";
import type { MapData } from "./data/mapLoader.ts";
import { GLOBAL_DEFS, MAP1_DATA } from "./data/configLoader.ts";
import { exportProjectCsv, GoogleSheetCsvSource, SHEET_ID } from "./data/sheetSource.ts";
import { DesignView } from "./ui/design/index.ts";
import { PlayView } from "./ui/play/index.ts";
import { button, el } from "./ui/dom.ts";

type Mode = "design" | "play";

const app = document.querySelector<HTMLDivElement>("#app")!;
const DRAFT_KEY = "cookorder-draft-map";
/**
 * Bump whenever the stored shape changes. Drafts outlive schema changes, so a
 * stale one must be migrated rather than loaded blindly — restoring a draft
 * that predates the cooking-tool model left the page blank.
 */
const DRAFT_VERSION = 2;

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
    candidate.rawIngredients?.every((r) => typeof r.numSlices === "number");
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

function render(): void {
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
        title: "Re-read the linked Google Sheet (read-only)",
      }),
      button("⬇ Export CSV", () => exportProjectCsv([map]), {
        title: "Download levels + definitions as CSV",
      }),
      button("♻ Reset draft", () => {
        if (!confirm("Discard the local draft and reload the bundled snapshot?")) return;
        localStorage.removeItem(DRAFT_KEY);
        map = structuredClone(MAP1_DATA);
        dataOrigin = "bundled Map 1 snapshot";
        render();
      }),
    ]),
  ]);

  const main = el("main", {});
  app.replaceChildren(header, main);

  // A view that throws must not leave an empty page with no way out.
  try {
    if (mode === "design") {
      designView = new DesignView(main, map, GLOBAL_DEFS, saveDraft);
    } else {
      const parsed = toMapDef(map);
      const level = parsed.levels.find((l) => l.id === playLevelId) ?? parsed.levels[0];
      if (!level) {
        main.append(el("p", {}, ["No levels to play."]));
        return;
      }
      playView = new PlayView(main, parsed, level, (id) => {
        playLevelId = id;
        render();
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

function switchMode(next: Mode): void {
  if (mode === "design" && designView?.isDirty) {
    if (!confirm("Some sections have unsaved changes. Leave Design mode anyway?")) return;
  }
  mode = next;
  render();
}

async function reloadFromSheet(): Promise<void> {
  if (designView?.isDirty && !confirm("Unsaved changes will be overwritten. Reload?")) return;
  dataOrigin = "loading from Google Sheet…";
  render();
  try {
    const project = await new GoogleSheetCsvSource().loadProject();
    const fresh = project.maps[0];
    map = {
      ...map,
      levels: fresh.levels.map((l, i) => ({
        ...map.levels[i],
        id: l.id,
        name: l.name,
        weather: l.weather,
        levelTag: l.levelTag,
        featureUnlock: l.featureUnlock,
        gridWidth: l.gridWidth,
        gridHeight: l.gridHeight,
        serveableSlots: l.serveableSlots,
        dirtyStackHeight: l.dirtyStackHeight,
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
  render();
}

window.addEventListener("beforeunload", (e) => {
  if (designView?.isDirty) e.preventDefault();
});

render();

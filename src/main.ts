import "./style.css";
import "./core/effects.ts"; // register built-in behaviors once
import {
  serializeCustomers,
  serializeGrid,
  serializeQueues,
} from "./core/parser.ts";
import { toMapDef } from "./data/mapLoader.ts";
import type { MapData } from "./data/mapLoader.ts";
import { GLOBAL_DEFS, MAP1_DATA } from "./data/initialData.ts";
import { exportProjectCsv, GoogleSheetCsvSource, SHEET_ID } from "./data/sheetSource.ts";
import { DesignView } from "./ui/design/index.ts";
import { PlayView } from "./ui/play/index.ts";
import { button, el } from "./ui/dom.ts";

type Mode = "design" | "play";

const app = document.querySelector<HTMLDivElement>("#app")!;
const DRAFT_KEY = "cookorder-draft-map";

/** Working copy the editors mutate; CSV export writes exactly this. */
let map: MapData = loadDraft() ?? structuredClone(MAP1_DATA);
let mode: Mode = "design";
let dataOrigin = loadDraft() ? "local draft" : "bundled Map 1 snapshot";
let playLevelId = map.levels[0]?.id ?? 1;
let playView: PlayView | null = null;
let designView: DesignView | null = null;

function loadDraft(): MapData | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? (JSON.parse(raw) as MapData) : null;
  } catch {
    return null;
  }
}

function saveDraft(): void {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(map));
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

  if (mode === "design") {
    designView = new DesignView(main, map, GLOBAL_DEFS, saveDraft);
  } else {
    const parsed = toMapDef(map);
    const level = parsed.levels.find((l) => l.id === playLevelId) ?? parsed.levels[0];
    if (!level) {
      main.append(el("p", {}, ["No levels to play."]));
      return;
    }
    try {
      playView = new PlayView(main, parsed, level, (id) => {
        playLevelId = id;
        render();
      });
    } catch (err) {
      main.append(
        el("div", { class: "warnings" }, [`Cannot start level: ${(err as Error).message}`]),
      );
    }
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

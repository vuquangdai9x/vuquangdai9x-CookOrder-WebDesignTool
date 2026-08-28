// "Change avatar" — a modal picker over the customer catalog, grouped into
// foldouts by Base Map. The current level's map opens expanded (the designer
// is steered toward its own cast); every other map's foldout starts
// collapsed but is still fully browsable — nothing here limits a pick to the
// current map, it's just the default focus.

import { pickerGrid } from "../contextMenu.ts";
import { button, el } from "../dom.ts";
import { iconEl } from "../icon.ts";
import { customerAvatarIconSpec } from "../customerAvatar.ts";
import type { CustomerCatalogEntry } from "../../data/customerCatalog.ts";

export interface CustomerAvatarDialogOptions {
  catalog: CustomerCatalogEntry[];
  /** The open level's map id (e.g. "burger") — whose foldout starts expanded. */
  currentBaseMap: string;
  selectedIndex: number | undefined;
  onPick: (catalogIndex: number | undefined) => void;
}

/** Base Map values in ascending MapIndex order (the catalog's own authored order), then "" (unassigned) last. */
function groupOrder(catalog: CustomerCatalogEntry[]): string[] {
  const minIndexOf = new Map<string, number>();
  for (const e of catalog) {
    if (e.baseMap === "") continue;
    const cur = minIndexOf.get(e.baseMap);
    if (cur === undefined || e.mapIndex < cur) minIndexOf.set(e.baseMap, e.mapIndex);
  }
  const out = [...minIndexOf.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
  if (catalog.some((e) => e.baseMap === "")) out.push("");
  return out;
}

export function openCustomerAvatarDialog(opts: CustomerAvatarDialogOptions): void {
  const close = () => overlay.remove();

  const selectedEntry = opts.catalog.find((entry) => entry.index === opts.selectedIndex);
  const detailName = el("strong", { class: "avatar-hover-name" });
  const detailDesc = el("span", { class: "avatar-hover-desc" });
  const detail = el("div", { class: "avatar-hover-detail", "aria-live": "polite" }, [detailName, detailDesc]);
  const showDetail = (entry: CustomerCatalogEntry | undefined) => {
    detail.classList.toggle("empty", !entry);
    detailName.textContent = entry?.name || (entry ? entry.id : "Hover an avatar");
    detailDesc.textContent = entry?.desc || (entry ? "No description yet." : "See their name and description here.");
  };
  showDetail(selectedEntry);

  const groups = groupOrder(opts.catalog);
  const sections = groups.map((baseMap) => {
    const rows = opts.catalog.filter((e) => e.baseMap === baseMap);
    const isCurrent = baseMap === opts.currentBaseMap;
    const grid = pickerGrid(
      rows.map((entry) => ({
        id: entry.index,
        label: entry.name || `#${entry.index}${entry.type ? ` (${entry.type})` : ""}`,
        icon: iconEl(customerAvatarIconSpec(entry), { size: 64 }),
      })),
      (catalogIndex) => {
        opts.onPick(catalogIndex);
        close();
      },
      opts.selectedIndex,
      (catalogIndex) => {
        const entry = catalogIndex === null
          ? selectedEntry
          : opts.catalog.find((candidate) => candidate.index === catalogIndex);
        showDetail(entry);
      },
    );
    return el("details", { class: "avatar-map-group", ...(isCurrent ? { open: "" } : {}) }, [
      el("summary", {}, [baseMap || "Unassigned", ` (${rows.length})`]),
      grid,
    ]);
  });

  const panel = el("div", { class: "avatar-dialog-panel" }, [
    button(
      "Random (clear pin)",
      () => {
        opts.onPick(undefined);
        close();
      },
      { class: "full-btn", title: "Unpin — Play mode shows a random Normal-type customer from this level's map" },
    ),
    detail,
    ...sections,
  ]);

  const overlay = el("div", { class: "overlay-panel" }, [
    el("div", { class: "definitions-head" }, [
      el("h2", {}, ["Change Avatar"]),
      button("✕ Close", close, { class: "primary" }),
    ]),
    panel,
  ]);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  document.body.append(overlay);
}

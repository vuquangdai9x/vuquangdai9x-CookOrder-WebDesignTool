import type { LevelData } from "../../data/mapLoader.ts";
import {
  GeneratorSheetConflictError,
  GoogleLevelSheetGateway,
  applyRecoveredGeneratorData,
  encodeCustomerGeneratorData,
  recoverGeneratorSheetValues,
  type GeneratorSheetSnapshot,
  type GeneratorSheetUpdate,
} from "../../data/generatorPersistence/index.ts";
import { remoteLevelValue } from "../../data/levelCompression.ts";
import { showContextMenu } from "../contextMenu.ts";
import { button, el } from "../dom.ts";

export type GeneratorDataStatus = "Local" | "Synced" | "Changed" | "Conflict" | "Stale" | "No row";

export interface GeneratorDataControllerOptions {
  gateway: GoogleLevelSheetGateway;
  onChanged(): void;
  openRemoteData(): void;
}

function showGeneratorNotice(message: string, tone: "ok" | "error" = "ok"): void {
  document.querySelector(".generator-data-notice")?.remove();
  const notice = el("div", { class: `generator-data-notice ${tone}`, role: tone === "error" ? "alert" : "status" }, [
    el("span", {}, [message]),
    button("Dismiss", () => notice.remove()),
  ]);
  document.body.append(notice);
  window.setTimeout(() => notice.remove(), 8_000);
}

function confirmGeneratorAction(title: string, message: string, confirmLabel: string): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (accepted: boolean) => {
      overlay.remove();
      resolve(accepted);
    };
    const overlay = el("div", { class: "overlay-panel generator-confirm-overlay", role: "presentation" });
    const dialog = el("section", { class: "generator-confirm-dialog", role: "dialog", "aria-modal": "true", "aria-label": title }, [
      el("h3", {}, [title]),
      el("pre", {}, [message]),
      el("div", { class: "qf-actions" }, [
        button("Cancel", () => finish(false)),
        button(confirmLabel, () => finish(true), { class: "primary" }),
      ]),
    ]);
    overlay.append(dialog);
    overlay.addEventListener("click", (event) => { if (event.target === overlay) finish(false); });
    document.body.append(overlay);
    (dialog.querySelector("button") as HTMLButtonElement | null)?.focus();
  });
}

function localUpdate(level: LevelData): Required<Pick<GeneratorSheetUpdate,
  "ingredientWeights" | "customerGeneratorData" | "queuePhaseData" | "pickupPhaseData" | "randomSeed" | "customerPhaseData">> {
  return {
    ingredientWeights: level.ingredientWeights ?? "",
    customerGeneratorData: level.customerGeneratorData?.startsWith("gw2_")
      ? level.customerGeneratorData
      : encodeCustomerGeneratorData(level),
    queuePhaseData: level.queuePhaseData ?? "",
    pickupPhaseData: level.pickupPhaseData ?? "",
    randomSeed: level.randomSeed === undefined ? "" : String(level.randomSeed),
    customerPhaseData: level.customerPhaseData ?? "",
  };
}

export class GeneratorDataController {
  private snapshots = new Map<string, GeneratorSheetSnapshot>();
  private forcedStatus = new Map<string, GeneratorDataStatus>();

  constructor(private readonly options: GeneratorDataControllerOptions) {}

  private key(mapId: string, level: LevelData): string { return `${mapId}:${level.id}`; }

  status(mapId: string, level: LevelData): GeneratorDataStatus {
    const key = this.key(mapId, level);
    const forced = this.forcedStatus.get(key);
    if (forced) return forced;
    const snapshot = this.snapshots.get(key);
    if (!snapshot) return "Local";
    if (snapshot.rowNumber === null) return "No row";
    const local = localUpdate(level);
    return Object.entries(local).every(([field, value]) => snapshot.values[field as keyof typeof local] === value)
      ? "Synced" : "Changed";
  }

  createButton(mapId: string, level: LevelData): HTMLButtonElement {
    const control = button(`☁ Generator Data: ${this.status(mapId, level)} ▾`, (event) => {
      showContextMenu(event, [
        { label: "Recover Generator Data from Sheet…", onSelect: () => void this.recover(mapId, level) },
        { label: "Save Generator Data to Sheet…", onSelect: () => void this.save(mapId, level) },
        { label: "Save Queue Phase…", onSelect: () => void this.savePhase(mapId, level, "queuePhaseData") },
        { label: "Save Pickup Phase…", onSelect: () => void this.savePhase(mapId, level, "pickupPhaseData") },
        { label: "Save Customer Phase…", onSelect: () => void this.savePhase(mapId, level, "customerPhaseData") },
        { label: "Compare with Sheet", onSelect: () => void this.compare(mapId, level), separator: true },
        { label: "Open Remote Data", onSelect: this.options.openRemoteData },
      ], { title: "Generator Data" });
    });
    control.title = "Explicitly save, compare, or recover generator vectors and artifacts";
    return control;
  }

  private async snapshot(mapId: string, level: LevelData, fresh: boolean): Promise<GeneratorSheetSnapshot> {
    const snapshot = await this.options.gateway.loadGeneratorData(mapId, level.id, fresh);
    this.snapshots.set(this.key(mapId, level), snapshot);
    this.forcedStatus.delete(this.key(mapId, level));
    return snapshot;
  }

  private async recover(mapId: string, level: LevelData): Promise<void> {
    try {
      const snapshot = await this.snapshot(mapId, level, true);
      if (snapshot.rowNumber === null) {
        this.forcedStatus.set(this.key(mapId, level), "No row");
        showGeneratorNotice("No writable sheet row exists for this Map/Level. Open Remote Data to inspect the mapping.", "error");
        return;
      }
      const recovered = recoverGeneratorSheetValues(level, snapshot.values);
      const summary = [
        `Unified workspace: ${recovered.workspace ? "available" : "empty"}`,
        `Customer setup: ${recovered.customer ? "available" : "empty"}`,
        `Queue phase: ${recovered.queue?.artifact?.status ?? (recovered.queue ? "vector only" : "empty")}`,
        `Pickup phase: ${recovered.pickup?.artifact?.status ?? (recovered.pickup ? "vector only" : "empty")}`,
        `Customer phase: ${recovered.customers?.artifact?.status ?? (recovered.customers ? "vector only" : "empty")}`,
        ...recovered.warnings,
      ].join("\n");
      if (!await confirmGeneratorAction(
        `Recover generator data from row ${snapshot.rowNumber}?`,
        `${summary}\n\nPlayable level strings will not change.`,
        "Recover",
      )) return;
      level.ingredientWeights = snapshot.values.ingredientWeights || undefined;
      if (snapshot.values.randomSeed.trim() === "") delete level.randomSeed;
      else level.randomSeed = Math.max(0, Math.trunc(Number(snapshot.values.randomSeed) || 0)) >>> 0;
      applyRecoveredGeneratorData(level, recovered);
      level.author = snapshot.values.author || null;
      const stale = [recovered.queue, recovered.pickup, recovered.customers]
        .some((phase) => phase?.vector.status === "stale" || phase?.artifact?.status === "stale");
      if (stale) this.forcedStatus.set(this.key(mapId, level), "Stale");
      else this.forcedStatus.delete(this.key(mapId, level));
      this.options.onChanged();
      showGeneratorNotice("Generator data recovered. Playable level strings were not changed.");
    } catch (error) {
      showGeneratorNotice(`Recover failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }

  private async save(mapId: string, level: LevelData): Promise<void> {
    try {
      const expected = this.snapshots.get(this.key(mapId, level)) ?? await this.snapshot(mapId, level, true);
      if (expected.rowNumber === null) throw new Error("No sheet row exists for this Map/Level.");
      const update = localUpdate(level);
      const sizes = Object.entries(update).map(([key, value]) => `${key}: ${value.length.toLocaleString()} chars`).join("\n");
      if (!await confirmGeneratorAction(
        `Save generator data to sheet row ${expected.rowNumber}?`,
        `${sizes}\n\nCanonical Customers/Grid/Queues are not included.`,
        "Save to Sheet",
      )) return;
      const saved = await this.options.gateway.saveGeneratorData(mapId, level.id, expected, update);
      level.customerGeneratorData = update.customerGeneratorData;
      level.author = saved.values.author || null;
      this.snapshots.set(this.key(mapId, level), saved);
      this.forcedStatus.delete(this.key(mapId, level));
      this.options.onChanged();
      showGeneratorNotice("Generator data saved to Google Sheets.");
    } catch (error) {
      if (error instanceof GeneratorSheetConflictError) this.forcedStatus.set(this.key(mapId, level), "Conflict");
      showGeneratorNotice(`Save failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }

  private async savePhase(
    mapId: string,
    level: LevelData,
    field: "queuePhaseData" | "pickupPhaseData" | "customerPhaseData",
  ): Promise<void> {
    if (!level[field]) {
      showGeneratorNotice(`There is no local ${field} to save.`, "error");
      return;
    }
    try {
      const expected = this.snapshots.get(this.key(mapId, level)) ?? await this.snapshot(mapId, level, true);
      const saved = await this.options.gateway.saveGeneratorData(mapId, level.id, expected, { [field]: level[field] });
      this.snapshots.set(this.key(mapId, level), saved);
      this.options.onChanged();
      showGeneratorNotice(`${field} saved to Google Sheets.`);
    } catch (error) {
      if (error instanceof GeneratorSheetConflictError) this.forcedStatus.set(this.key(mapId, level), "Conflict");
      showGeneratorNotice(`Phase save failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }

  private async compare(mapId: string, level: LevelData): Promise<void> {
    try {
      const snapshot = await this.snapshot(mapId, level, true);
      if (snapshot.rowNumber === null) {
        showGeneratorNotice("No sheet row exists for this Map/Level.", "error");
        return;
      }
      const local = localUpdate(level);
      const lines = Object.entries(local).map(([key, value]) => {
        const sheet = snapshot.values[key as keyof typeof local] ?? "";
        return `${value === sheet ? "✓" : "≠"} ${key}: local ${value.length}, sheet ${sheet.length}`;
      });
      // Include canonical hashes as a reminder that comparison/recovery does not write them.
      lines.push(`— playable queue: ${remoteLevelValue(level, "queueString").length} chars (not generator data)`);
      showGeneratorNotice(lines.join("\n"));
    } catch (error) {
      showGeneratorNotice(`Compare failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }
}

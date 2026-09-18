import { fetchGoogleAccountIdentity, requestAccessTokenInteractive } from "../googleAuth.ts";
import { canEmailWriteRemoteAuthor, pushedAuthorValue, remoteAuthorForTable } from "../remoteAuthors.ts";
import {
  fetchLevelProgressRows,
  SheetPermissionError,
  type LevelSheetRow,
  type RemoteSheetColumns,
  type RemoteSheetMapAliases,
} from "../sheetSource.ts";
import { batchUpdateCells, type CellUpdate } from "../sheetWrite.ts";
import type { GeneratorSheetSnapshot, GeneratorSheetUpdate, GeneratorSheetValues } from "./contracts.ts";

export interface LevelSheetGateway {
  loadGeneratorData(mapId: string, levelId: number, fresh?: boolean): Promise<GeneratorSheetSnapshot>;
  saveGeneratorData(
    mapId: string,
    levelId: number,
    expected: GeneratorSheetSnapshot,
    update: GeneratorSheetUpdate,
  ): Promise<GeneratorSheetSnapshot>;
}

export class GeneratorSheetConflictError extends Error {
  constructor(
    readonly expected: GeneratorSheetSnapshot,
    readonly actual: GeneratorSheetSnapshot,
  ) {
    super("Generator data changed in Google Sheets after it was loaded.");
    this.name = "GeneratorSheetConflictError";
  }
}

export class GeneratorSheetRowMissingError extends Error {
  constructor(mapId: string, levelId: number) {
    super(`No sheet row exists for ${mapId} level ${levelId}.`);
    this.name = "GeneratorSheetRowMissingError";
  }
}

export interface GoogleLevelSheetGatewayOptions {
  getSheetId: () => string;
  tabName: string;
  columns: RemoteSheetColumns;
  startRow: number;
  mapAliases?: RemoteSheetMapAliases;
}

interface GatewayDependencies {
  requestToken: typeof requestAccessTokenInteractive;
  fetchRows: typeof fetchLevelProgressRows;
  fetchIdentity: typeof fetchGoogleAccountIdentity;
  writeCells: typeof batchUpdateCells;
}

const defaults: GatewayDependencies = {
  requestToken: requestAccessTokenInteractive,
  fetchRows: fetchLevelProgressRows,
  fetchIdentity: fetchGoogleAccountIdentity,
  writeCells: batchUpdateCells,
};

const emptyValues = (): GeneratorSheetValues => ({
  ingredientWeights: "",
  customerGeneratorData: "",
  queuePhaseData: "",
  pickupPhaseData: "",
  randomSeed: "",
  customerPhaseData: "",
  author: "",
});

function valuesOf(row?: LevelSheetRow): GeneratorSheetValues {
  if (!row) return emptyValues();
  return {
    ingredientWeights: row.fields.ingredientWeights ?? "",
    customerGeneratorData: row.fields.customerDishesSequence ?? "",
    queuePhaseData: row.fields.complexityCurve ?? "",
    pickupPhaseData: row.fields.shuffleCurve ?? "",
    randomSeed: row.fields.randomSeed ?? "",
    customerPhaseData: row.fields.obstacleData ?? "",
    author: row.fields.author ?? "",
  };
}

function sameValues(a: GeneratorSheetValues, b: GeneratorSheetValues): boolean {
  return (Object.keys(a) as (keyof GeneratorSheetValues)[]).every((key) => a[key] === b[key]);
}

export class GoogleLevelSheetGateway implements LevelSheetGateway {
  private cache: Map<string, LevelSheetRow> | null = null;

  constructor(
    private readonly options: GoogleLevelSheetGatewayOptions,
    private readonly deps: GatewayDependencies = defaults,
  ) {}

  private key(mapId: string, levelId: number): string {
    return `map_config_${mapId}_lv_${levelId}`;
  }

  private async rows(fresh: boolean): Promise<Map<string, LevelSheetRow>> {
    if (!fresh && this.cache) return this.cache;
    const sheetId = this.options.getSheetId().trim();
    if (!sheetId) throw new Error("Paste a spreadsheet ID in Remote Data first.");
    const token = await this.deps.requestToken();
    this.cache = await this.deps.fetchRows(
      sheetId,
      token,
      this.options.tabName,
      this.options.columns,
      this.options.startRow,
      this.options.mapAliases,
    );
    return this.cache;
  }

  async loadGeneratorData(mapId: string, levelId: number, fresh = false): Promise<GeneratorSheetSnapshot> {
    const row = (await this.rows(fresh)).get(this.key(mapId, levelId));
    return { mapId, levelId, rowNumber: row?.rowNumber ?? null, values: valuesOf(row) };
  }

  private async assertWritePermission(): Promise<void> {
    const profile = remoteAuthorForTable(this.options.tabName);
    if (!profile) return;
    const token = await this.deps.requestToken();
    const account = await this.deps.fetchIdentity(token);
    if (!account.emailVerified || !canEmailWriteRemoteAuthor(profile, account.email)) {
      throw new SheetPermissionError(`${account.email} is not authorized to write ${this.options.tabName}`);
    }
  }

  async saveGeneratorData(
    mapId: string,
    levelId: number,
    expected: GeneratorSheetSnapshot,
    update: GeneratorSheetUpdate,
  ): Promise<GeneratorSheetSnapshot> {
    if (expected.mapId !== mapId || expected.levelId !== levelId) throw new Error("Expected sheet snapshot belongs to another level.");
    const actual = await this.loadGeneratorData(mapId, levelId, true);
    if (actual.rowNumber === null) throw new GeneratorSheetRowMissingError(mapId, levelId);
    if (expected.rowNumber !== actual.rowNumber || !sameValues(expected.values, actual.values)) {
      throw new GeneratorSheetConflictError(expected, actual);
    }
    await this.assertWritePermission();
    const author = update.author ?? pushedAuthorValue(this.options.tabName, actual.values.author);
    const next: GeneratorSheetValues = { ...actual.values, ...update, author };
    const physical: Record<keyof GeneratorSheetValues, keyof RemoteSheetColumns> = {
      ingredientWeights: "ingredientWeights",
      customerGeneratorData: "customerDishesSequence",
      queuePhaseData: "complexityCurve",
      pickupPhaseData: "shuffleCurve",
      randomSeed: "randomSeed",
      customerPhaseData: "obstacleData",
      author: "author",
    };
    const requested = new Set<keyof GeneratorSheetValues>([
      ...(Object.keys(update) as (keyof GeneratorSheetValues)[]),
      "author",
    ]);
    const updates: CellUpdate[] = [...requested].map((key) => ({
      row: actual.rowNumber!,
      col: this.options.columns[physical[key]],
      value: next[key],
    }));
    await this.deps.writeCells(this.options.getSheetId().trim(), this.options.tabName, updates);
    const rows = await this.rows(false);
    const row = rows.get(this.key(mapId, levelId));
    if (row) {
      for (const key of requested) row.fields[physical[key]] = next[key];
    }
    return { mapId, levelId, rowNumber: actual.rowNumber, values: next };
  }
}

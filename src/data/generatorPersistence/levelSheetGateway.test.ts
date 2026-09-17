import { describe, expect, it } from "vitest";
import type { LevelSheetRow, RemoteSheetColumns } from "../sheetSource.ts";
import type { CellUpdate } from "../sheetWrite.ts";
import { GeneratorSheetConflictError, GoogleLevelSheetGateway } from "./levelSheetGateway.ts";

const columns: RemoteSheetColumns = {
  map: 0, level: 1, ingredientWeights: 3, customerDishesSequence: 4,
  complexityCurve: 5, shuffleCurve: 6, randomSeed: 7, obstacleData: 8,
  customerString: 15, gridString: 16, queueString: 17,
  customerCompressed: 18, gridCompressed: 19, queuesCompressed: 20, author: 23,
};

const row = (queuePhase = "qfq1_old"): LevelSheetRow => ({
  rowNumber: 4,
  mapId: "burger",
  level: 1,
  fields: {
    ingredientWeights: "0:100",
    customerDishesSequence: "cg1_old",
    complexityCurve: queuePhase,
    shuffleCurve: "",
    randomSeed: "0",
    obstacleData: "",
    author: "",
  },
});

describe("GoogleLevelSheetGateway", () => {
  it("fresh-checks and writes the selected cells plus author in one batch", async () => {
    let current = row();
    const writes: CellUpdate[][] = [];
    const gateway = new GoogleLevelSheetGateway({
      getSheetId: () => "sheet",
      tabName: "Custom",
      columns,
      startRow: 4,
      mapAliases: { burger: "burger" },
    }, {
      requestToken: async () => "token",
      fetchIdentity: async () => ({ email: "designer@example.com", emailVerified: true }),
      fetchRows: async () => new Map([["map_config_burger_lv_1", structuredClone(current)]]),
      writeCells: async (_sheet, _tab, updates) => { writes.push(updates); },
    });
    const expected = await gateway.loadGeneratorData("burger", 1, true);
    const saved = await gateway.saveGeneratorData("burger", 1, expected, { queuePhaseData: "qfq1_new" });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual(expect.arrayContaining([
      { row: 4, col: 5, value: "qfq1_new" },
      { row: 4, col: 23, value: "" },
    ]));
    expect(saved.values.queuePhaseData).toBe("qfq1_new");
    current = row("server-change");
    await expect(gateway.saveGeneratorData("burger", 1, saved, { queuePhaseData: "another" }))
      .rejects.toBeInstanceOf(GeneratorSheetConflictError);
    expect(writes).toHaveLength(1);
  });
});

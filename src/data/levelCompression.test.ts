import { describe, expect, it } from "vitest";
import { compressLevelString, decompressLevelString, refreshLevelCompression, remoteGridString, remoteLevelPayload } from "./levelCompression.ts";
import { importLevelsCsv, parseLevelProgressRows, REMOTE_SHEET_COLUMNS } from "./sheetSource.ts";
import { applyRemoteField, applyRemoteFields, tryApplyRemoteFields } from "./remoteLevelFields.ts";
import type { LevelData } from "./mapLoader.ts";

const customers = "0;0;0;{c0:17.{g0:18.18.19}}#4|1;0;0;;3|0;60;1;{c1:24};;2";
const queues = "-1,1#4:5,0%0,0,1%1,7,1$0-0,1-0;0-1,0-2$1-1,2-1";
const level = (): LevelData => ({ id: 1, name: "Test", weather: "Normal", levelTag: "Normal",
  featureUnlock: "", shuffleDistance: 0, serveableSlots: 2, customerString: customers,
  queueString: queues, gridString: ",,,,,,,,," });

describe("compressed level exports", () => {
  it("preserves every saved customer and queue string losslessly using a safe ASCII alphabet", () => {
    const files = import.meta.glob("./config/nodegraph/maps/LevelData-*.csv", { eager: true, query: "?raw", import: "default" });
    let count = 0;
    for (const csv of Object.values(files)) {
      for (const entry of importLevelsCsv(csv as string)) {
        for (const source of [entry.customerString, entry.queueString]) {
          const compressed = compressLevelString(source);
          expect(compressed).toMatch(/^[A-Za-z0-9_-]*$/);
          expect(decompressLevelString(compressed)).toBe(source);
          count++;
        }
      }
    }
    expect(count).toBeGreaterThan(200);
  });

  it("round-trips empty columns, effects, nested quantities, identities, staff and UTF-8", () => {
    for (const source of [customers, queues, "%%", "", "Tiếng Việt 🍔"]) {
      expect(decompressLevelString(compressLevelString(source))).toBe(source);
    }
    expect(decompressLevelString(customers)).toBe(customers);
    expect(decompressLevelString(queues)).toBe(queues);
  });

  it("decodes fixed cross-language fixtures also tested in Unity", () => {
    expect(decompressLevelString("z1_M7AGwepkAytDc73qdCBloQdClrW1yiY1hmBZa-MaA2szA2tDoDpDKyOTWmtrIwA")).toBe(customers);
    expect(decompressLevelString("z1_DclBCgAgDAPBx9jeEkiKIuj__9WedmFoeO13oBQEp3HhEOepr3GxwtOiGw")).toBe(queues);
  });

  it("rejects malformed or unsupported encoded data", () => {
    for (const source of ["z1_", "z1_!", "z1_A", "z1_AA", "z1_%%%%", "z2_abc"]) {
      expect(() => decompressLevelString(source)).toThrow();
    }
  });

  it("refreshes stale export copies after edits without changing the Design strings", () => {
    const entry = level();
    refreshLevelCompression(entry);
    const previous = entry.customerCompressed;
    entry.customerString += "|0;0;0;{c1:24}";
    refreshLevelCompression(entry);
    expect(entry.customerCompressed).not.toBe(previous);
    expect(decompressLevelString(entry.customerCompressed!)).toBe(entry.customerString);
    expect(entry.queueString).toBe(queues);
    expect(entry.gridString).toBe(",,,,,,,,,");
  });

  it("exports a blank grid as empty and keeps all explicit statuses", () => {
    expect(remoteGridString(",,,,,,,,,")).toBe("");
    expect(remoteGridString(",#0,#1,")).toBe(",#0,#1,");
    const [customer, grid, queue] = remoteLevelPayload(level()).split("~");
    expect(decompressLevelString(customer)).toBe(customers);
    expect(grid).toBe("");
    expect(decompressLevelString(queue)).toBe(queues);
  });
});

describe("compressed sheet fields", () => {
  it("reads Customers/Grid/Queues-compressed from S/T/U by default and obeys column overrides", () => {
    const cells = new Array<string>(25).fill("");
    cells[0] = "1"; cells[1] = "1";
    cells[18] = compressLevelString(customers); cells[19] = "#0,,#1"; cells[20] = compressLevelString(queues);
    let fields = [...parseLevelProgressRows([cells]).values()][0].fields;
    expect(fields.customerCompressed).toBe(cells[18]);
    expect(fields.gridCompressed).toBe(cells[19]);
    expect(fields.queuesCompressed).toBe(cells[20]);
    fields = [...parseLevelProgressRows([cells], { ...REMOTE_SHEET_COLUMNS, customerCompressed: 22, queuesCompressed: 21 }).values()][0].fields;
    expect(fields.customerCompressed).toBe(cells[22]);
    expect(fields.queuesCompressed).toBe(cells[21]);
  });

  it("applies compressed-only rows and expands empty grids to the map size", () => {
    const entry = applyRemoteFields(level(), {
      customerCompressed: compressLevelString(customers), gridCompressed: "",
      queuesCompressed: compressLevelString(queues), gridString: "",
    }, 10);
    expect(entry.customerString).toBe(customers);
    expect(entry.queueString).toBe(queues);
    expect(entry.gridString).toBe(",,,,,,,,,");
  });

  it("applies a Grid-compressed value when the readable Grid cell is empty", () => {
    const entry = applyRemoteFields(level(), { gridCompressed: "#0,,#1" }, 3);
    expect(entry.gridString).toBe("#0,,#1");
  });

  it("preserves old readable sheet rows when compressed columns are empty", () => {
    const entry = applyRemoteFields(level(), { customerString: customers, queueString: queues }, 10);
    expect(entry.customerString).toBe(customers);
    expect(entry.queuesCompressed).toBe(compressLevelString(queues));
  });

  it("trusts the readable field and regenerates a mismatched compressed sheet cell instead of throwing", () => {
    const entry = applyRemoteFields(level(), {
      customerString: customers, customerCompressed: compressLevelString("0;0;0;{c1:24}"),
    }, 10);
    expect(entry.customerString).toBe(customers);
    expect(entry.customerCompressed).toBe(compressLevelString(customers));
  });

  it("repairs an invalid compressed companion when a readable field exists", () => {
    const entry = applyRemoteFields(level(), {
      customerString: customers,
      customerCompressed: "z1_not+base64url",
      queueString: queues,
      queuesCompressed: "z1_!",
    }, 10);
    expect(entry.customerString).toBe(customers);
    expect(entry.customerCompressed).toBe(compressLevelString(customers));
    expect(entry.queueString).toBe(queues);
    expect(entry.queuesCompressed).toBe(compressLevelString(queues));
  });

  it("still rejects an invalid (undecodable) compressed field on a direct single-field apply", () => {
    const entry = level();
    const before = structuredClone(entry);
    expect(() => applyRemoteField(entry, "queuesCompressed", "z1_!", 10)).toThrow();
    expect(entry).toEqual(before);
  });

  it("allows an individual compressed field to replace readable data", () => {
    const entry = level();
    const replacement = "0;0;0;{c1:24}";
    applyRemoteField(entry, "customerCompressed", compressLevelString(replacement), 10);
    expect(entry.customerString).toBe(replacement);
    expect(entry.queueString).toBe(queues);
  });

  it("clears numeric metadata on whole-level apply and preserves seed zero", () => {
    const entry = level();
    entry.randomSeed = 123;
    applyRemoteFields(entry, { customerString: customers, queueString: queues, randomSeed: "" }, 10);
    expect(entry.randomSeed).toBeUndefined();
    applyRemoteFields(entry, { customerString: customers, queueString: queues, randomSeed: "0" }, 10);
    expect(entry.randomSeed).toBe(0);
  });

  it("applies sheet author data and represents a blank author as null", () => {
    const entry = level();
    applyRemoteField(entry, "author", "tantd", 10);
    expect(entry.author).toBe("tantd");
    applyRemoteField(entry, "author", "", 10);
    expect(entry.author).toBeNull();
  });

  it("lets a bulk caller skip a malformed customer row without changing its level", () => {
    const entry = level();
    const before = structuredClone(entry);
    const result = tryApplyRemoteFields(entry, { customerCompressed: "0;0;0;1", queueString: queues }, 10);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('Expected "{" at position 0 in "1"');
    expect(entry).toEqual(before);
  });
});

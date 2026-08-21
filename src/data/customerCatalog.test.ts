import { describe, expect, it } from "vitest";
import { getCustomerCatalog, parseCustomersCsv, serializeCustomersCsv } from "./customerCatalog.ts";
import type { CustomerCatalogEntry } from "./customerCatalog.ts";

const entry = (over: Partial<CustomerCatalogEntry> = {}): CustomerCatalogEntry => ({
  index: 0,
  id: "0",
  name: "",
  desc: "",
  type: "",
  baseMap: "",
  mapIndex: 0,
  fileId: "",
  icon: "",
  ...over,
});

describe("parseCustomersCsv", () => {
  it("parses a header row plus data rows, skipping the blank spacer column between FileID and Icon", () => {
    const csv = "Index,Id,Name,Desc,Type,BaseMap,MapIndex,FileID,,Icon\n0,dog_boy,Bob,a regular,Normal,burger,1,abc123,,🙂";
    expect(parseCustomersCsv(csv)).toEqual([
      entry({ index: 0, id: "dog_boy", name: "Bob", desc: "a regular", type: "Normal", baseMap: "burger", mapIndex: 1, fileId: "abc123", icon: "🙂" }),
    ]);
  });

  it("accepts a CSV with no header row", () => {
    const csv = "5,rat_red,,,Shipper,burger,1,,,";
    expect(parseCustomersCsv(csv)).toEqual([entry({ index: 5, id: "rat_red", type: "Shipper", baseMap: "burger", mapIndex: 1 })]);
  });

  it("returns an empty roster for blank input", () => {
    expect(parseCustomersCsv("")).toEqual([]);
    expect(parseCustomersCsv("   \n  ")).toEqual([]);
  });
});

describe("serializeCustomersCsv", () => {
  it("round-trips through parseCustomersCsv", () => {
    const entries = [
      entry({ index: 0, id: "dog_boy", name: "Bob", type: "Normal", baseMap: "burger", mapIndex: 1 }),
      entry({ index: 1, id: "pig_boss", name: "Boss, the Boss", type: "Boss", baseMap: "", mapIndex: 0 }),
    ];
    expect(parseCustomersCsv(serializeCustomersCsv(entries))).toEqual(entries);
  });

  it("writes a header row, including the blank spacer column", () => {
    expect(serializeCustomersCsv([])).toBe("Index,Id,Name,Desc,Type,BaseMap,MapIndex,FileID,,Icon");
  });

  it("writes the spacer column as a real, empty cell (a redundant-looking comma preserved on purpose)", () => {
    const csv = serializeCustomersCsv([entry({ index: 0, id: "dog_boy", fileId: "abc123" })]);
    const [, dataLine] = csv.split("\r\n");
    // Index,Id,Name,Desc,Type,BaseMap,MapIndex,FileID,<spacer>,Icon
    expect(dataLine.split(",")).toEqual(["0", "dog_boy", "", "", "", "", "0", "abc123", "", ""]);
  });
});

describe("getCustomerCatalog", () => {
  it("loads the bundled catalog by default", () => {
    const catalog = getCustomerCatalog();
    expect(catalog.length).toBeGreaterThan(0);
    expect(catalog.every((e) => e.id !== "")).toBe(true);
    expect(catalog.every((e) => e.mapIndex > 0)).toBe(true);
  });

  it("includes at least one Boss for every map", () => {
    const catalog = getCustomerCatalog();
    for (const baseMap of new Set(catalog.map((e) => e.baseMap))) {
      expect(catalog.some((e) => e.baseMap === baseMap && e.type === "Boss")).toBe(true);
    }
  });
});

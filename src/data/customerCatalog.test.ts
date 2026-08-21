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
  fileId: "",
  icon: "",
  ...over,
});

describe("parseCustomersCsv", () => {
  it("parses a header row plus data rows", () => {
    const csv = "Index,Id,Name,Desc,Type,BaseMap,FileID,Icon\n0,0,Bob,a regular,Normal,burger,abc123,🙂";
    expect(parseCustomersCsv(csv)).toEqual([
      entry({ index: 0, id: "0", name: "Bob", desc: "a regular", type: "Normal", baseMap: "burger", fileId: "abc123", icon: "🙂" }),
    ]);
  });

  it("accepts a CSV with no header row", () => {
    const csv = "5,5,,,Shipper,burger,,";
    expect(parseCustomersCsv(csv)).toEqual([entry({ index: 5, id: "5", type: "Shipper", baseMap: "burger" })]);
  });

  it("returns an empty roster for blank input", () => {
    expect(parseCustomersCsv("")).toEqual([]);
    expect(parseCustomersCsv("   \n  ")).toEqual([]);
  });
});

describe("serializeCustomersCsv", () => {
  it("round-trips through parseCustomersCsv", () => {
    const entries = [
      entry({ index: 0, id: "0", name: "Bob", type: "Normal", baseMap: "burger" }),
      entry({ index: 1, id: "1", name: "Boss, the Boss", type: "Boss", baseMap: "" }),
    ];
    expect(parseCustomersCsv(serializeCustomersCsv(entries))).toEqual(entries);
  });

  it("writes a header row", () => {
    expect(serializeCustomersCsv([])).toBe("Index,Id,Name,Desc,Type,BaseMap,FileID,Icon");
  });
});

describe("getCustomerCatalog", () => {
  it("loads the bundled catalog by default, including the migrated pet rows", () => {
    const catalog = getCustomerCatalog();
    expect(catalog.length).toBeGreaterThan(0);
    expect(catalog.every((e) => e.id !== "")).toBe(true);
    const pets = catalog.filter((e) => e.name.startsWith("Pet "));
    expect(pets).toHaveLength(3);
    expect(pets.every((e) => e.type === "Normal" && e.baseMap === "burger")).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { customerAvatarLocalPath, mapIndexOfBaseMap, randomNormalCustomer } from "./customerAvatar.ts";
import type { CustomerCatalogEntry } from "../data/customerCatalog.ts";

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

describe("mapIndexOfBaseMap", () => {
  it("resolves the bundled maps' own ids to their graph index", () => {
    expect(mapIndexOfBaseMap("burger")).toBe(1);
    expect(mapIndexOfBaseMap("coffee")).toBe(2);
    expect(mapIndexOfBaseMap("sushi")).toBe(3);
  });

  it("returns undefined for an unknown base map", () => {
    expect(mapIndexOfBaseMap("donut")).toBeUndefined();
    expect(mapIndexOfBaseMap("")).toBeUndefined();
  });
});

describe("customerAvatarLocalPath", () => {
  it("builds the customer-map<index>-<id> convention path", () => {
    expect(customerAvatarLocalPath(entry({ id: "24", baseMap: "burger" }))).toBe("customers/customer-map1-24.png");
  });

  it("is undefined when the base map or id is missing", () => {
    expect(customerAvatarLocalPath(entry({ id: "24", baseMap: "" }))).toBeUndefined();
    expect(customerAvatarLocalPath(entry({ id: "", baseMap: "burger" }))).toBeUndefined();
  });
});

describe("randomNormalCustomer", () => {
  const catalog = [
    entry({ index: 0, baseMap: "burger", type: "Normal" }),
    entry({ index: 1, baseMap: "burger", type: "" }),
    entry({ index: 2, baseMap: "burger", type: "Shipper" }),
    entry({ index: 3, baseMap: "coffee", type: "Normal" }),
  ];

  it("only picks from the given map's Normal (or blank-type) rows", () => {
    for (let i = 0; i < 20; i++) {
      const pick = randomNormalCustomer(catalog, "burger", () => i / 20);
      expect(pick?.baseMap).toBe("burger");
      expect(["Normal", ""]).toContain(pick?.type);
    }
  });

  it("returns undefined when the map has no Normal-type rows", () => {
    expect(randomNormalCustomer(catalog, "sushi")).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { customerAvatarLocalPath, randomNormalCustomer } from "./customerAvatar.ts";
import type { CustomerCatalogEntry } from "../data/customerCatalog.ts";

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

describe("customerAvatarLocalPath", () => {
  it("uses the customer-map<mapIndex>-<id> convention for Normal (and blank-type) rows", () => {
    expect(customerAvatarLocalPath(entry({ id: "dog_boy", mapIndex: 1, type: "Normal" }))).toBe("customers/customer-map1-dog_boy.png");
    expect(customerAvatarLocalPath(entry({ id: "dog_boy", mapIndex: 1, type: "" }))).toBe("customers/customer-map1-dog_boy.png");
  });

  it("uses the shipper-map<mapIndex>-<id> convention for Type=Shipper", () => {
    expect(customerAvatarLocalPath(entry({ id: "rat_red", mapIndex: 1, type: "Shipper" }))).toBe("customers/shipper-map1-rat_red.png");
  });

  it("uses the boss-map<mapIndex>-<id> convention for Type=Boss", () => {
    expect(customerAvatarLocalPath(entry({ id: "pig_boss", mapIndex: 1, type: "Boss" }))).toBe("customers/boss-map1-pig_boss.png");
  });

  it("matches Type case-insensitively", () => {
    expect(customerAvatarLocalPath(entry({ id: "rat_red", mapIndex: 1, type: "shipper" }))).toBe("customers/shipper-map1-rat_red.png");
    expect(customerAvatarLocalPath(entry({ id: "pig_boss", mapIndex: 1, type: "BOSS" }))).toBe("customers/boss-map1-pig_boss.png");
  });

  it("uses the authored mapIndex directly, not one inferred from baseMap", () => {
    expect(customerAvatarLocalPath(entry({ id: "beaver", mapIndex: 2, baseMap: "coffee" }))).toBe("customers/customer-map2-beaver.png");
  });

  it("is undefined when mapIndex or id is missing", () => {
    expect(customerAvatarLocalPath(entry({ id: "dog_boy", mapIndex: 0 }))).toBeUndefined();
    expect(customerAvatarLocalPath(entry({ id: "", mapIndex: 1 }))).toBeUndefined();
  });
});

describe("randomNormalCustomer", () => {
  const catalog = [
    entry({ index: 0, baseMap: "burger", mapIndex: 1, type: "Normal" }),
    entry({ index: 1, baseMap: "burger", mapIndex: 1, type: "" }),
    entry({ index: 2, baseMap: "burger", mapIndex: 1, type: "Shipper" }),
    entry({ index: 3, baseMap: "coffee", mapIndex: 2, type: "Normal" }),
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

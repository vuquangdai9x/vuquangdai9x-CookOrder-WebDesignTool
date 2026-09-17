import type { LevelData } from "../mapLoader.ts";
import type { CustomerGeneratorSheetData } from "./contracts.ts";
import { decodeGeneratorPayload, encodeGeneratorPayload, withPayloadHash } from "./codec.ts";

export function customerGeneratorDataFromLevel(level: LevelData): CustomerGeneratorSheetData {
  return withPayloadHash({
    schemaVersion: 1 as const,
    kind: "customer-first-generator" as const,
    customerDishesSequence: level.customerDishesSequence,
    complexityCurve: level.complexityCurve,
    shuffleCurve: level.shuffleCurve,
    obstacleData: level.obstacleData,
    bagFill: level.bagFill,
  });
}

export function encodeCustomerGeneratorData(level: LevelData): string {
  return encodeGeneratorPayload(customerGeneratorDataFromLevel(level));
}

export function decodeCustomerGeneratorData(source: string): CustomerGeneratorSheetData {
  const value = decodeGeneratorPayload<CustomerGeneratorSheetData>(source, "customer-first-generator");
  if (value.bagFill !== undefined && !["min", "random", "max"].includes(value.bagFill)) {
    throw new Error("Invalid customer-first-generator payload: unsupported bagFill.");
  }
  return value;
}

export function applyCustomerGeneratorData(level: LevelData, data: CustomerGeneratorSheetData): void {
  const assign = (key: "customerDishesSequence" | "complexityCurve" | "shuffleCurve" | "obstacleData", value?: string) => {
    if (value === undefined || value === "") delete level[key];
    else level[key] = value;
  };
  assign("customerDishesSequence", data.customerDishesSequence);
  assign("complexityCurve", data.complexityCurve);
  assign("shuffleCurve", data.shuffleCurve);
  assign("obstacleData", data.obstacleData);
  if (data.bagFill) level.bagFill = data.bagFill;
  else delete level.bagFill;
  level.customerGeneratorData = encodeGeneratorPayload(data);
}

/** New envelope when present, otherwise a non-mutating in-memory legacy migration. */
export function readCustomerGeneratorData(level: LevelData): { data: CustomerGeneratorSheetData; legacy: boolean } {
  if (level.customerGeneratorData) return { data: decodeCustomerGeneratorData(level.customerGeneratorData), legacy: false };
  return { data: customerGeneratorDataFromLevel(level), legacy: true };
}

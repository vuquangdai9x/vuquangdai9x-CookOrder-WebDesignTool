import fs from "node:fs/promises";
import { Workbook } from "@oai/artifact-tool";

const sourcePath = "C:/Users/Admin/Downloads/CookOrder GDD New - Customers (3).csv";
const outputDir = "D:/daivq/ProjectCookOrder-WebGameLevelDesignTool/outputs/customer_metadata_20260828";
const csvText = await fs.readFile(sourcePath, "utf8");
const workbook = await Workbook.fromCSV(csvText, { sheetName: "Customers" });

const overview = await workbook.inspect({
  kind: "workbook,sheet,table",
  maxChars: 8000,
  tableMaxRows: 26,
  tableMaxCols: 12,
  tableMaxCellChars: 120,
});
console.log(overview.ndjson);

const style = await workbook.inspect({
  kind: "computedStyle",
  sheetId: "Customers",
  range: "A1:K8",
  maxChars: 4000,
});
console.log(style.ndjson);

const preview = await workbook.render({
  sheetName: "Customers",
  range: "A1:K24",
  scale: 1,
  format: "png",
});
await fs.writeFile(`${outputDir}/source-preview.png`, new Uint8Array(await preview.arrayBuffer()));

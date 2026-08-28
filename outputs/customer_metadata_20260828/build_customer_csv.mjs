import fs from "node:fs/promises";
import { Workbook } from "@oai/artifact-tool";

const sourcePath = "C:/Users/Admin/Downloads/CookOrder GDD New - Customers (3).csv";
const outputDir = "D:/daivq/ProjectCookOrder-WebGameLevelDesignTool/outputs/customer_metadata_20260828";
const outputPath = `${outputDir}/CookOrder_Customers_With_Names_Descriptions.csv`;

const customerCopy = {
  dog_boy: ["Benny Bark", "A loyal little diner who treats every burger like a tail-wagging treasure."],
  cat_chill: ["Coolcat Clyde", "Too cool to hurry and always orders with a perfectly timed purr."],
  bear_cute: ["Honey Hug Bear", "Sweet as honey and twice as cuddly when the fries arrive."],
  rabbit_cute: ["Bunbun Bella", "Bounces in hungry and leaves with crumbs on both cheeks."],
  cat_cute: ["Kitty Cupcake", "Tiny paws big appetite and absolutely no shame about extra cheese."],
  rat_red: ["Red Rat Courier", "The fastest red-tailed courier in town unless someone drops a fry."],
  pig_boss: ["Boss Hogsworth", "Runs the lunch rush like a boardroom and demands premium pickles."],
  beaver_logger: ["Brewster Beaver", "Can spot a strong brew faster than a falling timber."],
  cow_rebel: ["Mocha Moo Rebel", "Breaks cafe rules drinks bold roasts and never says moo softly."],
  squirrel_girl: ["Hazel Squirrel", "Carries emergency acorns and judges every latte by its foam."],
  tanuki_boy: ["Tobi Tanuki", "A cheerful trickster who somehow pays with leaves and perfect change."],
  skunk_socialite: ["Scent-sational Skunk", "Arrives fashionably scented and turns every coffee break into a gala."],
  bird_green: ["Greenwing Bird Courier", "Delivers coffee at wing speed while keeping every feather spotless."],
  bison_gentleman: ["Baron Bison", "A polished cafe boss who considers foam art serious business."],
  eagle_police: ["Chief Eagle", "Keeps the cafe orderly with eagle eyes and a badge-shaped cookie."],
  fox_lady: ["Kitsune Ojou", "A graceful kitsune guest who orders sushi with theatrical elegance."],
  koala_seifuku: ["Koala Senpai", "Studies the menu diligently but still trades lunch for eucalyptus."],
  goat_blue: ["Aoi Yagi", "This blue goat loves matcha and practices cheerful table manners."],
  lion_boy: ["Shishi-kun", "A brave little shishi who challenges every sushi roll to a duel."],
  wolf_yakuza: ["Ookami Oyabun", "The wolf oyabun speaks softly and controls the sushi counter with one stare."],
  shiba_sumo: ["Shiba Yokozuna", "A shiba yokozuna who treats every sushi platter like a championship bout."],
};

const csvText = await fs.readFile(sourcePath, "utf8");
const workbook = await Workbook.fromCSV(csvText, { sheetName: "Customers" });
const sheet = workbook.worksheets.getItem("Customers");
const used = sheet.getUsedRange();
const rows = used.values.map((row) => [...row]);

const ids = [];
for (let rowIndex = 3; rowIndex < rows.length; rowIndex += 1) {
  const id = String(rows[rowIndex][1] ?? "").trim();
  if (!id) continue;
  const copy = customerCopy[id];
  if (!copy) throw new Error(`Missing name/description for customer ID: ${id}`);
  rows[rowIndex][2] = copy[0];
  rows[rowIndex][3] = copy[1];
  ids.push(id);
}

const unusedIds = Object.keys(customerCopy).filter((id) => !ids.includes(id));
if (unusedIds.length) throw new Error(`Unused customer copy entries: ${unusedIds.join(", ")}`);
if (new Set(ids).size !== ids.length) throw new Error("Duplicate customer IDs found.");

rows[0][3] = ids.join(",");
sheet.getRange("A1:K24").values = rows;

sheet.showGridLines = false;
sheet.freezePanes.freezeRows(3);
sheet.getRange("A3:K3").format = {
  fill: "#7C3AED",
  font: { bold: true, color: "#FFFFFF" },
  horizontalAlignment: "center",
};
sheet.getRange("A4:K24").format.borders = {
  insideHorizontal: { style: "thin", color: "#E5E7EB" },
};
sheet.getRange("A1:K1").format = {
  fill: "#EDE9FE",
  font: { bold: true, color: "#4C1D95" },
};
sheet.getRange("C4:D24").format.wrapText = true;
sheet.getRange("A1:A24").format.columnWidth = 10;
sheet.getRange("B1:B24").format.columnWidth = 22;
sheet.getRange("C1:C24").format.columnWidth = 24;
sheet.getRange("D1:D24").format.columnWidth = 56;
sheet.getRange("E1:G24").format.columnWidth = 13;
sheet.getRange("H1:H24").format.columnWidth = 38;
sheet.getRange("I1:J24").format.columnWidth = 10;
sheet.getRange("K1:K24").format.columnWidth = 28;
sheet.getRange("A3:K24").format.autofitRows();

const wordCounts = rows.slice(3).map((row) => ({
  id: row[1],
  words: String(row[3]).trim().split(/\s+/).filter(Boolean).length,
}));
const tooLong = wordCounts.filter((entry) => entry.words >= 30);
if (tooLong.length) throw new Error(`Descriptions at or above 30 words: ${JSON.stringify(tooLong)}`);

const check = await workbook.inspect({
  kind: "table",
  range: "Customers!A1:K24",
  include: "values,formulas",
  tableMaxRows: 24,
  tableMaxCols: 11,
  tableMaxCellChars: 140,
  maxChars: 18000,
});
console.log(check.ndjson);

const errors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 100 },
  summary: "final formula error scan",
});
console.log(errors.ndjson);

const preview = await workbook.render({
  sheetName: "Customers",
  range: "A1:K24",
  scale: 1,
  format: "png",
});
await fs.writeFile(`${outputDir}/final-preview.png`, new Uint8Array(await preview.arrayBuffer()));

function csvEscape(value) {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const finalRows = sheet.getRange("A1:K24").values;
const finalCsv = finalRows.map((row) => row.map(csvEscape).join(",")).join("\r\n") + "\r\n";
await fs.writeFile(outputPath, `\uFEFF${finalCsv}`, "utf8");

console.log(JSON.stringify({
  outputPath,
  customers: ids.length,
  maxDescriptionWords: Math.max(...wordCounts.map((entry) => entry.words)),
  rosterMatchesRows: rows[0][3] === ids.join(","),
}));

// Converts the legacy Google Sheet formats into the tool's canonical string
// formats. See docs/SHEET_STRUCTURE.md for the legacy grammar.

/** Legacy grid cell "4#1#1" -> canonical "#4:1:1"; "1" -> "#1"; ""/"0" -> "". */
export function convertLegacyGridCell(cell: string): string {
  if (cell === "" || cell === "0") return "";
  return "#" + cell.split("#").join(":");
}

/** Legacy grid string (","-separated legacy cells) -> canonical grid string. */
export function convertLegacyGrid(s: string, cellCount: number): string {
  const cells = s === "" ? [] : s.split(",");
  while (cells.length < cellCount) cells.push("");
  return cells.slice(0, cellCount).map(convertLegacyGridCell).join(",");
}

/**
 * Legacy customer "delay;waitTime;completePrev;weatherEff;vip;recipes"
 * -> canonical "waitTime;weatherEff;dishes" (digit-run dishes -> '.'-separated).
 * The delay/completePrev/vip params were dropped from the game.
 */
export function convertLegacyCustomer(c: string): string {
  const p = c.split(";");
  if (p.length !== 6) throw new Error(`Bad legacy customer "${c}"`);
  const waitTime = p[1] === "" ? "0" : p[1];
  const weatherEff = p[3] === "" ? "0" : p[3];
  const dishes = p[5]
    .split(",")
    .map((d) => {
      const [run, ...effs] = d.split("#");
      const ids = run.includes(".") ? run : [...run].join(".");
      return ids + (effs.length ? "#" + effs.join("#") : "");
    })
    .join(",");
  return `${waitTime};${weatherEff};${dishes}`;
}

export interface LegacyLvConfig {
  customerCount: number;
  weather: string;
  levelTag: string;
  featureUnlock: string;
  gridString: string; // canonical
}

/**
 * Legacy LvConfig "count;weather;tag;feature;stars;tools;waitTimeScale;grid".
 * Star scores, the blank tools field, and waitTimeScale were dropped from the
 * game and are discarded here.
 */
export function convertLegacyLvConfig(lc: string, cellCount: number): LegacyLvConfig {
  const f = lc.split(";");
  if (f.length < 8) throw new Error(`Bad legacy LvConfig "${lc}"`);
  return {
    customerCount: Number(f[0]) || 0,
    weather: f[1] || "Normal",
    levelTag: f[2] ?? "",
    featureUnlock: f[3] ?? "",
    gridString: convertLegacyGrid(f.slice(7).join(";"), cellCount),
  };
}

/** Legacy queue config "queueString;shuffleDistance;". Queue string is already canonical. */
export function convertLegacyQueueConfig(qc: string): {
  queueString: string;
  shuffleDistance: number;
} {
  const f = qc.split(";");
  return { queueString: f[0] ?? "", shuffleDistance: Number(f[1]) || 0 };
}

/** Minimal CSV parser (quoted cells may contain commas/newlines). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQ = false;
      } else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

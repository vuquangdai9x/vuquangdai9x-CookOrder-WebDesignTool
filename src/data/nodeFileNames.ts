import type { NodeMapEntry } from "./nodeProject.ts";

export interface NodeDownloadNames {
  graphJson: string;
  graphCsv: string;
  graphPng: string;
  levelsCsv: string;
}

function safeName(value: string): string {
  return value
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "") || "Map";
}

/** Build filenames matching Graph-{index}-{Name} / LevelData-{index}-{Name}. */
export function nodeDownloadNames(
  entries: NodeMapEntry[],
  docId: string,
  mapName: string,
): NodeDownloadNames {
  const indexed = entries
    .map((entry) => {
      const match = /^Map\s+(\d+)\s+—\s+(.+)$/.exec(entry.name);
      return match ? { id: entry.id, index: Number(match[1]), name: match[2] } : null;
    })
    .filter((value): value is { id: string; index: number; name: string } => value !== null);
  const bundled = indexed.find((entry) => entry.id === docId);
  const custom = entries.filter((entry) => !indexed.some((known) => known.id === entry.id));
  const customOffset = Math.max(0, custom.findIndex((entry) => entry.id === docId));
  const index = bundled?.index ?? Math.max(0, ...indexed.map((entry) => entry.index)) + customOffset + 1;
  const name = safeName(bundled?.name ?? mapName);
  const stem = `${index}-${name}`;
  return {
    graphJson: `Graph-${stem}.json`,
    graphCsv: `Graph-${stem}.csv`,
    graphPng: `Graph-${stem}.png`,
    levelsCsv: `LevelData-${stem}.csv`,
  };
}

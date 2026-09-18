import type {
  GroupCoverageDiagnostic,
  GroupSizeCoverage,
  QueueArtifactGroup,
} from "./contracts.ts";
import type { LaidOutSlot } from "./queueLayout.ts";

interface Cell {
  x: number;
  y: number;
  id: string;
}

export interface GroupPlacementResult {
  groups: QueueArtifactGroup[];
  combinedCoverage: GroupCoverageDiagnostic[];
  linkedCoverage: GroupCoverageDiagnostic[];
  warnings: string[];
}

function shuffle<T>(values: T[], random: () => number): void {
  for (let i = values.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [values[i], values[j]] = [values[j], values[i]];
  }
}

const key = (cell: Pick<Cell, "x" | "y">): string => `${cell.x}:${cell.y}`;

function cellsOf(lanes: readonly LaidOutSlot[][]): Cell[] {
  return lanes.flatMap((lane, x) => lane.map((slot, y) => ({ x, y, id: slot.id })));
}

function straightCandidates(
  lanes: readonly LaidOutSlot[][],
  size: number,
  occupied: ReadonlySet<string>,
): Cell[][] {
  const candidates: Cell[][] = [];
  for (const start of cellsOf(lanes)) {
    for (const [dx, dy] of [[1, 0], [0, 1]] as const) {
      const run: Cell[] = [];
      for (let step = 0; step < size; step++) {
        const x = start.x + dx * step;
        const y = start.y + dy * step;
        const slot = lanes[x]?.[y];
        if (!slot || occupied.has(`${x}:${y}`)) break;
        run.push({ x, y, id: slot.id });
      }
      if (run.length === size) candidates.push(run);
    }
  }
  return candidates;
}

function linkedCandidates(
  lanes: readonly LaidOutSlot[][],
  size: number,
  occupied: ReadonlySet<string>,
): Cell[][] {
  const candidates: Cell[][] = [];
  const limitPerWindow = 4096;
  for (let startX = 0; startX <= lanes.length - size; startX++) {
    const choices = Array.from({ length: size }, (_, offset) => lanes[startX + offset]
      .map((slot, y) => ({ x: startX + offset, y, id: slot.id }))
      .filter((cell) => !occupied.has(key(cell))));
    if (choices.some((lane) => lane.length === 0)) continue;
    const path: Cell[] = [];
    let emitted = 0;
    const visit = (offset: number): void => {
      if (emitted >= limitPerWindow) return;
      if (offset === choices.length) {
        candidates.push([...path]);
        emitted++;
        return;
      }
      for (const cell of choices[offset]) {
        path.push(cell);
        visit(offset + 1);
        path.pop();
        if (emitted >= limitPerWindow) return;
      }
    };
    visit(0);
  }
  return candidates;
}

function placeKind(
  kind: "combined" | "linked",
  lanes: readonly LaidOutSlot[][],
  coverage: GroupSizeCoverage,
  occupied: Set<string>,
  random: () => number,
  groupPrefix: string,
): { groups: QueueArtifactGroup[]; diagnostics: GroupCoverageDiagnostic[]; warnings: string[] } {
  const total = lanes.reduce((sum, lane) => sum + lane.length, 0);
  const groups: QueueArtifactGroup[] = [];
  const warnings: string[] = [];
  const bySize = new Map<number, { target: number; placed: number }>();
  for (const size of [5, 4, 3, 2] as const) {
    const target = Math.round(total * coverage[size] / size);
    let placed = 0;
    for (let at = 0; at < target; at++) {
      const candidates = kind === "combined"
        ? straightCandidates(lanes, size, occupied)
        : linkedCandidates(lanes, size, occupied);
      shuffle(candidates, random);
      const selected = candidates[0];
      if (!selected) break;
      for (const cell of selected) occupied.add(key(cell));
      groups.push({
        id: `${groupPrefix}-${kind}-${size}-${placed}`,
        kind,
        slotIds: selected.map((cell) => cell.id),
      });
      placed++;
    }
    bySize.set(size, { target, placed });
    if (placed < target) {
      warnings.push(`Placed ${placed}/${target} ${kind} groups of size ${size}; no non-overlapping legal shape remained.`);
    }
  }
  const diagnostics = ([2, 3, 4, 5] as const).map((size) => {
    const result = bySize.get(size) ?? { target: 0, placed: 0 };
    return {
      size,
      targetCoverage: coverage[size],
      targetGroups: result.target,
      placedGroups: result.placed,
      actualCoverage: total === 0 ? 0 : result.placed * size / total,
    };
  });
  return { groups, diagnostics, warnings };
}

export function placeQueueGroups(
  lanes: readonly LaidOutSlot[][],
  combinedCoverage: GroupSizeCoverage,
  linkedCoverage: GroupSizeCoverage,
  vectorHash: string,
  combinedRandom: () => number,
  linkedRandom: () => number,
): GroupPlacementResult {
  const occupied = new Set<string>();
  const prefix = `group-${vectorHash.slice(0, 8)}`;
  const combined = placeKind(
    "combined",
    lanes,
    combinedCoverage,
    occupied,
    combinedRandom,
    prefix,
  );
  const linked = placeKind("linked", lanes, linkedCoverage, occupied, linkedRandom, prefix);
  return {
    groups: [...combined.groups, ...linked.groups],
    combinedCoverage: combined.diagnostics,
    linkedCoverage: linked.diagnostics,
    warnings: [...combined.warnings, ...linked.warnings],
  };
}

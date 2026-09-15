import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { ElementDef } from "../core/types.ts";
import { buildIndex } from "../core/nodeIndex.ts";
import { buildIdIndex } from "../data/nodeIdTable.ts";
import type { NodeGraphMap } from "../data/nodeGraphTypes.ts";
import type { CustomerCatalogEntry } from "./types.ts";

interface StatusFile { statuses: ElementDef[] }
interface CustomerTypeFile { types: ElementDef[] }

export interface AuthoringResources {
  doc: NodeGraphMap;
  mapIndex: number;
  queueEffects: ElementDef[];
  gridEffects: ElementDef[];
  customerTypes: ElementDef[];
  customers: CustomerCatalogEntry[];
  keyColors: unknown;
  weather: unknown;
  contextToken: string;
  sourceFiles: string[];
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === "," && !quoted) {
      row.push(cell); cell = "";
    } else if ((ch === "\n" || ch === "\r") && !quoted) {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); if (row.some((value) => value.trim())) rows.push(row); }
  return rows;
}

function parseCustomerCatalog(text: string): CustomerCatalogEntry[] {
  const rows = parseCsv(text);
  const body = rows[0]?.[0]?.trim().toLowerCase() === "index" ? rows.slice(1) : rows;
  return body.map((row) => ({
    index: Number(row[0]) || 0,
    id: row[1] ?? "",
    name: row[2] ?? "",
    desc: row[3] ?? "",
    type: row[4] ?? "",
    baseMap: row[5] ?? "",
    mapIndex: Number(row[6]) || 0,
    fileId: row[7] ?? "",
    icon: row[9] ?? "",
  }));
}

export class RepositoryAdapter {
  readonly root: string;
  private readonly graphDir: string;
  private readonly generalDir: string;

  constructor(root = process.cwd()) {
    this.root = path.resolve(root);
    this.graphDir = path.join(this.root, "src", "data", "config", "nodegraph", "maps");
    this.generalDir = path.join(this.root, "src", "data", "config", "general");
  }

  async listMaps(): Promise<Array<{ id: string; name: string; file: string }>> {
    const files = (await readdir(this.graphDir)).filter((file) => /^Graph-.*\.json$/i.test(file));
    return Promise.all(files.map(async (file) => {
      const doc = JSON.parse(await readFile(path.join(this.graphDir, file), "utf8")) as NodeGraphMap;
      return { id: doc.map.id, name: doc.map.name, file };
    }));
  }

  async load(mapId: string): Promise<AuthoringResources> {
    const maps = await this.listMaps();
    const normalized = mapId.trim().toLowerCase();
    const selected = maps.find((item) =>
      item.id.toLowerCase() === normalized || item.name.toLowerCase() === normalized ||
      item.file.toLowerCase() === normalized || item.file.toLowerCase().startsWith(`graph-${normalized}-`),
    );
    if (!selected) throw new Error(`Unknown map "${mapId}". Available maps: ${maps.map((m) => m.id).join(", ")}`);

    const paths = [
      path.join(this.graphDir, selected.file),
      path.join(this.generalDir, "ingredient-statuses.json"),
      path.join(this.generalDir, "cell-statuses.json"),
      path.join(this.generalDir, "customer-types.json"),
      path.join(this.generalDir, "customers.csv"),
      path.join(this.generalDir, "key-colors.json"),
      path.join(this.generalDir, "weather.json"),
    ];
    const contents = await Promise.all(paths.map((file) => readFile(file, "utf8")));
    const hash = createHash("sha256");
    paths.forEach((file, index) => hash.update(path.relative(this.root, file)).update("\0").update(contents[index]).update("\0"));
    return {
      doc: JSON.parse(contents[0]) as NodeGraphMap,
      mapIndex: Number(selected.file.match(/^Graph-(\d+)-/)?.[1] ?? 0),
      queueEffects: (JSON.parse(contents[1]) as StatusFile).statuses,
      gridEffects: (JSON.parse(contents[2]) as StatusFile).statuses,
      customerTypes: (JSON.parse(contents[3]) as CustomerTypeFile).types,
      customers: parseCustomerCatalog(contents[4]),
      keyColors: JSON.parse(contents[5]) as unknown,
      weather: JSON.parse(contents[6]) as unknown,
      contextToken: hash.digest("hex"),
      sourceFiles: paths.map((file) => path.relative(this.root, file).replaceAll("\\", "/")),
    };
  }

  async readAuthoringContext(mapId: string): Promise<Record<string, unknown>> {
    const resources = await this.load(mapId);
    const { doc } = resources;
    const ix = buildIndex(doc);
    const ids = buildIdIndex(doc.idTable);
    const pickupables = doc.vertices.ingredient.filter((item) => item.pickupable).map((item) => ({
      name: item.name,
      displayName: item.displayName,
      dataId: ids.byNode.ingredient.get(item.name),
      terminalOutput: ix.ingName[ix.terminalOutput[ix.ingByName.get(item.name) ?? -1]],
      yield: ix.terminalYield[ix.ingByName.get(item.name) ?? -1] ?? 1,
      stackRange: ix.stackRange[ix.ingByName.get(item.name) ?? -1] ?? { min: 1, max: 1 },
      multipleUsage: Boolean(item.multipleUsage),
    }));
    const orderables = doc.vertices.composite.filter((item) => item.orderable).map((item) => {
      const dense = ix.compositeByName.get(item.name) ?? -1;
      return {
        name: item.name,
        displayName: item.displayName,
        dataId: ids.byNode.composite.get(item.name),
        toppingRequired: Boolean(item.toppingRequired),
        customerSpaceHeight: item.customerSpaceHeight ?? "Full",
        slots: (ix.slotsOfComposite[dense] ?? []).map((slot) => ({
          kind: slot.kind,
          group: slot.group < 0 ? null : ix.groupName[slot.group],
          groupPath: slot.groupPath.map((group) => ix.groupName[group]),
          options: slot.options.map((ingredient) => ({
            name: ix.ingName[ingredient],
            dataId: ids.byNode.ingredient.get(ix.ingName[ingredient]),
          })),
          minQuantity: slot.minQuantity,
          maxQuantity: slot.maxQuantity,
          isBase: slot.isBase,
          requiresBaseOf: slot.requiresBaseOf.map((composite) => ix.compositeName[composite]),
        })),
      };
    });
    return {
      map: {
        id: doc.map.id,
        name: doc.map.name,
        gridWidth: doc.map.gridWidth,
        gridHeight: doc.map.gridHeight,
        gridCapacity: doc.map.gridWidth * doc.map.gridHeight,
        visibleQueueRows: doc.map.visibleRows,
        dirtyStackHeight: doc.map.dirtyStackHeight,
        serving: { authoredSlots: "level property", runtimeMaximum: 2, widthCapacity: 6 },
      },
      graph: {
        pickupables,
        tools: doc.vertices.tool,
        processEdges: doc.edges.process,
        preservationEdges: doc.edges.preservation,
        orderables,
        dirtyObjects: doc.vertices.dirty,
      },
      effects: { queue: resources.queueEffects, grid: resources.gridEffects },
      customers: {
        types: resources.customerTypes,
        avatars: resources.customers.filter((entry) => entry.mapIndex === resources.mapIndex),
        presentationRules: {
          activeCustomerMaximum: 2,
          activeOrderWidthCapacity: 6,
          previewCount: 3,
          previewsShowCompositeOnly: true,
          bossActsAsPreviewBarrier: true,
          bossIsExclusive: true,
        },
      },
      queueRules: {
        onlyFrontRowIsDirectlyPickable: true,
        deeperVisibleRowsArePreviewOnly: true,
        combinedGroupsMoveAsOneFourConnectedShape: true,
        linkedGroupsRequireEveryMemberAtFront: true,
        gravityAppliesAfterPicks: true,
        ordinaryBagAmountIsPhysicalPieces: true,
        multipleUsageAmountIsReusableServeCount: true,
        bagOccupiesOneQueueSlotAndOneGridCellWhileDraining: true,
        generatedBagTargetsStayWithinPickupableStackRange: true,
      },
      keyColors: resources.keyColors,
      weather: resources.weather,
      contextToken: resources.contextToken,
      sourceFiles: resources.sourceFiles,
    };
  }
}

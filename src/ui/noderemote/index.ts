// Node Remote Data deliberately uses the exact same UI and interaction model
// as Legacy Remote Data. Only its sheet tab/column defaults and live map source
// differ, so fixes to load/apply/diff/fold behavior cannot drift between tabs.

import nodeColumnsJson from "../../data/config/general/node-remote-sheet-columns.json";
import type { MapData } from "../../data/mapLoader.ts";
import {
  blankLevel,
  listNodeMaps,
  loadNodeProject,
  NODE_DOCS,
  saveNodeProject,
  type NodeProjectState,
} from "../../data/nodeProject.ts";
import type { RemoteSheetColumns } from "../../data/sheetSource.ts";
import { RemoteDataView } from "../remote/index.ts";

export class NodeRemoteDataView extends RemoteDataView {
  constructor(
    root: HTMLElement,
    project: NodeProjectState,
    getSheetId: () => string,
    setSheetId: (id: string) => void,
    onOpenInDesign: (levelId: number) => void,
    onOpenMapInDesign: (docId: string, levelId: number) => void,
  ) {
    // RemoteDataView only consumes name + levels. Keep the public legacy type
    // at its boundary while using the graph's semantic map id for sheet keys.
    const mapEntries = listNodeMaps();
    const projects = mapEntries.map((entry) =>
      entry.id === project.docId ? project : loadNodeProject(entry.id),
    );
    const map = { name: project.doc.map.id, levels: project.levels } as MapData;
    const mapSources = projects.map((source) => ({
      id: source.doc.map.id,
      title: mapEntries.find((entry) => entry.id === source.docId)?.name ?? source.doc.map.name,
      map: { name: source.doc.map.id, levels: source.levels } as MapData,
    }));
    const sheetMapAliases = Object.fromEntries(
      NODE_DOCS.flatMap((entry) => [
        [String(entry.index), entry.doc.map.id],
        [entry.id, entry.doc.map.id],
        [entry.doc.map.id, entry.doc.map.id],
      ]),
    );
    const graphLookupMaps = NODE_DOCS.flatMap((entry) => {
      const source = projects.find((candidate) => candidate.docId === entry.id);
      return source ? [{ index: entry.index, doc: source.doc }] : [];
    });
    super(root, map, getSheetId, setSheetId, () => {}, onOpenInDesign, {
      scope: "node",
      mapId: project.doc.map.id,
      tabName: nodeColumnsJson.tabName,
      columns: nodeColumnsJson.columns as RemoteSheetColumns,
      startRow: nodeColumnsJson.startRow,
      mapSources,
      sheetMapAliases,
      graphLookupMaps,
      createLevel: (mapId, levelId) => {
        const source = projects.find((candidate) => candidate.doc.map.id === mapId);
        return source ? blankLevel(source.doc, levelId) : null;
      },
      onMapLevelChanged: (mapId) => {
        const changed = projects.find((source) => source.doc.map.id === mapId);
        if (changed) saveNodeProject(changed);
      },
      onGraphLookupChanged: (mapIndex) => {
        const docId = NODE_DOCS.find((entry) => entry.index === mapIndex)?.id;
        const changed = projects.find((source) => source.docId === docId);
        if (changed) saveNodeProject(changed);
      },
      onOpenMapInDesign: (mapId, levelId) => {
        const source = projects.find((candidate) => candidate.doc.map.id === mapId);
        if (source) onOpenMapInDesign(source.docId, levelId);
      },
    });
  }
}

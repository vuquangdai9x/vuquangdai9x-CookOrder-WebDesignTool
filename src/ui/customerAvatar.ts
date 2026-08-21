// Resolves a customer-catalog row to a renderable avatar, on demand — never
// preloaded (see imagePreload.ts's collectMapFileIds, which deliberately does
// NOT reach into the catalog). Local art lives at a fixed path, named by
// convention; iconEl()'s existing local -> URL -> Drive -> emoji chain does
// the rest, including Drive's lazy-by-default <img loading> behaviour.

import type { CustomerCatalogEntry } from "../data/customerCatalog.ts";
import { NODE_DOCS } from "../data/nodeProject.ts";
import type { IconSpec } from "./icon.ts";

/** `BaseMap` ("burger"/"coffee"/"sushi") -> the graph system's own map index (1/2/3), the naming convention's source of truth. Matched against each graph document's own `map.id`, not the filename-derived picker slug — the two coincide today but the document's id is the semantically correct key. */
export function mapIndexOfBaseMap(baseMap: string): number | undefined {
  return NODE_DOCS.find((d) => d.doc.map.id === baseMap)?.index;
}

/** Fixed local folder every avatar image lives in, relative to src/assets/. */
const CUSTOMERS_FOLDER = "customers";

/** The naming convention: "customer-map<mapIndex>-<id>.png", or undefined when the row has no resolvable map. */
export function customerAvatarLocalPath(entry: CustomerCatalogEntry): string | undefined {
  const mapIndex = mapIndexOfBaseMap(entry.baseMap);
  if (mapIndex === undefined || !entry.id) return undefined;
  return `${CUSTOMERS_FOLDER}/customer-map${mapIndex}-${entry.id}.png`;
}

/** An IconSpec for iconEl() — local bundled art first, then the row's Drive fileId, then its icon/emoji. */
export function customerAvatarIconSpec(entry: CustomerCatalogEntry): IconSpec {
  return {
    name: entry.name || `Customer ${entry.index}`,
    emoji: entry.icon || "🙂",
    fileId: entry.fileId || undefined,
    localImage: customerAvatarLocalPath(entry),
  };
}

const isNormalType = (type: string): boolean => type === "" || type.toLowerCase() === "normal";

/**
 * A stand-in customer for an arrival with no pinned `customerIndex`: any
 * Type=Normal row scoped to the current map. Scoped rather than global so a
 * burger level never randomly shows a sushi character — the catalog's other
 * types (Shipper, Boss, ...) are reserved for a designer's deliberate pick.
 */
export function randomNormalCustomer(
  catalog: CustomerCatalogEntry[],
  baseMap: string,
  rng: () => number = Math.random,
): CustomerCatalogEntry | undefined {
  const pool = catalog.filter((e) => e.baseMap === baseMap && isNormalType(e.type));
  if (pool.length === 0) return undefined;
  return pool[Math.floor(rng() * pool.length)];
}

// Resolves a customer-catalog row to a renderable avatar, on demand — never
// preloaded (see imagePreload.ts's collectMapFileIds, which deliberately does
// NOT reach into the catalog). Local art lives at a fixed path, named by
// convention; iconEl()'s existing local -> URL -> Drive -> emoji chain does
// the rest, including Drive's lazy-by-default <img loading> behaviour.

import type { CustomerCatalogEntry } from "../data/customerCatalog.ts";
import type { IconSpec } from "./icon.ts";

/** Fixed local folder every avatar image lives in, relative to src/assets/. */
const CUSTOMERS_FOLDER = "customers";

/** Filename prefix by catalog Type — Shipper and Boss get their own convention; everything else (Normal, blank) keeps "customer". */
function avatarPrefixForType(type: string): string {
  const lower = type.toLowerCase();
  if (lower === "shipper") return "shipper";
  if (lower === "boss") return "boss";
  return "customer";
}

/** The naming convention: "<prefix>-map<mapIndex>-<id>.png" (see avatarPrefixForType), or undefined when the row has no resolvable map. `mapIndex` is authored directly in the catalog (see CustomerCatalogEntry.mapIndex) rather than inferred from `baseMap`. */
export function customerAvatarLocalPath(entry: CustomerCatalogEntry): string | undefined {
  if (!entry.mapIndex || !entry.id) return undefined;
  return `${CUSTOMERS_FOLDER}/${avatarPrefixForType(entry.type)}-map${entry.mapIndex}-${entry.id}.png`;
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

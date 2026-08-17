// `parseGraphJson` holds the same contract `csvToGraph` does: total on garbage.
//
// The import button points at a designer's own file. A throw there loses that
// file behind a stack trace, so every malformed case below must come back as a
// document plus a list of what was repaired — and, crucially, with every bucket
// the rest of the code indexes into actually present.

import { describe, expect, it } from "vitest";
import burgerJson from "./config/nodegraph/maps/Graph-1-Burger.json";
import { parseGraphJson, vertexCount } from "./nodeGraphJson.ts";
import { EDGE_KIND_NAMES, VERTEX_KIND_NAMES } from "./nodeGraphSchema.ts";
import { ID_SPACES } from "./nodeIdTable.ts";

const parse = (value: unknown) => parseGraphJson(JSON.stringify(value));

describe("round trip", () => {
  it("reads back an exported graph unchanged", () => {
    const { doc, issues } = parseGraphJson(JSON.stringify(burgerJson, null, 2));
    expect(issues).toEqual([]);
    // `notes` is the one normalization: burger.json omits it, and a reader that
    // does `doc.notes.map(...)` has no way to discover the absence, so it is
    // filled here. Everything else must survive byte-identically.
    expect(doc).toEqual({ notes: [], ...burgerJson });
  });

  it("counts every vertex kind", () => {
    const doc = parseGraphJson(JSON.stringify(burgerJson)).doc!;
    const expected = VERTEX_KIND_NAMES.reduce((n, k) => n + burgerJson.vertices[k].length, 0);
    expect(vertexCount(doc)).toBe(expected);
  });
});

describe("refuses only what it truly cannot read", () => {
  it("returns no document for text that is not JSON", () => {
    const { doc, issues } = parseGraphJson("{ not json");
    expect(doc).toBeNull();
    expect(issues[0]).toMatch(/Not valid JSON/);
  });

  it("returns no document for a non-object top level", () => {
    expect(parse([1, 2, 3]).doc).toBeNull();
  });
});

describe("repairs rather than throws", () => {
  it("fills every bucket for an empty object", () => {
    // The important property: a downstream reader does `doc.vertices[k].filter`
    // with no way to discover a missing bucket, so none may be missing.
    const { doc } = parse({});
    for (const kind of VERTEX_KIND_NAMES) expect(Array.isArray(doc!.vertices[kind])).toBe(true);
    for (const kind of EDGE_KIND_NAMES) expect(Array.isArray(doc!.edges[kind])).toBe(true);
    for (const space of ID_SPACES) expect(Array.isArray(doc!.idTable[space])).toBe(true);
    expect(vertexCount(doc!)).toBe(0);
  });

  it("drops a vertex with no name and says so", () => {
    const { doc, issues } = parse({ vertices: { ingredient: [{ name: "bun" }, { displayName: "?" }] } });
    expect(doc!.vertices.ingredient).toHaveLength(1);
    expect(issues.join()).toMatch(/vertices.ingredient: dropped 1/);
  });

  it("drops an edge whose endpoint does not exist", () => {
    // Kept, it would fail later at a point far from the file that caused it.
    const { doc, issues } = parse({
      vertices: { ingredient: [{ name: "bun" }] },
      edges: { process: [{ from: "bun", to: "ghost" }] },
    });
    expect(doc!.edges.process).toEqual([]);
    expect(issues.join()).toMatch(/naming a missing node/);
  });

  it("converts the retired {id,node} id table, preserving the numbering", () => {
    // An older export is exactly the file someone reaches for import with, and
    // the ids in it are the ones committed levels index by — so position must
    // be honoured, not reading order.
    const { doc, issues } = parse({
      idTable: { ingredient: [{ id: 2, node: "tomato" }, { id: 0, node: "bun" }] },
    });
    expect(doc!.idTable.ingredient).toEqual(["bun", "", "tomato"]);
    expect(issues.join()).toMatch(/converted 2 row\(s\)/);
    expect(issues.join()).toMatch(/1 id\(s\) have no node/);
  });

  it("keeps a tombstone's id open instead of closing the gap", () => {
    // Closing it would shift every later id onto a different node — silently
    // repointing every level that used them.
    const { doc } = parse({
      idTable: { composite: [{ id: 0, node: "burger" }, { id: 1, node: null }, { id: 2, node: "soda" }] },
    });
    expect(doc!.idTable.composite).toEqual(["burger", "", "soda"]);
  });

  it("defaults the map block when it is missing", () => {
    const { doc, issues } = parse({ vertices: { ingredient: [{ name: "bun" }] } });
    expect(doc!.map.gridWidth).toBe(4);
    expect(doc!.map.id).toBe("imported");
    expect(issues.join()).toMatch(/No `map` block/);
  });

  it("carries unknown _* keys through, so a round trip diffs clean", () => {
    const { doc } = parse({ _derivation: "hand-written", vertices: {} });
    expect((doc as unknown as Record<string, unknown>)._derivation).toBe("hand-written");
  });
});

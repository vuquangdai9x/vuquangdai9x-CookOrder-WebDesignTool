import { describe, expect, it } from "vitest";
import burgerJson from "./config/nodegraph/maps/Graph-1-Burger.json";
import { csvToGraph, graphToCsv, splitCsvLine } from "./nodeGraphCsv.ts";
import type { NodeGraphMap } from "./nodeGraphTypes.ts";
import { validateNodeGraph } from "./nodeGraphValidate.ts";
import { chainedPotato } from "../core/nodeTestFixtures.ts";

const burger = burgerJson as unknown as NodeGraphMap;

/** Key order is an artefact of construction, never of meaning. */
const norm = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(norm);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as object)
        .sort()
        .map((k) => [k, norm((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
};

describe("round-trip", () => {
  const { doc, issues } = csvToGraph(graphToCsv(burger));

  it("reads back with no issues", () => {
    expect(issues).toEqual([]);
  });

  it("preserves every vertex, field for field", () => {
    for (const kind of ["ingredient", "tool", "group", "composite", "dirty"] as const) {
      expect(norm(doc.vertices[kind]), kind).toEqual(norm(burger.vertices[kind]));
    }
  });

  it("preserves every edge, including chainTools and inputs lists", () => {
    for (const kind of ["process", "base", "topping", "option", "leavesDirty"] as const) {
      expect(norm(doc.edges[kind]), kind).toEqual(norm(burger.edges[kind]));
    }
  });

  it("preserves the id table, position for position", () => {
    expect(norm(doc.idTable)).toEqual(norm(burger.idTable));
    // The id IS the row's position, so round-tripping has to preserve order,
    // not just membership — a reordered table means different levels.
    expect(doc.idTable.ingredient).toEqual(burger.idTable.ingredient);
    expect(doc.idTable.composite).toEqual(burger.idTable.composite);
  });

  it("preserves the map header", () => {
    expect(doc.map).toEqual(burger.map);
  });

  it("still validates clean after the round trip", () => {
    expect(validateNodeGraph(doc).errors).toEqual([]);
  });
});

describe("the CSV is generated from the schema, not hand-written", () => {
  const text = graphToCsv(burger);

  it("declares columns in a #-prefixed row for each section", () => {
    expect(text).toContain("#VERTEX,ingredient,name,");
    expect(text).toContain("#EDGE,process,from,to,inputs,");
    expect(text).toContain("#IDTABLE,space,id,node");
  });

  it("writes lists with | and booleans as TRUE/FALSE", () => {
    const bun = text.split("\n").find((l) => l.startsWith("VERTEX,ingredient,bun,"));
    expect(bun).toContain("TRUE");

    // A chainTools edge, whether or not burger.json currently spells one that
    // way — the point under test is the LIST encoding, not which route uses it.
    const edge = graphToCsv(chainedPotato(burger))
      .split("\n")
      .find((l) => l.startsWith("EDGE,process,cutting-board,potato-fried"));
    expect(edge).toContain("fryer"); // chainTools, a single-item list

    // And a multi-item list separates on the pipe.
    expect(splitCsvLine("EDGE,process,a,b,x|y,1")[4].split("|")).toEqual(["x", "y"]);
  });
});

describe("totality on garbage — a designer must never lose the other 400 rows", () => {
  it("reports an unknown vertex kind instead of throwing", () => {
    const { doc, issues } = csvToGraph(
      "#VERTEX,ingredient,name,displayName\nVERTEX,sandwich,x,X\nVERTEX,ingredient,bun,Bun",
    );
    expect(issues[0].message).toContain("Unknown vertex kind");
    expect(doc.vertices.ingredient).toHaveLength(1); // the good row survived
  });

  it("reports a row that precedes its header", () => {
    const { issues } = csvToGraph("VERTEX,ingredient,bun,Bun");
    expect(issues[0].message).toContain("before any #VERTEX header");
  });

  it("reports a nameless vertex and a from/to-less edge", () => {
    const { issues } = csvToGraph(
      "#VERTEX,ingredient,name,displayName\nVERTEX,ingredient,,Nameless\n" +
        "#EDGE,process,from,to,inputs,amount\nEDGE,process,,bun-sliced,bun,1",
    );
    expect(issues.map((i) => i.message)).toEqual([
      "ingredient row has no name",
      "process edge is missing from/to",
    ]);
  });

  it("reports a non-integer id and an unknown id space", () => {
    const { issues } = csvToGraph("#IDTABLE,space,id,node\nIDTABLE,ingredient,x,bun\nIDTABLE,sauce,1,x");
    expect(issues.map((i) => i.message)).toEqual([
      'Id "x" is not a non-negative integer',
      'Unknown id space "sauce"',
    ]);
  });

  it("ignores a column the current schema no longer has, rather than failing", () => {
    const { doc, issues } = csvToGraph(
      "#VERTEX,ingredient,name,displayName,legacyThing\nVERTEX,ingredient,bun,Bun,42",
    );
    expect(issues).toEqual([]);
    expect(doc.vertices.ingredient[0]).toEqual({ name: "bun", displayName: "Bun" });
  });

  it("gives a process edge the fields the sim indexes, even when the file omits them", () => {
    const { doc } = csvToGraph("#EDGE,process,from,to\nEDGE,process,griddle,patty-cooked");
    expect(doc.edges.process[0]).toMatchObject({ inputs: [], amount: 1 });
  });
});

describe("splitCsvLine", () => {
  it("honours quoting and escaped quotes", () => {
    expect(splitCsvLine('a,"b,c",d')).toEqual(["a", "b,c", "d"]);
    expect(splitCsvLine('"say ""hi""",x')).toEqual(['say "hi"', "x"]);
    expect(splitCsvLine("a,,b")).toEqual(["a", "", "b"]);
  });
});

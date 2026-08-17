// The contract the whole positional id model rests on, checked against the
// REAL data rather than a fixture: a row's index in `idTable` is the number
// every committed level string carries.
//
// This is the test that would have caught the renumber going wrong. The graph
// and the levels were migrated together — servables moved from ids 100..113 to
// 17..30 — and nothing but agreement between these two files makes a level
// mean what it meant before.

import { describe, expect, it } from "vitest";
import burgerJson from "./config/nodegraph/maps/Graph-1-Burger.json";
import burgerLevelsCsv from "./config/nodegraph/maps/LevelData-1-Burger.csv?raw";
import { buildIndex } from "../core/nodeIndex.ts";
import { NodeSimulation } from "../core/nodeSim.ts";
import { parseNodeCustomers } from "../core/nodeParser.ts";
import { parseQueues } from "../core/parser.ts";
import { toNodeLevelConfig } from "./nodeLevel.ts";
import type { NodeGraphMap } from "./nodeGraphTypes.ts";
import { buildIdIndex, ID_SPACES } from "./nodeIdTable.ts";
import { importLevelsCsv } from "./sheetSource.ts";
import { validateNodeGraph } from "./nodeGraphValidate.ts";

const doc = burgerJson as unknown as NodeGraphMap;
const ix = buildIndex(doc);
const ids = buildIdIndex(doc.idTable);
const levels = importLevelsCsv(burgerLevelsCsv);

describe("the id is the row's position", () => {
  it("resolves each space by index — the table is a plain ordered name list", () => {
    for (const space of ID_SPACES) {
      doc.idTable[space].forEach((node, index) => {
        // A row is a bare string: no id field to disagree with the position,
        // and no tombstone state for a reader to mishandle.
        expect(typeof node, `${space}[${index}] is not a plain name`).toBe("string");
        expect(node, `${space}[${index}] is empty`).not.toBe("");
        expect(ids.byId[space].get(index)).toBe(node);
      });
    }
  });

  it("gives every pickupable and every orderable an id, and intermediates none", () => {
    for (const v of doc.vertices.ingredient) {
      const has = ids.byNode.ingredient.has(v.name);
      if (v.pickupable || v.servable) expect(has, `${v.name} needs an id`).toBe(true);
      else expect(has, `${v.name} is an intermediate and should have none`).toBe(false);
    }
    for (const v of doc.vertices.composite) {
      expect(ids.byNode.composite.has(v.name), v.name).toBe(Boolean(v.orderable));
    }
  });
});

describe("the committed levels agree with the table they index into", () => {
  it("validates with no errors", () => {
    expect(validateNodeGraph(doc).errors.map((e) => e.message)).toEqual([]);
  });

  it("binds every level to the graph with zero data issues", () => {
    for (const data of levels) {
      const sim = new NodeSimulation(ix, toNodeLevelConfig(data));
      expect(sim.issues, data.name).toEqual([]);
    }
  });

  it("resolves every queued id to a PICKUPABLE ingredient", () => {
    for (const data of levels) {
      for (const lane of parseQueues(data.queueString)) {
        for (const item of lane) {
          if (item.id < 0) continue; // the sweeper keeps its negative id
          const name = ids.byId.ingredient.get(item.id);
          expect(name, `${data.name}: queue id ${item.id} resolves to nothing`).toBeDefined();
          const vertex = doc.vertices.ingredient.find((v) => v.name === name);
          expect(vertex?.pickupable, `${data.name}: queued "${name}" is not pickupable`).toBe(true);
        }
      }
    }
  });

  it("resolves every dish member to a SERVABLE ingredient, and every root to an orderable", () => {
    for (const data of levels) {
      for (const customer of parseNodeCustomers(data.customerString)) {
        for (const dish of customer.dishes) {
          const root = ids.byId.composite.get(dish.root.id);
          expect(root, `${data.name}: dish root c${dish.root.id} resolves to nothing`).toBeDefined();

          const walk = (node: typeof dish.root): void => {
            for (const member of node.members) {
              if (member.kind !== "ingredient") {
                walk(member);
                continue;
              }
              const name = ids.byId.ingredient.get(member.id);
              expect(name, `${data.name}: dish id ${member.id} resolves to nothing`).toBeDefined();
              const vertex = doc.vertices.ingredient.find((v) => v.name === name);
              expect(vertex?.servable, `${data.name}: dish member "${name}" is not servable`).toBe(true);
            }
          };
          walk(dish.root);
        }
      }
    }
  });

  /**
   * The renumber's own regression test. Servables used to live at 100+; if a
   * level string still carried one of those it would now resolve to nothing
   * (the table is only ~31 rows long), so this pins that none survived.
   */
  it("carries no id past the end of the table it indexes into", () => {
    const ingredients = doc.idTable.ingredient.length;
    const composites = doc.idTable.composite.length;
    for (const data of levels) {
      for (const lane of parseQueues(data.queueString)) {
        for (const item of lane) {
          if (item.id >= 0) expect(item.id, `${data.name} queue`).toBeLessThan(ingredients);
        }
      }
      for (const customer of parseNodeCustomers(data.customerString)) {
        for (const dish of customer.dishes) {
          expect(dish.root.id, `${data.name} dish root`).toBeLessThan(composites);
        }
      }
    }
  });
});

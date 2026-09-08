import { describe, expect, it } from "vitest";
import burgerJson from "../data/config/nodegraph/maps/Graph-1-Burger.json";
import coffeeJson from "../data/config/nodegraph/maps/Graph-2-Coffee.json";
import sushiJson from "../data/config/nodegraph/maps/Graph-3-Sushi.json";
import theaterJson from "../data/config/nodegraph/maps/Graph-4-Theater-Popcorn.json";
import matchaJson from "../data/config/nodegraph/maps/Graph-5-Matcha.json";
import tanghuluJson from "../data/config/nodegraph/maps/Graph-6-Tanghulu.json";
import sandwichJson from "../data/config/nodegraph/maps/Graph-7-Sandwich.json";
import pizzaPastaJson from "../data/config/nodegraph/maps/Graph-8-Pizza-Pasta.json";
import type { NodeGraphMap } from "../data/nodeGraphTypes.ts";
import { buildIndex } from "./nodeIndex.ts";
import {
  compositeCustomerSpaceHeight,
  compositeCustomerSpaceWidth,
  resolvedCustomerSpaceWidth,
} from "./nodeCustomerSpace.ts";

const ix = buildIndex(burgerJson as unknown as NodeGraphMap);
const burger = ix.compositeByName.get("burger")!;
const soda = ix.compositeByName.get("soda")!;
const friedBasket = ix.compositeByName.get("fried-basket")!;

describe("abstract customer space", () => {
  it("uses the bundled Burger map height configuration", () => {
    expect(compositeCustomerSpaceHeight(ix, burger)).toBe("Full");
    expect(compositeCustomerSpaceHeight(ix, soda)).toBe("Half");
    expect(compositeCustomerSpaceHeight(ix, friedBasket)).toBe("Half");
  });

  it("configures every bundled non-burger composite as Half", () => {
    const maps = ([
      burgerJson,
      coffeeJson,
      sushiJson,
      theaterJson,
      matchaJson,
      tanghuluJson,
      sandwichJson,
      pizzaPastaJson,
    ] as unknown) as NodeGraphMap[];
    const nonBurgerComposites = maps.flatMap((map) =>
      map.vertices.composite.filter((composite) => !(map.map.id === "burger" && composite.name === "burger")),
    );
    expect(nonBurgerComposites.length).toBeGreaterThan(0);
    expect(nonBurgerComposites.every((composite) => composite.customerSpaceHeight === "Half")).toBe(true);
  });

  it("defaults missing height configuration to Half", () => {
    const doc = structuredClone(burgerJson as unknown as NodeGraphMap);
    delete doc.vertices.composite[0].customerSpaceHeight;
    expect(compositeCustomerSpaceHeight(buildIndex(doc), 0)).toBe("Half");
  });

  it("stacks Half composites in pairs and keeps Full composites separate", () => {
    expect(compositeCustomerSpaceWidth(ix, [soda])).toBe(1);
    expect(compositeCustomerSpaceWidth(ix, [soda, friedBasket])).toBe(1);
    expect(compositeCustomerSpaceWidth(ix, [soda, friedBasket, soda])).toBe(2);
    expect(compositeCustomerSpaceWidth(ix, [burger, soda, friedBasket])).toBe(2);
  });

  it("adds the fixed half-unit avatar width", () => {
    expect(resolvedCustomerSpaceWidth(ix, {
      dishes: [
        { order: { orderable: burger } },
        { order: { orderable: soda } },
        { order: { orderable: friedBasket } },
      ],
    })).toBe(2.5);
  });
});

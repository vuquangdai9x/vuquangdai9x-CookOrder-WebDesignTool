import type { GraphIndex } from "./nodeIndex.ts";

export const CUSTOMER_SPACE_WIDTH = 5.5;
export const CUSTOMER_AVATAR_WIDTH = 0.5;
export const MAX_ACTIVE_CUSTOMERS = 2;

export type CustomerSpaceHeight = "Half" | "Full";

export interface ResolvedCustomerSpaceDish {
  order: { orderable: number };
}

export interface ResolvedCustomerSpaceOrder {
  dishes: readonly ResolvedCustomerSpaceDish[];
}

/** Missing config follows the map rule, including legacy Burger drafts created before this field. */
export function compositeCustomerSpaceHeight(
  ix: GraphIndex,
  orderable: number,
): CustomerSpaceHeight {
  const composite = ix.doc.vertices.composite[orderable];
  if (composite?.customerSpaceHeight === "Full") return "Full";
  if (composite?.customerSpaceHeight === "Half") return "Half";
  return ix.doc.map.id === "burger" && composite?.name === "burger" ? "Full" : "Half";
}

/** Width occupied by dishes only, after pairs of Half dishes have been stacked. */
export function compositeCustomerSpaceWidth(
  ix: GraphIndex,
  orderables: readonly number[],
): number {
  let full = 0;
  let half = 0;
  for (const orderable of orderables) {
    if (compositeCustomerSpaceHeight(ix, orderable) === "Half") half++;
    else full++;
  }
  return full + Math.ceil(half / 2);
}

/** Total abstract card width, including the customer's fixed avatar column. */
export function resolvedCustomerSpaceWidth(
  ix: GraphIndex,
  customer: ResolvedCustomerSpaceOrder,
): number {
  return CUSTOMER_AVATAR_WIDTH + compositeCustomerSpaceWidth(
    ix,
    customer.dishes.map((dish) => dish.order.orderable),
  );
}

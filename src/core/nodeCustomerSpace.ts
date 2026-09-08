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

/** Missing or invalid configuration follows the global default: composites are Half-height. */
export function compositeCustomerSpaceHeight(
  ix: GraphIndex,
  orderable: number,
): CustomerSpaceHeight {
  return ix.doc.vertices.composite[orderable]?.customerSpaceHeight === "Full" ? "Full" : "Half";
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

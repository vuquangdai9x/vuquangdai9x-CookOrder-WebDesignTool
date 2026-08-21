// Shared simulation vocabulary. The graph-native simulation (nodeSim.ts) owns
// this — it's factored out on its own so nothing here has to live inside a
// specific simulation implementation.

export type SimStatus = "playing" | "won" | "lost";

export type LoseReason =
  | "grid-overflow"
  | "dirty-overflow"
  | "out-of-ingredient"
  | "customer-timeout";

export type FlightKind =
  | "queue-to-tool"
  | "queue-to-grid"
  | "tool-to-grid"
  | "grid-to-tool"
  /** A processable item leaving the Save Me backpack for a tool. */
  | "backpack-to-tool"
  /** A chained-recipe hop from one tool straight to the next (see ToolRecipe.chainTools) — never touches the grid. */
  | "tool-to-tool"
  | "grid-to-customer"
  /** A cooked item served straight out of the tool it just finished at — the customer was already waiting, so it never lands on the grid. */
  | "tool-to-customer"
  /** A no-tool-needed pick served straight from the queue — the customer was already waiting, so it never lands on the grid. */
  | "queue-to-customer"
  /** The dirty dish a departing customer leaves behind. */
  | "customer-to-grid"
  /** One dirty stack flying into a staff customer as they clear it. */
  | "dirty-to-staff"
  /** A cooked item served out of the Save Me backpack instead of the grid. */
  | "backpack-to-customer";

export interface SimEvent {
  type:
    | "pick"
    | "cooked"
    | "served"
    | "customer-arrived"
    | "customer-timeout"
    | "dirty-added"
    | "dirty-cleared"
    | "won"
    | "lost"
    | "saved";
  message: string;
  atTime: number;
  /** Customer index, for events the view wants to animate. */
  customerIndex?: number;
}

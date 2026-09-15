import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { LevelAuthoringService } from "./service.ts";
import type { AuthoringStrategy, MechanicAuthorization } from "./types.ts";

const service = new LevelAuthoringService(process.env.COOKORDER_WORKSPACE_ROOT ?? process.cwd());
const server = new McpServer(
  { name: "cookorder-level-authoring", version: "0.1.0" },
  { instructions: "Read authoring context before starting. Build levels through granular mutations, validate after meaningful changes, and never add special mechanics without explicit authorization." },
);

const response = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: (value && typeof value === "object" ? value : { value }) as Record<string, unknown>,
});
const failure = (error: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
});
const run = async (operation: () => unknown | Promise<unknown>) => {
  try { return response(await operation()); } catch (error) { return failure(error); }
};
const register = (name: string, description: string, inputSchema: Record<string, z.ZodTypeAny>, handler: (args: Record<string, unknown>) => unknown | Promise<unknown>, readOnly = false) => {
  server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: readOnly } }, (args) => run(() => handler(args)));
};

const sessionRevision = { session_id: z.string(), expected_revision: z.number().int().nonnegative() };
const effect = z.object({ effectId: z.number().int().nonnegative(), params: z.array(z.number()) });
const mechanic = z.enum([
  "queue:freeze", "queue:hidden", "queue:holding-key", "grid:blocked", "grid:order-lock", "grid:ingredient-slot", "grid:color-lock",
  "group:combined", "group:linked", "customer:timer", "customer:staff", "customer:boss", "customer:shipper", "dish:effect",
]);

register("read_authoring_context", "Read the selected map graph, rules, effects, customer catalog, and a freshness token before authoring.", { map_id: z.string() }, (a) => service.readAuthoringContext(String(a.map_id)), true);
register("inspect_orderable", "Inspect one orderable composite and all valid nested slots.", { map_id: z.string(), composite: z.string() }, (a) => service.inspectOrderable(String(a.map_id), String(a.composite)), true);
register("get_valid_dish_pieces", "List graph-valid pieces, quantities, nesting, and base prerequisites for a draft dish or composite.", { session_id: z.string(), dish_id: z.string().optional(), composite: z.string().optional() }, (a) => service.getValidDishPieces(String(a.session_id), { dishId: a.dish_id as string | undefined, composite: a.composite as string | undefined }), true);
register("trace_ingredient", "Trace an ingredient backward to pickupable inputs and tools.", { map_id: z.string(), ingredient: z.string() }, (a) => service.traceIngredient(String(a.map_id), String(a.ingredient)), true);
register("list_customer_avatars", "List map-compatible customer avatars, optionally filtered by catalog role.", { map_id: z.string(), role: z.string().optional() }, (a) => service.listCustomerAvatars(String(a.map_id), a.role as string | undefined), true);
register("explain_effect", "Explain one queue or grid effect and its parameters; this does not authorize it.", { map_id: z.string(), scope: z.enum(["queue", "grid"]), effect: z.string() }, (a) => service.explainEffect(String(a.map_id), a.scope as "queue" | "grid", String(a.effect)), true);
register("explain_customer_rules", "Explain active width, preview, boss-barrier, and exclusivity rules.", {}, () => service.explainCustomerRules(), true);
register("interpret_level_brief", "Parse a free-form brief into measurable constraints, a difficulty profile, and explicit mechanic authorization.", { map_id: z.string(), brief: z.string().min(1) }, (a) => service.interpretLevelBrief(String(a.map_id), String(a.brief)), true);

register("start_level_session", "Start an obstacle-free revisioned draft against a fresh context token.", {
  map_id: z.string(), context_token: z.string(), brief: z.string().min(1), session_id: z.string().optional(),
  metadata: z.object({ id: z.number().int().optional(), name: z.string().optional(), weather: z.string().optional(), levelTag: z.string().optional(), featureUnlock: z.string().optional(), shuffleDistance: z.number().int().optional(), serveableSlots: z.number().int().min(1).max(2).optional(), outOfSlotPolicy: z.enum(["block-pick", "park-on-grid"]).optional(), boosterCharges: z.array(z.number().int().nonnegative()).optional() }).optional(),
}, (a) => service.startLevelSession({ mapId: String(a.map_id), contextToken: String(a.context_token), brief: String(a.brief), sessionId: a.session_id as string | undefined, metadata: a.metadata as never }));
register("get_level_session", "Read the current draft, ledger, strategy history, and revision.", { session_id: z.string() }, (a) => service.getSession(String(a.session_id)), true);
register("plan_authoring_strategy", "Recommend an adaptive starting route from current constraint dependencies.", { session_id: z.string() }, (a) => service.planAuthoringStrategy(String(a.session_id)), true);
register("set_authoring_strategy", "Record the chosen or changed strategy with rationale and evidence.", { ...sessionRevision, strategy: z.enum(["demand-first", "queue-layout-first", "board-mechanic-first", "difficulty-first-hybrid"]), rationale: z.string(), evidence: z.array(z.string()).optional() }, (a) => service.setAuthoringStrategy(String(a.session_id), Number(a.expected_revision), a.strategy as AuthoringStrategy, String(a.rationale), (a.evidence as string[] | undefined) ?? []));
register("propose_obstacle_options", "Return read-only obstacle options when ordinary tuning cannot meet the brief.", { session_id: z.string() }, (a) => service.proposeObstacleOptions(String(a.session_id)), true);
register("amend_session_requirements", "Record user-approved mechanics in the authorization ledger.", { ...sessionRevision, mechanics: z.array(mechanic).min(1), approval_note: z.string().min(1) }, (a) => service.amendSessionRequirements(String(a.session_id), Number(a.expected_revision), a.mechanics as MechanicAuthorization[], String(a.approval_note)));
register("set_level_properties", "Update level metadata and ordinary serving properties.", { ...sessionRevision, properties: z.record(z.string(), z.unknown()) }, (a) => service.setLevelProperties(String(a.session_id), Number(a.expected_revision), a.properties as never));

register("add_customer", "Manually insert a customer with no dishes.", { ...sessionRevision, type_id: z.number().int(), wait_time: z.number().int().nonnegative(), weather_effect: z.number().int(), staff_amount: z.number().int().positive().optional(), customer_index: z.number().int().nonnegative().optional(), position: z.number().int().nonnegative().optional() }, (a) => service.addCustomer(String(a.session_id), Number(a.expected_revision), { typeId: Number(a.type_id), waitTime: Number(a.wait_time), weatherEff: Number(a.weather_effect), staffAmount: a.staff_amount as number | undefined, customerIndex: a.customer_index as number | undefined, position: a.position as number | undefined }));
register("update_customer", "Update a customer while enforcing special-customer and timer authorization.", { ...sessionRevision, customer_id: z.string(), update: z.record(z.string(), z.unknown()) }, (a) => service.updateCustomer(String(a.session_id), Number(a.expected_revision), String(a.customer_id), a.update as never));
register("set_customer_avatar", "Pin a catalog avatar and validate its map/role authorization.", { ...sessionRevision, customer_id: z.string(), customer_index: z.number().int().nonnegative() }, (a) => service.setCustomerAvatar(String(a.session_id), Number(a.expected_revision), String(a.customer_id), Number(a.customer_index)));
register("move_customer", "Move a customer without silently relocating bosses.", { ...sessionRevision, customer_id: z.string(), position: z.number().int().nonnegative() }, (a) => service.moveCustomer(String(a.session_id), Number(a.expected_revision), String(a.customer_id), Number(a.position)));
register("remove_customer", "Remove one customer and its dishes.", { ...sessionRevision, customer_id: z.string() }, (a) => service.removeCustomer(String(a.session_id), Number(a.expected_revision), String(a.customer_id)));

register("add_dish", "Add an empty structured dish for a selected orderable composite.", { ...sessionRevision, customer_id: z.string(), composite: z.string() }, (a) => service.addDish(String(a.session_id), Number(a.expected_revision), String(a.customer_id), String(a.composite)));
register("add_dish_piece", "Add one graph-valid piece to a named dish slot.", { ...sessionRevision, dish_id: z.string(), slot_index: z.number().int().nonnegative(), ingredient: z.string() }, (a) => service.addDishPiece(String(a.session_id), Number(a.expected_revision), String(a.dish_id), Number(a.slot_index), String(a.ingredient)));
register("replace_dish_piece", "Replace one occurrence in a dish slot with another valid option.", { ...sessionRevision, dish_id: z.string(), slot_index: z.number().int().nonnegative(), occurrence: z.number().int().nonnegative(), ingredient: z.string() }, (a) => service.replaceDishPiece(String(a.session_id), Number(a.expected_revision), String(a.dish_id), Number(a.slot_index), Number(a.occurrence), String(a.ingredient)));
register("remove_dish_piece", "Remove one selected occurrence from a dish slot.", { ...sessionRevision, dish_id: z.string(), slot_index: z.number().int().nonnegative(), occurrence: z.number().int().nonnegative() }, (a) => service.removeDishPiece(String(a.session_id), Number(a.expected_revision), String(a.dish_id), Number(a.slot_index), Number(a.occurrence)));
register("remove_dish", "Remove one dish.", { ...sessionRevision, dish_id: z.string() }, (a) => service.removeDish(String(a.session_id), Number(a.expected_revision), String(a.dish_id)));
register("set_dish_effect", "Set an explicitly authorized dish effect.", { ...sessionRevision, dish_id: z.string(), effect }, (a) => service.setDishEffect(String(a.session_id), Number(a.expected_revision), String(a.dish_id), a.effect as never));
register("remove_dish_effect", "Remove a dish effect.", { ...sessionRevision, dish_id: z.string(), effect_id: z.number().int().nonnegative() }, (a) => service.removeDishEffect(String(a.session_id), Number(a.expected_revision), String(a.dish_id), Number(a.effect_id)));

register("add_queue_lane", "Add an empty queue lane.", { ...sessionRevision, position: z.number().int().nonnegative().optional() }, (a) => service.addQueueLane(String(a.session_id), Number(a.expected_revision), a.position as number | undefined));
register("remove_queue_lane", "Remove one queue lane and repair group references.", { ...sessionRevision, lane_id: z.string() }, (a) => service.removeQueueLane(String(a.session_id), Number(a.expected_revision), String(a.lane_id)));
register("move_queue_lane", "Move a queue lane while preserving stable slot IDs.", { ...sessionRevision, lane_id: z.string(), position: z.number().int().nonnegative() }, (a) => service.moveQueueLane(String(a.session_id), Number(a.expected_revision), String(a.lane_id), Number(a.position)));
register("add_queue_ingredient", "Add explicitly selected pickup slots to one lane; this never generates a queue. `count` = slots added. For ordinary ingredients, `amount` = physical bag pieces; for `multipleUsage`, it is reusable serves on one landed ingredient.", { ...sessionRevision, lane_id: z.string(), position: z.number().int().nonnegative(), ingredient: z.string(), count: z.number().int().min(1).max(100).optional(), amount: z.number().int().min(1).optional(), provisional: z.boolean().optional() }, (a) => service.addQueueIngredient(String(a.session_id), Number(a.expected_revision), { laneId: String(a.lane_id), position: Number(a.position), ingredient: String(a.ingredient), count: a.count as number | undefined, amount: a.amount as number | undefined, provisional: a.provisional as boolean | undefined }));
register("set_queue_slot_amount", "Set one queue slot's amount. It is physical bag pieces for ordinary ingredients and reusable serves for `multipleUsage`; 1 makes a plain single-use slot.", { ...sessionRevision, slot_id: z.string(), amount: z.number().int().min(1) }, (a) => service.setQueueSlotAmount(String(a.session_id), Number(a.expected_revision), String(a.slot_id), Number(a.amount)));
register("split_queue_slot", "Split a slot after keep_amount units. The original keeps its effects and grouping; the ungrouped remainder is inserted immediately after it.", { ...sessionRevision, slot_id: z.string(), keep_amount: z.number().int().min(1) }, (a) => service.splitQueueSlot(String(a.session_id), Number(a.expected_revision), String(a.slot_id), Number(a.keep_amount)));
register("merge_queue_slots", "Merge same-ingredient slots into the first slot id. It keeps its effects/grouping; removed slots disappear and groups containing them are broken.", { ...sessionRevision, slot_ids: z.array(z.string()).min(2) }, (a) => service.mergeQueueSlots(String(a.session_id), Number(a.expected_revision), a.slot_ids as string[]));
register("replace_queue_ingredient", "Replace one queue slot with a selected pickupable ingredient.", { ...sessionRevision, slot_id: z.string(), ingredient: z.string(), provisional: z.boolean().optional() }, (a) => service.replaceQueueIngredient(String(a.session_id), Number(a.expected_revision), String(a.slot_id), String(a.ingredient), a.provisional as boolean | undefined));
register("remove_queue_slot", "Remove one stable queue slot.", { ...sessionRevision, slot_id: z.string() }, (a) => service.removeQueueSlot(String(a.session_id), Number(a.expected_revision), String(a.slot_id)));
register("move_queue_slot", "Move one slot to a position in a selected lane.", { ...sessionRevision, slot_id: z.string(), lane_id: z.string(), position: z.number().int().nonnegative() }, (a) => service.moveQueueSlot(String(a.session_id), Number(a.expected_revision), String(a.slot_id), String(a.lane_id), Number(a.position)));
register("create_queue_group", "Create an authorized combined or linked group from stable slot IDs.", { ...sessionRevision, kind: z.enum(["combined", "linked"]), slot_ids: z.array(z.string()).min(2) }, (a) => service.createQueueGroup(String(a.session_id), Number(a.expected_revision), a.kind as "combined" | "linked", a.slot_ids as string[]));
register("update_queue_group", "Update authorized group kind or members.", { ...sessionRevision, group_id: z.string(), kind: z.enum(["combined", "linked"]).optional(), slot_ids: z.array(z.string()).min(2).optional() }, (a) => service.updateQueueGroup(String(a.session_id), Number(a.expected_revision), String(a.group_id), { kind: a.kind as "combined" | "linked" | undefined, slotIds: a.slot_ids as string[] | undefined }));
register("remove_queue_group", "Remove one queue group.", { ...sessionRevision, group_id: z.string() }, (a) => service.removeQueueGroup(String(a.session_id), Number(a.expected_revision), String(a.group_id)));
register("set_queue_slot_effect", "Set an authorized queue effect with validated parameters.", { ...sessionRevision, slot_id: z.string(), effect }, (a) => service.setQueueSlotEffect(String(a.session_id), Number(a.expected_revision), String(a.slot_id), a.effect as never));
register("remove_queue_slot_effect", "Remove one queue effect.", { ...sessionRevision, slot_id: z.string(), effect_id: z.number().int().nonnegative() }, (a) => service.removeQueueSlotEffect(String(a.session_id), Number(a.expected_revision), String(a.slot_id), Number(a.effect_id)));

register("set_grid_cell_effect", "Set an authorized grid effect at a validated coordinate.", { ...sessionRevision, x: z.number().int().nonnegative(), y: z.number().int().nonnegative(), effect }, (a) => service.setGridCellEffect(String(a.session_id), Number(a.expected_revision), Number(a.x), Number(a.y), a.effect as never));
register("clear_grid_cell_effect", "Clear one or all effects from a grid cell.", { ...sessionRevision, x: z.number().int().nonnegative(), y: z.number().int().nonnegative(), effect_id: z.number().int().nonnegative().optional() }, (a) => service.clearGridCellEffect(String(a.session_id), Number(a.expected_revision), Number(a.x), Number(a.y), a.effect_id as number | undefined));
register("move_grid_cell_effect", "Move one effect between grid cells.", { ...sessionRevision, from: z.object({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative() }), to: z.object({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative() }), effect_id: z.number().int().nonnegative() }, (a) => service.moveGridCellEffect(String(a.session_id), Number(a.expected_revision), a.from as never, a.to as never, Number(a.effect_id)));

register("get_supply_demand", "Return exact pickup have/need, recipe chains, yields, reusable multipliers, provenance, and key balance.", { session_id: z.string() }, (a) => service.getSupplyDemand(String(a.session_id)), true);
register("validate_draft", "Run fast graph, supply, group, authorization, and customer checks.", { session_id: z.string() }, (a) => service.validateDraft(String(a.session_id)), true);
register("validate_level", "Run full structural, thaw, tool, capacity, and reachability-oriented checks.", { session_id: z.string() }, (a) => service.validateLevel(String(a.session_id)), true);
register("estimate_difficulty", "Estimate measurable pressure and compare it with the session profile.", { session_id: z.string() }, (a) => service.estimateDifficulty(String(a.session_id)), true);
register("playtest_instant", "Play the exact draft with instant logical transfers while cooking and customer clocks advance normally.", { session_id: z.string() }, (a) => service.playtestInstant(String(a.session_id)), true);
register("checkpoint_level", "Write an append-only revision checkpoint; CSV is included only when serializable.", { session_id: z.string(), label: z.string().min(1) }, (a) => service.checkpointLevel(String(a.session_id), String(a.label)));
register("finalize_level", "Run full validation, estimation, and instant playtest; export only a fundamentally valid result.", { session_id: z.string() }, (a) => service.finalizeLevel(String(a.session_id)));
register("restore_revision", "Restore a prior draft snapshot as a new revision.", { ...sessionRevision, revision: z.number().int().nonnegative() }, (a) => service.restoreRevision(String(a.session_id), Number(a.expected_revision), Number(a.revision)));
register("undo", "Restore the preceding draft snapshot as a new revision.", sessionRevision, (a) => service.undo(String(a.session_id), Number(a.expected_revision)));

await server.connect(new StdioServerTransport());

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { LevelAuthoringService } from "./service.ts";
import type { AuthoringStrategy, MechanicAuthorization, MetricConstraint, ProposalAction } from "./types.ts";

const service = new LevelAuthoringService(process.env.COOKORDER_WORKSPACE_ROOT ?? process.cwd());
const server = new McpServer(
  { name: "cookorder-level-authoring", version: "0.1.0" },
  { instructions: "Read fresh authoring context, refine vague requirements, and show the measurable summary before confirmation. Skip confirmation only when the user explicitly requests it or asks for batch generation. Start with an ordinary proposal, inspect stable actions and warnings, evaluate focused alternatives on identical seeds, and apply only the selected revision-matched proposal or experiment. Use bounded search and batch steps; never add special mechanics without explicit authorization. All evaluation uses fixed Unpacked raw + Auto + park-on-grid production behavior." },
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
const constraintValue = z.union([z.number(), z.string(), z.boolean(), z.tuple([z.number(), z.number()]), z.array(z.string())]);
const metricConstraint = z.object({
  id: z.string().min(1), dimension: z.string().min(1), metric: z.string().min(1), operator: z.enum(["=", "!=", "<", "<=", ">", ">=", "between", "in"]),
  value: constraintValue, priority: z.enum(["hard", "target", "preference"]), weight: z.number().positive(), source: z.string().min(1),
  scope: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(), minimumRuns: z.number().int().positive().optional(), confidence: z.number().min(0).max(1).optional(),
});
const metricConstraintPatch = metricConstraint.omit({ id: true }).partial();
const proposalAction = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("merge_queue_slots"), arguments: z.object({ slotIds: z.array(z.string()).min(2) }), expectedResult: z.object({ keptSlotId: z.string(), amount: z.number().int().positive(), removedSlotIds: z.array(z.string()) }) }),
  z.object({ tool: z.literal("split_queue_slot"), arguments: z.object({ slotId: z.string(), keepAmount: z.number().int().positive() }), expectedResult: z.object({ keptSlotId: z.string(), keptAmount: z.number().int().positive(), remainderSlotId: z.string(), remainderAmount: z.number().int().positive() }) }),
  z.object({ tool: z.literal("add_queue_lane"), arguments: z.object({ position: z.number().int().nonnegative().optional() }), expectedResult: z.object({ laneId: z.string() }) }),
  z.object({ tool: z.literal("add_queue_ingredient"), arguments: z.object({ laneId: z.string(), position: z.number().int().nonnegative(), ingredient: z.string(), count: z.number().int().positive(), amount: z.number().int().positive(), provisional: z.boolean() }), expectedResult: z.object({ slotIds: z.array(z.string()), expandedUnits: z.number().int().positive() }) }),
  z.object({ tool: z.literal("add_customer"), arguments: z.object({ typeId: z.number().int(), waitTime: z.number().int().nonnegative(), weatherEff: z.number().int(), position: z.number().int().nonnegative().optional(), customerIndex: z.number().int().nonnegative().optional() }), expectedResult: z.object({ customerId: z.string() }) }),
  z.object({ tool: z.literal("add_dish"), arguments: z.object({ customerId: z.string(), composite: z.string() }), expectedResult: z.object({ dishId: z.string() }) }),
  z.object({ tool: z.literal("add_dish_piece"), arguments: z.object({ dishId: z.string(), slotIndex: z.number().int().nonnegative(), ingredient: z.string() }), expectedResult: z.object({ dishId: z.string(), selectedCount: z.number().int().positive() }) }),
  z.object({ tool: z.literal("set_queue_slot_effect"), arguments: z.object({ slotId: z.string(), effect }), expectedResult: z.object({ slotId: z.string() }) }),
  z.object({ tool: z.literal("set_grid_cell_effect"), arguments: z.object({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative(), effect }), expectedResult: z.object({ cellId: z.string() }) }),
]);
const batchSpec = z.object({
  levelCount: z.number().int().min(1).max(100),
  customerRange: z.tuple([z.number().int().min(1), z.number().int().min(1)]).optional(),
  dishesPerCustomer: z.number().int().min(1).max(5).optional(),
  laneRange: z.tuple([z.number().int().min(1).max(8), z.number().int().min(1).max(8)]).optional(),
  amountUtilizationCurve: z.array(z.enum(["single-unit", "balanced", "compact"])).min(1).optional(),
  difficultyCurve: z.array(z.string().min(1)).min(1).optional(),
  validationProfile: z.enum(["fast-shape", "tuning", "final"]).optional(),
  runsPerLevel: z.number().int().min(1).max(50).optional(),
  outputPrefix: z.string().min(1).optional(),
  authorizedMechanics: z.array(mechanic).optional(),
});

register("read_authoring_context", "Read the selected map graph, rules, effects, customer catalog, and a freshness token before authoring.", { map_id: z.string() }, (a) => service.readAuthoringContext(String(a.map_id)), true);
register("inspect_orderable", "Inspect one orderable composite and all valid nested slots.", { map_id: z.string(), composite: z.string() }, (a) => service.inspectOrderable(String(a.map_id), String(a.composite)), true);
register("get_valid_dish_pieces", "List graph-valid pieces, quantities, nesting, and base prerequisites for a draft dish or composite.", { session_id: z.string(), dish_id: z.string().optional(), composite: z.string().optional() }, (a) => service.getValidDishPieces(String(a.session_id), { dishId: a.dish_id as string | undefined, composite: a.composite as string | undefined }), true);
register("trace_ingredient", "Trace an ingredient backward to pickupable inputs and tools.", { map_id: z.string(), ingredient: z.string() }, (a) => service.traceIngredient(String(a.map_id), String(a.ingredient)), true);
register("list_customer_avatars", "List map-compatible customer avatars, optionally filtered by catalog role.", { map_id: z.string(), role: z.string().optional() }, (a) => service.listCustomerAvatars(String(a.map_id), a.role as string | undefined), true);
register("explain_effect", "Explain one queue or grid effect and its parameters; this does not authorize it.", { map_id: z.string(), scope: z.enum(["queue", "grid"]), effect: z.string() }, (a) => service.explainEffect(String(a.map_id), a.scope as "queue" | "grid", String(a.effect)), true);
register("explain_customer_rules", "Explain active width, preview, boss-barrier, and exclusivity rules.", {}, () => service.explainCustomerRules(), true);
register("list_requirement_dimensions", "List the complete requirement checklist, legal values, map capabilities, and fixed production behavior.", { map_id: z.string() }, (a) => service.listRequirementDimensions(String(a.map_id)), true);
register("list_constraint_metrics", "List registered measurable constraint contracts, optionally for one dimension.", { dimension: z.string().optional() }, (a) => service.listConstraintMetrics(a.dimension as string | undefined), true);
register("refine_level_requirements", "Turn a vague brief and optional answers into measurable requirements and up to three grouped missing-dimension questions. This does not alter a level.", {
  map_id: z.string(), brief: z.string().min(1), answers: z.record(z.string(), z.unknown()).optional(), mode: z.enum(["create", "revise", "batch"]).optional(),
  batch_spec: z.record(z.string(), z.unknown()).optional(), skip_confirmation: z.boolean().optional(),
}, (a) => service.refineLevelRequirements(String(a.map_id), { brief: String(a.brief), answers: a.answers as Record<string, unknown> | undefined, mode: a.mode as "create" | "revise" | "batch" | undefined, batchSpec: a.batch_spec as Record<string, unknown> | undefined, skipConfirmation: a.skip_confirmation as boolean | undefined }), true);
register("confirm_level_requirements", "Confirm an exact requirement set. Optional answer edits are re-refined before confirmation; this does not alter a level.", {
  requirement_token: z.string(), confirmation_note: z.string().min(1), edits: z.object({ answers: z.record(z.string(), z.unknown()).optional() }).optional(),
}, (a) => service.confirmLevelRequirements(String(a.requirement_token), String(a.confirmation_note), a.edits as { answers?: Record<string, unknown> } | undefined));
register("get_refined_requirements", "Reload a refined or confirmed requirement summary by token.", { requirement_token: z.string() }, (a) => service.getRefinedRequirements(String(a.requirement_token)), true);
register("interpret_level_brief", "Compatibility brief parser; also returns first-pass guided requirement refinement.", { map_id: z.string(), brief: z.string().min(1) }, (a) => service.interpretLevelBrief(String(a.map_id), String(a.brief)), true);

register("start_level_session", "Start an obstacle-free revisioned draft from confirmed/skipped requirements, or use the legacy brief plus fresh context token.", {
  map_id: z.string(), context_token: z.string().optional(), brief: z.string().min(1).optional(), requirement_token: z.string().optional(), session_id: z.string().optional(),
  metadata: z.object({ id: z.number().int().optional(), name: z.string().optional(), weather: z.string().optional(), levelTag: z.string().optional(), featureUnlock: z.string().optional(), shuffleDistance: z.number().int().optional(), serveableSlots: z.number().int().min(1).max(2).optional(), outOfSlotPolicy: z.enum(["block-pick", "park-on-grid"]).optional(), boosterCharges: z.array(z.number().int().nonnegative()).optional() }).optional(),
}, (a) => service.startLevelSession({ mapId: String(a.map_id), contextToken: a.context_token as string | undefined, brief: a.brief as string | undefined, requirementToken: a.requirement_token as string | undefined, sessionId: a.session_id as string | undefined, metadata: a.metadata as never }));
register("get_level_session", "Read the current draft, ledger, strategy history, and revision.", { session_id: z.string() }, (a) => service.getSession(String(a.session_id)), true);
register("get_authoring_status", "Return the current authoring phase, blockers, stale evidence, iteration budget, and typed next actions.", { session_id: z.string() }, (a) => service.getAuthoringStatus(String(a.session_id)), true);
register("list_level_candidates", "List candidate summaries and identify the active candidate.", { session_id: z.string() }, (a) => service.listLevelCandidates(String(a.session_id)), true);
register("create_level_candidate", "Branch an isolated candidate from a candidate revision without selecting it.", {
  ...sessionRevision, name: z.string().min(1), from_candidate_id: z.string().optional(), from_revision: z.number().int().nonnegative().optional(),
}, (a) => service.createLevelCandidate(String(a.session_id), Number(a.expected_revision), { name: String(a.name), fromCandidateId: a.from_candidate_id as string | undefined, fromRevision: a.from_revision as number | undefined }));
register("select_level_candidate", "Select a non-rejected candidate as the target of existing granular tools.", { ...sessionRevision, candidate_id: z.string() }, (a) => service.selectLevelCandidate(String(a.session_id), Number(a.expected_revision), String(a.candidate_id)));
register("rename_level_candidate", "Rename a candidate without changing its draft.", { ...sessionRevision, candidate_id: z.string(), name: z.string().min(1) }, (a) => service.renameLevelCandidate(String(a.session_id), Number(a.expected_revision), String(a.candidate_id), String(a.name)));
register("reject_level_candidate", "Mark a non-active candidate rejected while retaining its history and evidence.", { ...sessionRevision, candidate_id: z.string() }, (a) => service.rejectLevelCandidate(String(a.session_id), Number(a.expected_revision), String(a.candidate_id)));
register("compare_level_candidates", "Rank latest candidate evaluations and warn when their seed sets differ.", { session_id: z.string(), candidate_ids: z.array(z.string()).optional() }, (a) => service.compareLevelCandidates(String(a.session_id), a.candidate_ids as string[] | undefined), true);
register("checkpoint_candidate", "Write a candidate-scoped checkpoint without selecting or mutating it.", { session_id: z.string(), candidate_id: z.string(), label: z.string().min(1) }, (a) => service.checkpointCandidate(String(a.session_id), String(a.candidate_id), String(a.label)));
register("restore_candidate_revision", "Restore a revision on the currently selected candidate as a new revision.", { ...sessionRevision, candidate_id: z.string(), revision: z.number().int().nonnegative() }, (a) => service.restoreCandidateRevision(String(a.session_id), Number(a.expected_revision), String(a.candidate_id), Number(a.revision)));
register("create_evaluation_seed_set", "Create and persist deterministic seeds for fair candidate comparison.", {
  session_id: z.string(), name: z.string().optional(), seeds: z.array(z.number().int().nonnegative()).min(1).max(200).optional(), count: z.number().int().min(1).max(200).optional(), base_seed: z.number().int().nonnegative().optional(),
}, (a) => service.createEvaluationSeedSet(String(a.session_id), { name: a.name as string | undefined, seeds: a.seeds as number[] | undefined, count: a.count as number | undefined, baseSeed: a.base_seed as number | undefined }));
register("list_evaluation_seed_sets", "List deterministic evaluation seed sets for a session.", { session_id: z.string() }, (a) => service.listEvaluationSeedSets(String(a.session_id)), true);
register("evaluate_level", "Evaluate one candidate against registered constraints on fixed production behavior and persist the evidence.", {
  session_id: z.string(), candidate_id: z.string().optional(), constraint_ids: z.array(z.string()).optional(), seed_set_id: z.string().optional(), runs: z.number().int().min(1).max(200).optional(), profile: z.enum(["fast-shape", "tuning", "final", "custom"]).optional(),
}, (a) => service.evaluateLevel(String(a.session_id), { candidateId: a.candidate_id as string | undefined, constraintIds: a.constraint_ids as string[] | undefined, seedSetId: a.seed_set_id as string | undefined, runs: a.runs as number | undefined, profile: a.profile as "fast-shape" | "tuning" | "final" | "custom" | undefined }));
register("get_evaluation", "Reload persisted candidate evaluation evidence.", { session_id: z.string(), evaluation_id: z.string() }, (a) => service.getEvaluation(String(a.session_id), String(a.evaluation_id)), true);
register("simulate_level_batch", "Run a bounded non-persisting simulation batch with fixed production behavior.", {
  session_id: z.string(), candidate_id: z.string().optional(), seed_set_id: z.string().optional(), seeds: z.array(z.number().int().nonnegative()).min(1).max(200).optional(), runs: z.number().int().min(1).max(200).optional(),
}, (a) => service.simulateLevelBatch(String(a.session_id), { candidateId: a.candidate_id as string | undefined, seedSetId: a.seed_set_id as string | undefined, seeds: a.seeds as number[] | undefined, runs: a.runs as number | undefined }), true);
register("analyze_queue_pacing", "Summarize lane depth, expanded units, and ordinary pacing imbalance without simulation.", { session_id: z.string(), candidate_id: z.string().optional() }, (a) => service.analyzeQueuePacing(String(a.session_id), a.candidate_id as string | undefined), true);
register("diagnose_constraint_gaps", "Rank failed constraints and map each gap to a focused repair family.", { session_id: z.string(), candidate_id: z.string().optional(), evaluation_id: z.string().optional() }, (a) => service.diagnoseConstraintGaps(String(a.session_id), { candidateId: a.candidate_id as string | undefined, evaluationId: a.evaluation_id as string | undefined }), true);
register("evaluate_mutation_batch", "Apply a bounded action batch to an in-memory clone, score before/after on identical seeds, persist evidence, and leave the candidate unchanged.", {
  ...sessionRevision, candidate_id: z.string().optional(), name: z.string().optional(), proposal_id: z.string().optional(), actions: z.array(proposalAction).min(1).max(200).optional(), seed_set_id: z.string().optional(), seeds: z.array(z.number().int().nonnegative()).min(1).max(50).optional(), runs: z.number().int().min(1).max(50).optional(),
}, (a) => service.evaluateMutationBatch(String(a.session_id), { expectedRevision: Number(a.expected_revision), candidateId: a.candidate_id as string | undefined, name: a.name as string | undefined, proposalId: a.proposal_id as string | undefined, actions: a.actions as ProposalAction[] | undefined, seedSetId: a.seed_set_id as string | undefined, seeds: a.seeds as number[] | undefined, runs: a.runs as number | undefined }));
register("rank_mutation_candidates", "Rank persisted mutation experiments; identical seed sets are required for a reliable recommendation.", { session_id: z.string(), experiment_ids: z.array(z.string()).optional() }, (a) => service.rankMutationCandidates(String(a.session_id), a.experiment_ids as string[] | undefined), true);
register("get_mutation_experiment", "Reload one persisted mutation experiment with exact actions and before/after evidence.", { session_id: z.string(), experiment_id: z.string() }, (a) => service.getMutationExperiment(String(a.session_id), String(a.experiment_id)), true);
register("apply_mutation_batch", "Apply one evaluated mutation experiment atomically to its exact base revision.", { ...sessionRevision, experiment_id: z.string() }, (a) => service.applyMutationBatch(String(a.session_id), Number(a.expected_revision), String(a.experiment_id)));
register("record_search_observation", "Persist a bounded search hypothesis and its evidence disposition without mutating the level.", {
  ...sessionRevision, candidate_id: z.string().optional(), hypothesis: z.string().min(1), before_evidence: z.string().optional(), after_evidence: z.string().optional(), disposition: z.enum(["kept", "reverted", "rejected", "informational"]), notes: z.string().optional(),
}, (a) => service.recordSearchObservation(String(a.session_id), { expectedRevision: Number(a.expected_revision), candidateId: a.candidate_id as string | undefined, hypothesis: String(a.hypothesis), beforeEvidence: a.before_evidence as string | undefined, afterEvidence: a.after_evidence as string | undefined, disposition: a.disposition as "kept" | "reverted" | "rejected" | "informational", notes: a.notes as string | undefined }));
register("suggest_level_mutations", "Suggest focused proposal or repair families from current supply, amount, evaluation, and search memory; never auto-apply.", { session_id: z.string(), candidate_id: z.string().optional() }, (a) => service.suggestLevelMutations(String(a.session_id), a.candidate_id as string | undefined), true);
register("run_search_step", "Evaluate a bounded set of focused proposals on an in-memory candidate clone; never mutate the candidate.", {
  ...sessionRevision, candidate_id: z.string().optional(), seed_set_id: z.string().optional(), runs: z.number().int().min(1).max(50).optional(), max_experiments: z.number().int().min(1).max(10).optional(), budget_ms: z.number().int().min(100).max(30000).optional(),
}, (a) => service.runSearchStep(String(a.session_id), { expectedRevision: Number(a.expected_revision), candidateId: a.candidate_id as string | undefined, seedSetId: a.seed_set_id as string | undefined, runs: a.runs as number | undefined, maxExperiments: a.max_experiments as number | undefined, budgetMs: a.budget_ms as number | undefined }));
register("run_candidate_search", "Run bounded proposal experiments with explicit iteration, evaluation, and wall-time limits; never auto-apply a result.", {
  ...sessionRevision, candidate_id: z.string().optional(), seed_set_id: z.string().optional(), runs: z.number().int().min(1).max(50).optional(), max_iterations: z.number().int().min(1).max(20).optional(), max_experiments_per_step: z.number().int().min(1).max(10).optional(), budget_ms: z.number().int().min(100).max(120000).optional(),
}, (a) => service.runCandidateSearch(String(a.session_id), { expectedRevision: Number(a.expected_revision), candidateId: a.candidate_id as string | undefined, seedSetId: a.seed_set_id as string | undefined, runs: a.runs as number | undefined, maxIterations: a.max_iterations as number | undefined, maxExperimentsPerStep: a.max_experiments_per_step as number | undefined, budgetMs: a.budget_ms as number | undefined }));
register("start_level_batch", "Create a deterministic batch record from a fresh map context and explicit bounded batch specification.", { map_id: z.string(), context_token: z.string(), batch_spec: batchSpec, seed: z.number().int().nonnegative().optional() }, (a) => service.startLevelBatch(String(a.map_id), String(a.context_token), a.batch_spec as never, a.seed as number | undefined));
register("plan_level_batch", "Derive deterministic per-level seeds and curves without creating level sessions.", { batch_id: z.string() }, (a) => service.planLevelBatch(String(a.batch_id)));
register("run_level_batch_step", "Generate and validate a bounded number of batch levels, checkpointing progress after every member.", { batch_id: z.string(), max_levels: z.number().int().min(1).max(10).optional(), budget_ms: z.number().int().min(250).max(300000).optional() }, (a) => service.runLevelBatchStep(String(a.batch_id), { maxLevels: a.max_levels as number | undefined, budgetMs: a.budget_ms as number | undefined }));
register("get_level_batch_status", "Read resumable batch progress and per-level outcomes.", { batch_id: z.string() }, (a) => service.getLevelBatchStatus(String(a.batch_id)), true);
register("finalize_level_batch", "Finalize a completed batch manifest containing only individually valid finalized levels.", { batch_id: z.string() }, (a) => service.finalizeLevelBatch(String(a.batch_id)));
register("cancel_level_batch", "Stop future batch steps while preserving completed sessions and evidence.", { batch_id: z.string() }, (a) => service.cancelLevelBatch(String(a.batch_id)));
register("validate_picking_deadlocks", "Run the queue-only picking-order audit. Grid, tool, supply, and timeout state are excluded; normal checks retain 10 structural cases and full checks retain 50.", {
  session_id: z.string(), candidate_id: z.string().optional(), full_check: z.boolean().optional(),
}, (a) => service.validatePickingDeadlocks(String(a.session_id), { candidateId: a.candidate_id as string | undefined, fullCheck: a.full_check as boolean | undefined }));
register("get_deadlock_cases", "Load representative structurally distinct stuck queue states, including effects, groups, links, and combined-slot geometry.", {
  session_id: z.string(), report_id: z.string(),
}, (a) => service.getDeadlockCases(String(a.session_id), String(a.report_id)), true);
register("analyze_amount_utilization", "Analyze every amount slot under production unpacked behavior, including expanded destinations, stack ranges, demand provenance, and repair targets.", {
  session_id: z.string(), candidate_id: z.string().optional(),
}, (a) => service.analyzeAmountUtilization(String(a.session_id), a.candidate_id as string | undefined), true);
register("propose_customer_plan", "Persist an ordinary customer proposal derived from confirmed scope without mutating the candidate.", {
  session_id: z.string(), candidate_id: z.string().optional(), customer_count: z.number().int().min(1).max(100).optional(), seed: z.number().int().nonnegative().optional(),
}, (a) => service.proposeCustomerPlan(String(a.session_id), { candidateId: a.candidate_id as string | undefined, customerCount: a.customer_count as number | undefined, seed: a.seed as number | undefined }));
register("propose_dish_plan", "Persist graph-valid ordinary dishes for existing customers without mutating the candidate.", {
  session_id: z.string(), candidate_id: z.string().optional(), dishes_per_customer: z.number().int().min(1).max(5).optional(), composites: z.array(z.string()).optional(), seed: z.number().int().nonnegative().optional(),
}, (a) => service.proposeDishPlan(String(a.session_id), { candidateId: a.candidate_id as string | undefined, dishesPerCustomer: a.dishes_per_customer as number | undefined, composites: a.composites as string[] | undefined, seed: a.seed as number | undefined }));
register("propose_level_skeleton", "Persist a composed ordinary customer, dish, exact-supply queue, and amount skeleton without mutating the candidate.", {
  session_id: z.string(), candidate_id: z.string().optional(), customer_count: z.number().int().min(1).max(100).optional(), dishes_per_customer: z.number().int().min(1).max(5).optional(), composites: z.array(z.string()).optional(), lane_count: z.number().int().min(1).max(8).optional(), amount_style: z.enum(["single-unit", "balanced", "compact"]).optional(), seed: z.number().int().nonnegative().optional(),
}, (a) => service.proposeLevelSkeleton(String(a.session_id), { candidateId: a.candidate_id as string | undefined, customerCount: a.customer_count as number | undefined, dishesPerCustomer: a.dishes_per_customer as number | undefined, composites: a.composites as string[] | undefined, laneCount: a.lane_count as number | undefined, amountStyle: a.amount_style as "single-unit" | "balanced" | "compact" | undefined, seed: a.seed as number | undefined }));
register("propose_amount_plan", "Persist conservative, balanced, and/or aggressive queue-line compression proposals without mutating the candidate.", {
  session_id: z.string(), candidate_id: z.string().optional(), styles: z.array(z.enum(["conservative", "balanced", "aggressive"])).min(1).max(3).optional(),
}, (a) => service.proposeAmountPlan(String(a.session_id), { candidateId: a.candidate_id as string | undefined, styles: a.styles as Array<"conservative" | "balanced" | "aggressive"> | undefined }));
register("propose_queue_plan", "Persist an exact-supply queue proposal, optionally partitioned into production-safe atomic amounts, without mutating the candidate.", {
  session_id: z.string(), candidate_id: z.string().optional(), lane_count: z.number().int().min(1).max(8).optional(), amount_style: z.enum(["single-unit", "balanced", "compact"]).optional(),
}, (a) => service.proposeQueuePlan(String(a.session_id), { candidateId: a.candidate_id as string | undefined, laneCount: a.lane_count as number | undefined, amountStyle: a.amount_style as "single-unit" | "balanced" | "compact" | undefined }));
register("propose_repair_mutations", "Persist an atomic repair proposal for unsafe amount releases without mutating the candidate.", {
  session_id: z.string(), candidate_id: z.string().optional(), family: z.enum(["amount"]).optional(),
}, (a) => service.proposeRepairMutations(String(a.session_id), { candidateId: a.candidate_id as string | undefined, family: a.family as "amount" | undefined }));
register("propose_grid_plan", "Persist grid-effect placements with explicit authorization requirements; proposing never grants permission.", {
  session_id: z.string(), candidate_id: z.string().optional(), placements: z.array(z.object({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative(), effect })).min(1).max(100),
}, (a) => service.proposeGridPlan(String(a.session_id), { candidateId: a.candidate_id as string | undefined, placements: a.placements as Array<{ x: number; y: number; effect: { effectId: number; params: number[] } }> }));
register("propose_effect_plan", "Persist queue-effect placements with explicit authorization requirements; proposing never grants permission.", {
  session_id: z.string(), candidate_id: z.string().optional(), placements: z.array(z.object({ slotId: z.string(), effect })).min(1).max(100),
}, (a) => service.proposeEffectPlan(String(a.session_id), { candidateId: a.candidate_id as string | undefined, placements: a.placements as Array<{ slotId: string; effect: { effectId: number; params: number[] } }> }));
register("get_proposal", "Read a proposal, its exact actions, warnings, and current expiry reason.", { session_id: z.string(), proposal_id: z.string() }, (a) => service.getProposal(String(a.session_id), String(a.proposal_id)), true);
register("apply_proposal", "Apply every proposal action atomically to its exact candidate revision; stale proposals are rejected without partial mutation.", { session_id: z.string(), proposal_id: z.string() }, (a) => service.applyProposal(String(a.session_id), String(a.proposal_id)));
register("discard_proposal", "Discard a pending proposal without mutating a candidate.", { session_id: z.string(), proposal_id: z.string() }, (a) => service.discardProposal(String(a.session_id), String(a.proposal_id)));
register("plan_authoring_strategy", "Recommend an adaptive starting route from current constraint dependencies.", { session_id: z.string() }, (a) => service.planAuthoringStrategy(String(a.session_id)), true);
register("set_authoring_strategy", "Record the chosen or changed strategy with rationale and evidence.", { ...sessionRevision, strategy: z.enum(["demand-first", "queue-layout-first", "board-mechanic-first", "difficulty-first-hybrid"]), rationale: z.string(), evidence: z.array(z.string()).optional() }, (a) => service.setAuthoringStrategy(String(a.session_id), Number(a.expected_revision), a.strategy as AuthoringStrategy, String(a.rationale), (a.evidence as string[] | undefined) ?? []));
register("propose_obstacle_options", "Return read-only obstacle options when ordinary tuning cannot meet the brief.", { session_id: z.string() }, (a) => service.proposeObstacleOptions(String(a.session_id)), true);
register("amend_session_requirements", "Record user-approved mechanics in the authorization ledger.", { ...sessionRevision, mechanics: z.array(mechanic).min(1), approval_note: z.string().min(1) }, (a) => service.amendSessionRequirements(String(a.session_id), Number(a.expected_revision), a.mechanics as MechanicAuthorization[], String(a.approval_note)));
register("set_level_constraints", "Revision measurably testable constraints on a guided session. This never authorizes a special mechanic.", {
  ...sessionRevision,
  add: z.array(metricConstraint).optional(),
  update: z.array(z.object({ id: z.string().min(1), patch: metricConstraintPatch })).optional(),
  remove: z.array(z.string().min(1)).optional(),
}, (a) => service.setLevelConstraints(String(a.session_id), Number(a.expected_revision), {
  add: a.add as MetricConstraint[] | undefined,
  update: a.update as Array<{ id: string; patch: Partial<Omit<MetricConstraint, "id">> }> | undefined,
  remove: a.remove as string[] | undefined,
}));
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
register("add_queue_ingredient", "Add explicitly selected pickup slots to one lane; this never generates a queue. `count` is authored slots. Each slot's `amount` is an atomic release of independent one-use items under production behavior.", { ...sessionRevision, lane_id: z.string(), position: z.number().int().nonnegative(), ingredient: z.string(), count: z.number().int().min(1).max(100).optional(), amount: z.number().int().min(1).optional(), provisional: z.boolean().optional() }, (a) => service.addQueueIngredient(String(a.session_id), Number(a.expected_revision), { laneId: String(a.lane_id), position: Number(a.position), ingredient: String(a.ingredient), count: a.count as number | undefined, amount: a.amount as number | undefined, provisional: a.provisional as boolean | undefined }));
register("set_queue_slot_amount", "Set one queue slot's atomic release count. Amount N expands into N independent one-use items; 1 restores a single-unit slot.", { ...sessionRevision, slot_id: z.string(), amount: z.number().int().min(1) }, (a) => service.setQueueSlotAmount(String(a.session_id), Number(a.expected_revision), String(a.slot_id), Number(a.amount)));
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

register("get_supply_demand", "Return exact pickup have/need, recipe chains, yields, amount-expanded unit totals, provenance, and key balance.", { session_id: z.string() }, (a) => service.getSupplyDemand(String(a.session_id)), true);
register("validate_draft", "Run fast graph, supply, group, authorization, and customer checks.", { session_id: z.string() }, (a) => service.validateDraft(String(a.session_id)), true);
register("validate_level", "Run full structural, thaw, tool, capacity, and reachability-oriented checks.", { session_id: z.string() }, (a) => service.validateLevel(String(a.session_id)), true);
register("estimate_difficulty", "Estimate measurable pressure and compare it with the session profile.", { session_id: z.string() }, (a) => service.estimateDifficulty(String(a.session_id)), true);
register("playtest_instant", "Play the exact draft with instant logical transfers while cooking and customer clocks advance normally.", { session_id: z.string() }, (a) => service.playtestInstant(String(a.session_id)), true);
register("checkpoint_level", "Write an append-only revision checkpoint; CSV is included only when serializable.", { session_id: z.string(), label: z.string().min(1) }, (a) => service.checkpointLevel(String(a.session_id), String(a.label)));
register("finalize_level", "Run full validation, estimation, and instant playtest; export only a fundamentally valid result.", { session_id: z.string() }, (a) => service.finalizeLevel(String(a.session_id)));
register("restore_revision", "Restore a prior draft snapshot as a new revision.", { ...sessionRevision, revision: z.number().int().nonnegative() }, (a) => service.restoreRevision(String(a.session_id), Number(a.expected_revision), Number(a.revision)));
register("undo", "Restore the preceding draft snapshot as a new revision.", sessionRevision, (a) => service.undo(String(a.session_id), Number(a.expected_revision)));

await server.connect(new StdioServerTransport());

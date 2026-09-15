import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("CookOrder MCP stdio contract", () => {
  let temporary: string;
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    temporary = await mkdtemp(path.join(tmpdir(), "cookorder-mcp-contract-"));
    const entry = path.join(temporary, "server.mjs");
    await build({ entryPoints: [path.resolve("src/mcp/server.ts")], outfile: entry, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
    client = new Client({ name: "cookorder-contract-test", version: "1.0.0" });
    transport = new StdioClientTransport({ command: process.execPath, args: [entry], cwd: process.cwd(), stderr: "pipe" });
    await client.connect(transport);
  }, 20_000);

  afterAll(async () => {
    await client?.close();
    if (temporary) await rm(temporary, { recursive: true, force: true });
  });

  it("lists the discovery, granular authoring, validation, and checkpoint tools", async () => {
    const result = await client.listTools();
    const names = new Set(result.tools.map((tool) => tool.name));
    [
      "read_authoring_context", "start_level_session", "add_customer", "add_dish_piece",
      "list_requirement_dimensions", "list_constraint_metrics", "refine_level_requirements",
      "confirm_level_requirements", "get_refined_requirements", "get_authoring_status",
      "set_level_constraints",
      "list_level_candidates", "create_level_candidate", "select_level_candidate",
      "rename_level_candidate", "reject_level_candidate", "compare_level_candidates",
      "checkpoint_candidate", "restore_candidate_revision", "create_evaluation_seed_set",
      "list_evaluation_seed_sets", "evaluate_level", "get_evaluation",
      "simulate_level_batch", "analyze_queue_pacing", "diagnose_constraint_gaps",
      "evaluate_mutation_batch", "rank_mutation_candidates", "get_mutation_experiment", "apply_mutation_batch",
      "record_search_observation", "suggest_level_mutations",
      "run_search_step", "run_candidate_search",
      "start_level_batch", "plan_level_batch", "run_level_batch_step",
      "get_level_batch_status", "finalize_level_batch", "cancel_level_batch",
      "validate_picking_deadlocks", "get_deadlock_cases",
      "analyze_amount_utilization", "propose_customer_plan", "propose_dish_plan", "propose_level_skeleton",
      "propose_amount_plan", "propose_queue_plan", "propose_repair_mutations", "propose_grid_plan", "propose_effect_plan", "get_proposal",
      "apply_proposal", "discard_proposal",
      "add_queue_ingredient", "set_queue_slot_amount", "split_queue_slot", "merge_queue_slots",
      "set_grid_cell_effect", "get_supply_demand", "validate_level",
      "estimate_difficulty", "playtest_instant", "finalize_level", "undo",
    ].forEach((name) => expect(names.has(name), name).toBe(true));
    expect(names.has("generate_level")).toBe(false);
  });

  it("returns structured authoring context over stdio", async () => {
    const result = await client.callTool({ name: "read_authoring_context", arguments: { map_id: "burger" } });
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as { contextToken?: string; graph?: unknown };
    expect(structured.contextToken).toMatch(/^[a-f0-9]{64}$/);
    expect(structured.graph).toBeTruthy();
  });
});

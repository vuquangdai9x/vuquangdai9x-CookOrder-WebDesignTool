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

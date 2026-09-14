import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LevelAuthoringService } from "./service.ts";

describe("LevelAuthoringService", () => {
  let outputRoot: string;
  let service: LevelAuthoringService;

  beforeEach(async () => {
    outputRoot = await mkdtemp(path.join(tmpdir(), "cookorder-mcp-test-"));
    service = new LevelAuthoringService(process.cwd(), outputRoot);
  });

  afterEach(async () => {
    await rm(outputRoot, { recursive: true, force: true });
  });

  async function start(brief = "Create a standard ordinary level.") {
    const maps = await service.repository.listMaps();
    const context = await service.readAuthoringContext(maps[0].id);
    const result = await service.startLevelSession({
      mapId: maps[0].id,
      contextToken: String(context.contextToken),
      brief,
      sessionId: `test-${Date.now()}`,
    });
    return { maps, context, result, sessionId: String(result.sessionId) };
  }

  it("returns complete discovery context and rejects stale tokens", async () => {
    const maps = await service.repository.listMaps();
    const context = await service.readAuthoringContext(maps[0].id);
    expect(context.contextToken).toMatch(/^[a-f0-9]{64}$/);
    expect((context.graph as { pickupables: unknown[] }).pickupables.length).toBeGreaterThan(0);
    await expect(service.startLevelSession({ mapId: maps[0].id, contextToken: "stale", brief: "ordinary" })).rejects.toThrow(/stale/i);
  });

  it("enforces optimistic revisions and rejects unauthorized mechanics", async () => {
    const { sessionId } = await start();
    const lane = await service.addQueueLane(sessionId, 0);
    await expect(service.addQueueLane(sessionId, 0)).rejects.toThrow(/revision conflict/i);
    const session = await service.getSession(sessionId);
    const cell = session.draft.grid[0];
    await expect(service.setGridCellEffect(sessionId, lane.revision, cell.x, cell.y, { effectId: 1, params: [] })).rejects.toThrow(/not authorized/i);
  });

  it("supports queue-first provisional authoring and reports have/need", async () => {
    const { sessionId, context } = await start("Build an ordinary level around its queue layout.");
    const laneResult = await service.addQueueLane(sessionId, 0);
    const session = await service.getSession(sessionId);
    const pickupable = (context.graph as { pickupables: Array<{ name: string }> }).pickupables[0];
    await service.addQueueIngredient(sessionId, laneResult.revision, { laneId: session.draft.lanes[0].id, position: 0, ingredient: pickupable.name, provisional: true });
    const supply = await service.getSupplyDemand(sessionId);
    expect((supply.ingredients as Array<{ pickupHave: number }>)[0].pickupHave).toBe(1);
    const validation = await service.validateDraft(sessionId);
    expect((validation.findings as Array<{ code: string }>).some((finding) => finding.code === "PROVISIONAL_SUPPLY")).toBe(true);
  });

  it("constructs dish demand manually and reconciles it with explicit queue pickups", async () => {
    const { sessionId, context } = await start("Create an ordinary recipe-focused level.");
    const orderable = (context.graph as { orderables: Array<{ name: string }> }).orderables[0];
    const customerResult = await service.addCustomer(sessionId, 0, { typeId: 0, waitTime: 0, weatherEff: 0 });
    const customer = (await service.getSession(sessionId)).draft.customers[0];
    const dishResult = await service.addDish(sessionId, customerResult.revision, customer.id, orderable.name);
    const dish = (await service.getSession(sessionId)).draft.customers[0].dishes[0];
    const choices = await service.getValidDishPieces(sessionId, { dishId: dish.id });
    const slot = (choices.slots as Array<{
      slotIndex: number;
      missingPrerequisiteBase?: string;
      options: Array<{ name: string }>;
    }>).find((candidate) => !candidate.missingPrerequisiteBase && candidate.options.length > 0);
    expect(slot).toBeDefined();

    const pieceResult = await service.addDishPiece(
      sessionId,
      dishResult.revision,
      dish.id,
      slot!.slotIndex,
      slot!.options[0].name,
    );
    const demand = await service.getSupplyDemand(sessionId);
    const missing = (demand.ingredients as Array<{ ingredient: string; pickupNeed: number; missing: number }>).filter((item) => item.missing > 0);
    expect(missing.length).toBeGreaterThan(0);

    const laneResult = await service.addQueueLane(sessionId, pieceResult.revision);
    const lane = (await service.getSession(sessionId)).draft.lanes[0];
    let revision = laneResult.revision;
    for (const item of missing) {
      const added = await service.addQueueIngredient(sessionId, revision, {
        laneId: lane.id,
        position: lane.slots.length,
        ingredient: item.ingredient,
        count: item.pickupNeed,
      });
      revision = added.revision;
    }
    const reconciled = await service.getSupplyDemand(sessionId);
    expect((reconciled.ingredients as Array<{ missing: number }>).every((item) => item.missing === 0)).toBe(true);
  });

  it("records approval before allowing a special mechanic and can undo", async () => {
    const { sessionId } = await start();
    const amended = await service.amendSessionRequirements(sessionId, 0, ["grid:blocked"], "Designer approved blocked cells.");
    const changed = await service.setGridCellEffect(sessionId, amended.revision, 0, 0, { effectId: 1, params: [] });
    expect((await service.getSession(sessionId)).draft.grid[0].effects).toHaveLength(1);
    await service.undo(sessionId, changed.revision);
    expect((await service.getSession(sessionId)).draft.grid[0].effects).toHaveLength(0);
  });
});

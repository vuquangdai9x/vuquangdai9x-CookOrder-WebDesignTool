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

  it("counts expanded amount units and exposes the slot-menu amount, split, and merge operations", async () => {
    const { sessionId, context } = await start("Build an ordinary level around amount-compressed queue lines.");
    const laneResult = await service.addQueueLane(sessionId, 0);
    const lane = (await service.getSession(sessionId)).draft.lanes[0];
    const pickupable = (context.graph as {
      pickupables: Array<{ name: string; stackRange: { min: number; max: number }; multipleUsage: boolean }>;
    }).pickupables[0];
    expect(pickupable.stackRange.min).toBeGreaterThanOrEqual(1);
    const reusable = (context.graph as {
      pickupables: Array<{ name: string; multipleUsage: boolean }>;
    }).pickupables.find((item) => item.name === "cheese-sauce");
    expect(reusable?.multipleUsage).toBe(true);

    const added = await service.addQueueIngredient(sessionId, laneResult.revision, {
      laneId: lane.id,
      position: 0,
      ingredient: pickupable.name,
      amount: 5,
    });
    const supply = await service.getSupplyDemand(sessionId);
    const row = (supply.ingredients as Array<{ ingredient: string; pickupHave: number }>).find(
      (item) => item.ingredient === pickupable.name,
    );
    expect(row?.pickupHave).toBe(5);

    const slot = (await service.getSession(sessionId)).draft.lanes[0].slots[0];
    const resized = await service.setQueueSlotAmount(sessionId, added.revision, slot.id, 6);
    const split = await service.splitQueueSlot(sessionId, resized.revision, slot.id, 2);
    let slots = (await service.getSession(sessionId)).draft.lanes[0].slots;
    expect(slots.map((item) => item.amount ?? 1)).toEqual([2, 4]);

    await service.mergeQueueSlots(sessionId, split.revision, slots.map((item) => item.id));
    slots = (await service.getSession(sessionId)).draft.lanes[0].slots;
    expect(slots).toHaveLength(1);
    expect(slots[0].id).toBe(slot.id);
    expect(slots[0].amount).toBe(6);
  });

  it("refines, confirms, reloads, and starts from guided requirements", async () => {
    const maps = await service.repository.listMaps();
    const mapId = maps[0].id;
    const vague = await service.refineLevelRequirements(mapId, { brief: "Make a fair level." });
    expect(vague.confirmationStatus).toBe("draft");
    expect(vague.unresolved.length).toBeGreaterThan(0);
    expect(vague.unresolved.length).toBeLessThanOrEqual(3);
    await expect(service.confirmLevelRequirements(vague.requirementToken, "Looks good.")).rejects.toThrow(/unresolved/i);

    const refined = await service.refineLevelRequirements(mapId, {
      brief: vague.originalBrief,
      answers: { difficultyProfile: "standard", customerCount: 3, amountUtilization: 0.35, maxAmount: 3 },
    });
    expect(refined.unresolved).toEqual([]);
    const confirmed = await service.confirmLevelRequirements(refined.requirementToken, "Approved for authoring.");
    expect(confirmed.confirmationStatus).toBe("confirmed");
    expect((await service.getRefinedRequirements(confirmed.requirementToken)).confirmationNote).toBe("Approved for authoring.");

    const result = await service.startLevelSession({
      mapId,
      requirementToken: confirmed.requirementToken,
      sessionId: `guided-${Date.now()}`,
      metadata: { outOfSlotPolicy: "block-pick" },
    });
    expect(result.started).toBe(true);
    expect((result.productionBehavior as { packingMode: string }).packingMode).toBe("unpacked-raw");
    expect((result.findings as Array<{ code: string }>).some((finding) => finding.code === "BEHAVIOR_NORMALIZED")).toBe(true);
    const session = await service.getSession(String(result.sessionId));
    expect(session.requirements?.requirementToken).toBe(confirmed.requirementToken);
    expect(session.draft.level.outOfSlotPolicy).toBe("park-on-grid");

    if (!session.requirements) throw new Error("Expected guided requirements on the session.");
    const originalRequirementToken = session.requirements.requirementToken;
    const changed = await service.setLevelConstraints(String(result.sessionId), 0, {
      add: [{ id: "custom-lanes", dimension: "queue", metric: "queue.laneCount", operator: "=", value: 4, priority: "target", weight: 3, source: "Designer amendment" }],
    });
    expect((await service.getRefinedRequirements(String(changed.requirementToken))).constraints.some((item) => item.id === "custom-lanes")).toBe(true);
    expect((await service.getSession(String(result.sessionId))).requirements?.requirementToken).not.toBe(originalRequirementToken);
    await service.undo(String(result.sessionId), changed.revision);
    expect((await service.getSession(String(result.sessionId))).requirements?.constraints.some((item) => item.id === "custom-lanes")).toBe(false);
  });

  it("supports an explicit refinement bypass and reports guided status", async () => {
    const maps = await service.repository.listMaps();
    const requirements = await service.refineLevelRequirements(maps[0].id, {
      brief: "Create an ordinary amount-aware level and skip confirmation.",
      skipConfirmation: true,
    });
    expect(requirements.confirmationStatus).toBe("skipped");
    expect(requirements.unresolved).toEqual([]);
    const result = await service.startLevelSession({ mapId: maps[0].id, requirementToken: requirements.requirementToken, sessionId: `skip-${Date.now()}` });
    const status = await service.getAuthoringStatus(String(result.sessionId));
    expect(status.phase).toBe("strategy");
    expect((status.productionBehavior as { toolProcessBehavior: string }).toolProcessBehavior).toBe("auto");
  });

  it("migrates sessions to isolated candidates and persists deterministic evaluation evidence", async () => {
    const { sessionId } = await start("Create a standard amount-aware level with 2 customers.");
    let session = await service.getSession(sessionId);
    expect(session.schemaVersion).toBe(2);
    expect(session.activeCandidateId).toBe("candidate-main");

    const firstLane = await service.addQueueLane(sessionId, 0);
    const branched = await service.createLevelCandidate(sessionId, firstLane.revision, { name: "Lower pressure" });
    const candidateId = String((branched.candidate as { id: string }).id);
    const secondLane = await service.addQueueLane(sessionId, firstLane.revision);
    expect((await service.getSession(sessionId)).draft.lanes).toHaveLength(2);

    const selected = await service.selectLevelCandidate(sessionId, secondLane.revision, candidateId);
    expect(selected.revision).toBe(0);
    expect((await service.getSession(sessionId)).draft.lanes).toHaveLength(1);
    await service.removeQueueLane(sessionId, 0, (await service.getSession(sessionId)).draft.lanes[0].id);
    await service.selectLevelCandidate(sessionId, 1, "candidate-main");
    session = await service.getSession(sessionId);
    expect(session.draft.lanes).toHaveLength(2);

    const seedSetResult = await service.createEvaluationSeedSet(sessionId, { name: "Comparison", seeds: [11, 22] });
    const seedSet = seedSetResult.seedSet as { id: string; seeds: number[] };
    expect(seedSet.seeds).toEqual([11, 22]);
    const evaluation = await service.evaluateLevel(sessionId, { seedSetId: seedSet.id, runs: 2, profile: "fast-shape" });
    expect(evaluation.behaviorSemanticsVersion).toBe("2026-09-15-default-v1");
    expect(evaluation.seeds).toEqual([11, 22]);
    expect(evaluation.artifactPath).toMatch(/^evaluations\//);
    expect((await service.getEvaluation(sessionId, evaluation.id)).id).toBe(evaluation.id);
    const comparison = await service.compareLevelCandidates(sessionId);
    expect(comparison.recommendedCandidateId).toBe("candidate-main");
    const deadlock = await service.validatePickingDeadlocks(sessionId, { fullCheck: false });
    expect((deadlock.conclusion as { storedCases: number; caseLimit: number }).storedCases).toBe(0);
    expect((deadlock.conclusion as { caseLimit: number }).caseLimit).toBe(10);
    expect((await service.getDeadlockCases(sessionId, String(deadlock.reportId))).cases).toEqual([]);
    const mutation = await service.addQueueLane(sessionId, session.revision);
    expect(mutation.invalidatedEvidence).toEqual([evaluation.id]);
    expect((await service.getAuthoringStatus(sessionId)).staleEvidence).toContain(evaluation.id);
    expect((await service.getAuthoringStatus(sessionId)).staleEvidence).toContain(deadlock.reportId);
  });

  it("proposes and atomically applies production-aware amount compression", async () => {
    const maps = await service.repository.listMaps();
    const coffee = maps.find((map) => /coffee/i.test(map.name));
    if (!coffee) throw new Error("Coffee test map not found.");
    const context = await service.readAuthoringContext(coffee.id);
    const started = await service.startLevelSession({
      mapId: coffee.id,
      contextToken: String(context.contextToken),
      brief: "Create a standard amount-aware level with 2 customers.",
      sessionId: `amount-plan-${Date.now()}`,
    });
    const sessionId = String(started.sessionId);
    const pickupable = (context.graph as { pickupables: Array<{ name: string; stackRange: { min: number; max: number } }> }).pickupables.find((item) => item.stackRange.max >= 4);
    if (!pickupable) throw new Error("Amount-capable pickupable not found.");
    const laneResult = await service.addQueueLane(sessionId, 0);
    const lane = (await service.getSession(sessionId)).draft.lanes[0];
    const added = await service.addQueueIngredient(sessionId, laneResult.revision, { laneId: lane.id, position: 0, ingredient: pickupable.name, count: 4 });

    const before = await service.analyzeAmountUtilization(sessionId);
    expect((before.summary as { authoredSlots: number; expandedItems: number }).authoredSlots).toBe(4);
    expect((before.summary as { expandedItems: number }).expandedItems).toBe(4);

    const proposed = await service.proposeAmountPlan(sessionId, { styles: ["conservative", "aggressive"] });
    expect((await service.getSession(sessionId)).revision).toBe(added.revision);
    const proposals = proposed.proposals as Array<{ id: string; name: string; actions: unknown[] }>;
    const aggressive = proposals.find((proposal) => /aggressive/i.test(proposal.name));
    const conservative = proposals.find((proposal) => /conservative/i.test(proposal.name));
    expect(aggressive?.actions.length).toBeGreaterThan(0);
    if (!aggressive || !conservative) throw new Error("Expected both amount proposal styles.");

    const applied = await service.applyProposal(sessionId, aggressive.id);
    expect(applied.revision).toBe(added.revision + 1);
    const after = await service.analyzeAmountUtilization(sessionId);
    expect((after.summary as { authoredSlots: number }).authoredSlots).toBeLessThan(4);
    expect((after.summary as { expandedItems: number }).expandedItems).toBe(4);
    expect((await service.getProposal(sessionId, aggressive.id)).proposal).toMatchObject({ status: "applied", appliedRevision: applied.revision });
    expect(await service.getProposal(sessionId, conservative.id)).toMatchObject({ expired: true });
    await expect(service.applyProposal(sessionId, conservative.id)).rejects.toThrow(/expired/i);

    const discardable = await service.proposeAmountPlan(sessionId, { styles: ["balanced"] });
    const discardId = String((discardable.proposals as Array<{ id: string }>)[0].id);
    expect(await service.discardProposal(sessionId, discardId)).toMatchObject({ status: "discarded" });

    const compacted = await service.getSession(sessionId);
    const compactedSlot = compacted.draft.lanes[0].slots[0];
    const oversizedAmount = pickupable.stackRange.max + 5;
    const oversized = await service.setQueueSlotAmount(sessionId, compacted.revision, compactedSlot.id, oversizedAmount);
    const repairResult = await service.proposeRepairMutations(sessionId, { family: "amount" });
    expect((await service.getSession(sessionId)).revision).toBe(oversized.revision);
    const repair = repairResult.proposal as { id: string; actions: Array<{ tool: string }> };
    expect(repair.actions.length).toBeGreaterThan(0);
    expect(repair.actions.every((action) => action.tool === "split_queue_slot")).toBe(true);

    const repaired = await service.applyProposal(sessionId, repair.id);
    expect(repaired.revision).toBe(oversized.revision + 1);
    const repairedAnalysis = await service.analyzeAmountUtilization(sessionId);
    expect((repairedAnalysis.summary as { expandedItems: number }).expandedItems).toBe(oversizedAmount);
    expect((repairedAnalysis.summary as { maxAmount: number }).maxAmount).toBeLessThanOrEqual(pickupable.stackRange.max);
    expect((repairedAnalysis.slots as Array<{ withinStackRange: boolean }>).every((slot) => slot.withinStackRange)).toBe(true);
    expect((await service.getProposal(sessionId, repair.id)).proposal).toMatchObject({ status: "applied", appliedRevision: repaired.revision });
  });

  it("proposes and atomically applies an ordinary exact-supply level skeleton", async () => {
    const maps = await service.repository.listMaps();
    const coffee = maps.find((map) => /coffee/i.test(map.name));
    if (!coffee) throw new Error("Coffee test map not found.");
    const context = await service.readAuthoringContext(coffee.id);
    const started = await service.startLevelSession({
      mapId: coffee.id,
      contextToken: String(context.contextToken),
      brief: "Create a standard amount-aware level with 2 customers.",
      sessionId: `skeleton-${Date.now()}`,
    });
    const sessionId = String(started.sessionId);
    const proposed = await service.proposeLevelSkeleton(sessionId, { customerCount: 2, dishesPerCustomer: 1, laneCount: 2, amountStyle: "balanced", seed: 17 });
    expect((await service.getSession(sessionId)).revision).toBe(0);
    const proposal = proposed.proposal as { id: string; actions: Array<{ tool: string }> };
    const tools = new Set(proposal.actions.map((action) => action.tool));
    ["add_customer", "add_dish", "add_dish_piece", "add_queue_lane", "add_queue_ingredient"].forEach((tool) => expect(tools.has(tool), tool).toBe(true));
    const search = await service.runCandidateSearch(sessionId, { expectedRevision: 0, runs: 1, maxIterations: 1, maxExperimentsPerStep: 1, budgetMs: 5_000 });
    expect((await service.getSession(sessionId)).revision).toBe(0);
    expect(search).toMatchObject({ candidateMutated: false, iterations: 1, evaluatedExperimentCount: 1 });
    const experimentId = String(search.recommendedExperimentId);
    const experiment = (await service.getSession(sessionId)).experiments?.[experimentId] as { id: string; before: { hardFailures: unknown[] }; after: { hardFailures: unknown[] } };
    expect(experiment.after.hardFailures.length).toBeLessThan(experiment.before.hardFailures.length);
    expect(await service.rankMutationCandidates(sessionId, [experiment.id])).toMatchObject({ recommendedExperimentId: experiment.id, commonSeeds: true });
    const applied = await service.applyMutationBatch(sessionId, 0, experiment.id);
    expect(applied.revision).toBe(1);
    const session = await service.getSession(sessionId);
    expect(session.draft.customers).toHaveLength(2);
    expect(session.draft.customers.every((customer) => customer.dishes.length === 1)).toBe(true);
    expect(session.draft.lanes).toHaveLength(2);
    const supply = await service.getSupplyDemand(sessionId);
    expect(supply.missing).toEqual([]);
    expect((supply.ingredients as Array<{ surplus: number }>).every((item) => item.surplus === 0)).toBe(true);
    const simulation = await service.simulateLevelBatch(sessionId, { seeds: [17], runs: 1 });
    expect(simulation).toMatchObject({ revision: 1, runs: 1 });
    const pacing = await service.analyzeQueuePacing(sessionId);
    expect((pacing.summary as { laneCount: number }).laneCount).toBe(2);
    const evaluation = await service.evaluateLevel(sessionId, { runs: 1, profile: "fast-shape" });
    const diagnosis = await service.diagnoseConstraintGaps(sessionId, { evaluationId: evaluation.id });
    expect(diagnosis).toMatchObject({ evaluationId: evaluation.id, stale: false });
    const observation = await service.recordSearchObservation(sessionId, { expectedRevision: 1, hypothesis: "The ordinary skeleton resolves structural and supply gaps.", beforeEvidence: experiment.id, afterEvidence: evaluation.id, disposition: "kept" });
    expect(observation).toMatchObject({ revision: 1, observation: { disposition: "kept" } });
    expect((await service.suggestLevelMutations(sessionId)).priorObservations).toHaveLength(1);
  });

  it("plans, resumes, and finalizes a bounded deterministic level batch", async () => {
    const maps = await service.repository.listMaps();
    const coffee = maps.find((map) => /coffee/i.test(map.name));
    if (!coffee) throw new Error("Coffee test map not found.");
    const context = await service.readAuthoringContext(coffee.id);
    const started = await service.startLevelBatch(coffee.id, String(context.contextToken), {
      levelCount: 1,
      customerRange: [1, 1],
      dishesPerCustomer: 1,
      laneRange: [1, 1],
      amountUtilizationCurve: ["balanced"],
      difficultyCurve: ["standard"],
      validationProfile: "fast-shape",
      runsPerLevel: 1,
      outputPrefix: "MCP batch test",
    }, 1234);
    const batchId = String(started.batchId);
    const planned = await service.planLevelBatch(batchId);
    const members = planned.members as Array<{ seed: number; status: string }>;
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ status: "planned" });
    expect((await service.planLevelBatch(batchId)).members).toEqual(planned.members);
    const step = await service.runLevelBatchStep(batchId, { maxLevels: 1, budgetMs: 30_000 });
    expect(step).toMatchObject({ status: "complete", attempted: 1, progress: { processed: 1, total: 1 } });
    const finalized = await service.finalizeLevelBatch(batchId);
    const status = await service.getLevelBatchStatus(batchId);
    expect(status.status).toBe("finalized");
    const validCount = (status.members as Array<{ status: string }>).filter((member) => member.status === "valid").length;
    expect((finalized.exported as unknown[]).length).toBe(validCount);
    for (const member of status.members as Array<{ status: string; sessionId: string }>) {
      if (member.status !== "valid") continue;
      const published = await service.store.load(member.sessionId);
      expect(published.finalization).toMatchObject({
        candidateId: published.activeCandidateId,
        revision: published.revision,
      });
    }
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

    const queuePlanResult = await service.proposeQueuePlan(sessionId, { laneCount: 2, amountStyle: "compact" });
    expect((await service.getSession(sessionId)).revision).toBe(pieceResult.revision);
    const queuePlan = queuePlanResult.proposal as { id: string; actions: Array<{ tool: string }>; expectedSupplyDelta: Record<string, number> };
    expect(queuePlan.actions.some((action) => action.tool === "add_queue_lane")).toBe(true);
    expect(queuePlan.actions.some((action) => action.tool === "add_queue_ingredient")).toBe(true);
    for (const item of missing) expect(queuePlan.expectedSupplyDelta[item.ingredient]).toBe(item.pickupNeed);
    const appliedQueue = await service.applyProposal(sessionId, queuePlan.id);
    expect(appliedQueue.revision).toBe(pieceResult.revision + 1);
    const amountAnalysis = await service.analyzeAmountUtilization(sessionId);
    expect((amountAnalysis.slots as Array<{ withinStackRange: boolean; capacitySafeOnEmptyGrid: boolean }>).every((slot) => slot.withinStackRange && slot.capacitySafeOnEmptyGrid)).toBe(true);
    const reconciled = await service.getSupplyDemand(sessionId);
    expect((reconciled.ingredients as Array<{ missing: number }>).every((item) => item.missing === 0)).toBe(true);
  });

  it("records approval before allowing a special mechanic and can undo", async () => {
    const { sessionId } = await start();
    const blocked = await service.proposeGridPlan(sessionId, { placements: [{ x: 0, y: 0, effect: { effectId: 1, params: [] } }] });
    const blockedProposal = blocked.proposal as { id: string };
    expect(blocked).toMatchObject({ blocked: true, missingAuthorization: ["grid:blocked"] });
    await expect(service.applyProposal(sessionId, blockedProposal.id)).rejects.toThrow(/explicit authorization/i);
    await service.amendSessionRequirements(sessionId, 0, ["grid:blocked"], "Designer approved blocked cells.");
    const approved = await service.proposeGridPlan(sessionId, { placements: [{ x: 0, y: 0, effect: { effectId: 1, params: [] } }] });
    expect(approved).toMatchObject({ blocked: false, missingAuthorization: [] });
    const changed = await service.applyProposal(sessionId, String((approved.proposal as { id: string }).id));
    expect((await service.getSession(sessionId)).draft.grid[0].effects).toHaveLength(1);
    await service.undo(sessionId, changed.revision);
    expect((await service.getSession(sessionId)).draft.grid[0].effects).toHaveLength(0);
  });

  it("learns committed queue style before refining guided requirements", async () => {
    const references = await service.analyzeReferenceLevels("burger", { targetLevel: 10, cohortRadius: 5 });
    expect(references).toMatchObject({ mapId: "burger" });
    expect((references.cohort as unknown[]).length).toBeGreaterThanOrEqual(3);
    expect((references.recommendedTargets as { amountStyle: string }).amountStyle).toBe("balanced");

    const requirements = await service.refineLevelRequirements("burger", {
      brief: "Create a varied standard level with 10 customers.",
      answers: { difficultyProfile: "standard", customerCount: 10, levelId: 10 },
    });
    expect((requirements.dimensions.queueTexture as { referenceProfileId: string }).referenceProfileId).toMatch(/^reference-/);
    expect(requirements.constraints.some((constraint) => constraint.metric === "queue.adjacentDuplicateRatio")).toBe(true);
    expect(requirements.constraints.some((constraint) => constraint.metric === "amount.amountSlotRatio")).toBe(true);

    const tutorial = await service.refineLevelRequirements("burger", {
      brief: "Create a simple tutorial level with 3 customers and intentionally use only single-unit queue slots.",
      answers: { difficultyProfile: "relaxed", customerCount: 3, levelId: 2, amountUtilization: "single-unit" },
    });
    expect((tutorial.dimensions.amount as { utilization: string }).utilization).toBe("single-unit");
    expect(tutorial.constraints.some((constraint) => constraint.metric === "amount.amountSlotRatio")).toBe(false);
    expect(tutorial.constraints.some((constraint) => constraint.metric === "queue.adjacentDuplicateRatio")).toBe(true);
  });
});

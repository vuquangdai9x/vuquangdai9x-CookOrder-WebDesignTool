import { describe, expect, it } from "vitest";
import { parseQueueGroups, parseQueues } from "../../core/nodeParser.ts";
import burgerLevelsCsv from "../../data/config/nodegraph/maps/LevelData-1-Burger.csv?raw";
import coffeeLevelsCsv from "../../data/config/nodegraph/maps/LevelData-2-Coffee.csv?raw";
import { importLevelsCsv } from "../../data/sheetSource.ts";
import { checkQueueThaw } from "./queueThawCheck.ts";

// Cost guard for the Validate Ice button: the full audit (exhaustive walk +
// strategy playthroughs + 500 random orders) has to stay interactive on every
// shipped level, or the button stops feeling like a button.
describe("checkQueueThaw over every shipped level", () => {
  const levels = [burgerLevelsCsv, coffeeLevelsCsv].flatMap((csv) =>
    importLevelsCsv(csv),
  );

  it("stays interactive for every level in the game", () => {
    let worst = 0;
    let worstName = "";
    let frozenLevels = 0;
    const bad: string[] = [];
    for (const level of levels) {
      const queues = parseQueues(level.queueString);
      const groups = parseQueueGroups(level.queueString);
      const started = performance.now();
      const report = checkQueueThaw(queues, groups);
      const elapsed = performance.now() - started;
      if (elapsed > worst) {
        worst = elapsed;
        worstName = level.name;
      }
      if (!report.trivial) frozenLevels++;
      if (report.verdict === "deadlock") bad.push(`${level.name}: ${report.message}`);
      if (report.verdict === "risky") console.log(`risky ${level.name}: ${report.message}`);
    }
    console.log(
      `thaw check: ${levels.length} levels, ${frozenLevels} with freeze, worst ${worst.toFixed(2)}ms (${worstName})`,
    );
    if (bad.length) console.log("deadlocks found:\n" + bad.join("\n"));
    expect(worst).toBeLessThan(3500);
  });
});

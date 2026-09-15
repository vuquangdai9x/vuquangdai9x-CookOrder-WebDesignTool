import { describe, expect, it } from "vitest";
import {
  analyzeQueueTexture,
  queueLanesFromString,
  queueSequenceSimilarity,
  referenceStyleDistance,
  textureEnvelope,
} from "./queueTexture.ts";

describe("queue texture", () => {
  it("parses queue amounts while ignoring effects and groups", () => {
    const lanes = queueLanesFromString("3:2#1:4,7%8,9$$0-0,1-0");
    expect(lanes).toEqual([
      [{ ingredient: "3", amount: 2 }, { ingredient: "7", amount: 1 }],
      [{ ingredient: "8", amount: 1 }, { ingredient: "9", amount: 1 }],
    ]);
  });

  it("distinguishes cloned repetitive queues from varied amount-aware queues", () => {
    const dull = analyzeQueueTexture(queueLanesFromString("1,1,2,2%1,1,2,2%1,1,2,2"));
    const varied = analyzeQueueTexture(queueLanesFromString("1:2,3,2,4%2,4:2,1,3%3,2,4,1"));
    expect(dull.adjacentDuplicateRatio).toBeGreaterThan(varied.adjacentDuplicateRatio);
    expect(dull.crossLaneCloneRatio).toBe(1);
    expect(varied.crossLaneCloneRatio).toBeLessThan(0.2);
    expect(varied.amountSlotRatio).toBeGreaterThan(0);
    expect(varied.transitionEntropy).toBeGreaterThan(dull.transitionEntropy);
  });

  it("measures style-envelope distance and sequence copying independently", () => {
    const references = [
      analyzeQueueTexture(queueLanesFromString("1:2,2,3%2,3,1")),
      analyzeQueueTexture(queueLanesFromString("2,3:2,1%3,1,2")),
      analyzeQueueTexture(queueLanesFromString("3,1,2:2%1,2,3")),
    ];
    const envelope = textureEnvelope(references);
    expect(referenceStyleDistance(references[1], envelope)).toBeLessThan(0.4);
    const queue = queueLanesFromString("1,2,3,4%4,3,2,1");
    expect(queueSequenceSimilarity(queue, queue)).toBe(1);
    expect(queueSequenceSimilarity(queue, queueLanesFromString("8,8,8,8%9,9,9,9"))).toBe(0);
  });
});

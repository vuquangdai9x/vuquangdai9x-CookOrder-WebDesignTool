import { describe, expect, it } from "vitest";
import {
  canEmailWriteRemoteAuthor,
  pushedAuthorValue,
  REMOTE_AUTHORS,
  remoteAuthorAssignedLevels,
  remoteAuthorForTable,
} from "./remoteAuthors.ts";

describe("remote author config", () => {
  it("matches author tables case-insensitively", () => {
    expect(remoteAuthorForTable(" maplevelprogress_linh ")?.author).toBe("linhnth");
    expect(remoteAuthorForTable("unknown")).toBeUndefined();
  });

  it("keeps default and daivq unassigned", () => {
    expect(REMOTE_AUTHORS.find((author) => author.author === "default")?.assigned).toBeUndefined();
    expect(REMOTE_AUTHORS.find((author) => author.author === "daivq")?.assigned).toBeUndefined();
  });

  it("assigns Tan every fifth level and Linh the complement through level 100", () => {
    const tan = REMOTE_AUTHORS.find((author) => author.author === "tantd")!;
    const linh = REMOTE_AUTHORS.find((author) => author.author === "linhnth")!;
    expect(tan.assigned).toHaveLength(8);
    expect(linh.assigned).toHaveLength(8);
    expect(tan.assigned?.[0].lv).toContain("100");
    expect(linh.assigned?.[0].lv).not.toMatch(/(^|;)5($|;)/);
  });

  it("checks author email allowlists case-insensitively", () => {
    const defaultAuthor = REMOTE_AUTHORS.find((author) => author.author === "default")!;
    const tan = REMOTE_AUTHORS.find((author) => author.author === "tantd")!;
    expect(canEmailWriteRemoteAuthor(defaultAuthor, "ANHPD@abigames.com.vn")).toBe(true);
    expect(canEmailWriteRemoteAuthor(tan, "daivq@abigames.com.vn")).toBe(false);
  });

  it("derives the author written by a tool push", () => {
    expect(pushedAuthorValue("MapLevelProgress", "linhnth")).toBe("linhnth");
    expect(pushedAuthorValue("MapLevelProgress-tan", "linhnth")).toBe("tantd");
    expect(pushedAuthorValue("My-Custom-Sheet", "linhnth")).toBe("");
  });

  it("expands compact assigned-level ranges", () => {
    const tan = REMOTE_AUTHORS.find((author) => author.author === "tantd")!;
    const linh = REMOTE_AUTHORS.find((author) => author.author === "linhnth")!;
    expect([...remoteAuthorAssignedLevels(tan, 1)].slice(0, 3)).toEqual([5, 10, 15]);
    expect(remoteAuthorAssignedLevels(linh, 1).has(5)).toBe(false);
    expect(remoteAuthorAssignedLevels(linh, 1).has(99)).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { noteImageURL } from "./noteImage.ts";

describe("noteImageURL", () => {
  it("accepts a trimmed HTTP or HTTPS link", () => {
    expect(noteImageURL(" https://cdn.example.com/food.png ")).toBe("https://cdn.example.com/food.png");
    expect(noteImageURL("http://example.com/image?id=2")).toBe("http://example.com/image?id=2");
  });

  it("rejects prose, multiple tokens, and non-web schemes", () => {
    expect(noteImageURL("See https://example.com/food.png")).toBeNull();
    expect(noteImageURL("https://a.test/x.png https://b.test/y.png")).toBeNull();
    expect(noteImageURL("data:image/png;base64,abc")).toBeNull();
    expect(noteImageURL("ftp://example.com/x.png")).toBeNull();
  });
});

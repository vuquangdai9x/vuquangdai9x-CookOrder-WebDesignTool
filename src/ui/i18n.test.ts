import { describe, expect, it } from "vitest";
import { languageToggleLabel, translateText } from "./i18n.ts";

describe("Vietnamese localization", () => {
  it("translates exact UI labels while preserving icons", () => {
    expect(translateText("Design", "vi")).toBe("Thiết kế");
    expect(translateText("✨ Auto Generate", "vi")).toBe("✨ Tạo tự động");
    expect(translateText("✕ Close", "vi")).toBe("✕ Đóng");
  });

  it("translates numbered labels and leaves data untouched", () => {
    expect(translateText("Level 42", "vi")).toBe("Màn chơi 42");
    expect(translateText("Burger", "vi")).toBe("Burger");
  });

  it("shows the language that the toggle will switch to", () => {
    expect(languageToggleLabel("en")).toBe("🇻🇳 VI");
    expect(languageToggleLabel("vi")).toBe("🇬🇧 EN");
  });
});

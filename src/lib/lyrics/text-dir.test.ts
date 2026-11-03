import { describe, expect, it } from "vitest";
import { textDir } from "./text-dir";

describe("textDir", () => {
  it("reads Urdu and Hebrew as rtl, other scripts as ltr", () => {
    expect(textDir("اُن کی تعریف میں کہیں کیا")).toBe("rtl");
    expect(textDir("(ooh) الفاظ ہی نہیں ہیں")).toBe("ltr");
    expect(textDir("“الفاظ” ہی نہیں")).toBe("rtl");
    expect(textDir("שלום")).toBe("rtl");
    expect(textDir("ਬਾਬੇ ਦੀ ਸਾਨੂੰ")).toBe("ltr");
    expect(textDir("तू अगर मेरी")).toBe("ltr");
    expect(textDir("Like it's the last night")).toBe("ltr");
    expect(textDir("♪")).toBe("ltr");
    expect(textDir("\u200F(ooh) الفاظ")).toBe("rtl");
    expect(textDir("\u200E الفاظ")).toBe("ltr");
    expect(textDir("\u{1E900}\u{1E901}")).toBe("rtl");
    expect(textDir("\u{10D00}")).toBe("rtl");
  });
});

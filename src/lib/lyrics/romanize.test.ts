import { describe, expect, it } from "vitest";
import { romanize } from "./romanize";

describe("romanize", () => {
  // The lines from the Nov 6 spike, where ICU's Any-Latin gave "tere nala
  // pi'ara" and "agara": the schwa rule is what this adds.
  it("spells Gurmukhi with the schwa rule", () => {
    expect(romanize("ਬਾਬੇ ਦੀ ਸਾਨੂੰ ਮਿਹਰ ਹੈ")).toBe("baabe di saanu mihar hai");
    expect(romanize("ਤੇਰੇ ਨਾਲ ਪਿਆਰ ਹੋ ਗਿਆ")).toBe("tere naal piaar ho gia");
  });

  it("spells Devanagari with the schwa rule", () => {
    expect(romanize("तू अगर मेरी हो जाए")).toBe("tu agar meri ho jaae");
    expect(romanize("तेरे बिना ज़िंदगी से कोई शिकवा तो नहीं")).toBe(
      "tere bina zindagi se koi shikva to nahin",
    );
  });

  it("spells lines from songs played in the app", () => {
    expect(romanize("बेताब-सा मोहब्बत का तु इन्क़लाब है")).toBe(
      "betaab-sa mohabbat ka tu inqalaab hai",
    );
    expect(romanize("तु अगर मेरी, ये उजाले तेरे")).toBe(
      "tu agar meri, ye ujaale tere",
    );
    expect(romanize("ਚੰਗਿਆ ਨਾ")).toBe("changia na");
  });

  it("spells Tamil, which keeps its vowels", () => {
    expect(romanize("நான் உன்னை காதலிக்கிறேன்")).toBe(
      "naan unnai kaathalikkiren",
    );
    expect(romanize("வாழ்க்கை ஒரு பயணம்")).toBe("vaazhkkai oru payanam");
  });

  it("handles the schwa rule's edges", () => {
    expect(romanize("न")).toBe("na");
    expect(romanize("मित्र")).toBe("mitra");
    expect(romanize("प्यार")).toBe("pyaar");
    expect(romanize("धड़कन")).toBe("dharkan");
    expect(romanize("समझना")).toBe("samajhna");
  });

  it("handles nasals and the Gurmukhi doubling mark", () => {
    expect(romanize("कंबल")).toBe("kambal");
    expect(romanize("ਮੈਂ")).toBe("main");
    expect(romanize("ਛੱਡ")).toBe("chhadd");
    expect(romanize("ਪੱਕਾ")).toBe("pakka");
  });

  it("reads nukta letters whichever way they are encoded", () => {
    expect(romanize("ज़")).toBe("za");
    expect(romanize("ज़")).toBe("za");
    expect(romanize("ਸ਼ਾਮ")).toBe("shaam");
  });

  it("doesn't lose less common letters", () => {
    expect(romanize("ऋतु")).toBe("ritu");
    expect(romanize("कृपा")).toBe("kripa");
    expect(romanize("कॉफी")).toBe("kophi");
    expect(romanize("ஶ்ரீ")).toBe("shree");
    expect(romanize("ੲਹ")).toBe("ih");
  });

  it("applies a nukta to a doubled letter", () => {
    expect(romanize("ਇੱਜ਼ਤ")).toBe("izzat");
  });

  it("ignores joiners inside a word", () => {
    const plain = "र्य";
    expect(romanize(plain)).toBe("rya");
    expect(romanize("र\u200D्य")).toBe("rya");
    expect(romanize("र\u200C्य")).toBe("rya");
  });

  it("passes digits and danda through, and splits words on them", () => {
    const ram = "राम";
    const digits = "१२";
    expect(romanize(`${ram} ${digits}।`)).toBe(`raam ${digits}।`);
    expect(romanize(`${ram}${digits}${ram}`)).toBe(`raam${digits}raam`);
    expect(romanize(digits)).toBeNull();
  });

  it("never drops what it doesn't know", () => {
    expect(romanize("ॐ नमः")).toBe("om namah");
    expect(romanize("राम॰राम")).toBe("raam॰raam");
  });

  it("drops the final vowel after a cluster, unless it ends in r or y (QA M2)", () => {
    expect(romanize("वक़्त")).toBe("vaqt");
    expect(romanize("इश्क़")).toBe("ishq");
    expect(romanize("दर्द")).toBe("dard");
    expect(romanize("दोस्त")).toBe("dost");
    expect(romanize("मस्त")).toBe("mast");
    expect(romanize("शब्द")).toBe("shabd");
    expect(romanize("सख़्त")).toBe("sakht");
    expect(romanize("मित्र")).toBe("mitra");
    expect(romanize("सत्य")).toBe("satya");
    expect(romanize("तुम हो तो वक़्त थमा है")).toBe("tum ho to vaqt thama hai");
  });

  it("keeps a final long vowel long when it is nasal (QA L2)", () => {
    expect(romanize("माँ")).toBe("maa");
    expect(romanize("हाँ")).toBe("haan");
    expect(romanize("में")).toBe("mein");
    expect(romanize("मैं")).toBe("main");
    expect(romanize("नहीं")).toBe("nahin");
  });

  it("keeps other text in a mixed line", () => {
    expect(romanize("Baby तू (ooh), 2 बार")).toBe("Baby tu (ooh), 2 baar");
  });

  it("returns null for lines with nothing to romanize, Urdu included", () => {
    expect(romanize("Like it's the last night")).toBeNull();
    expect(romanize("پتا نہیں چلا، ہم بدل گئے")).toBeNull();
    expect(romanize("")).toBeNull();
  });
});

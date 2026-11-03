// Right-to-left letters: Hebrew through Arabic Extended, the Hebrew and
// Arabic presentation forms, and the RTL blocks in U+10800-10FFF and
// U+1E800-1EFFF (Adlam, Hanifi Rohingya and others), plus RLM and ALM.
const RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}\u200F\u061C]/u;
// What counts as a strong character: any letter, or an explicit LRM/RLM/ALM.
const STRONG = /[\p{L}\u200E\u200F\u061C]/u;

/** Direction of a lyric line from its first strong character, the way
 *  `dir="auto"` resolves it; returned explicitly so `rtl:` styles apply
 *  per line. */
export function textDir(text: string): "rtl" | "ltr" {
  const first = text.match(STRONG)?.[0];
  return first && RTL.test(first) ? "rtl" : "ltr";
}

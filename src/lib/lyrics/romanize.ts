/**
 * Romanized lyrics for Devanagari, Gurmukhi and Tamil, offline, spelled the way
 * people type these lyrics (naal, pyaar, shikva) rather than a scholarly scheme.
 * Each is regular: a consonant carries a vowel until a mark changes it.
 *
 * Urdu is left out on purpose. Its script drops short vowels, so a letter
 * mapping cannot recover "pata nahin chala" from what comes out as "pta nhy chla".
 */

type Script = {
  consonants: Record<string, string>;
  vowels: Record<string, string>;
  matras: Record<string, string>;
  virama: string;
  nukta?: string;
  nasals: string;
  doubler?: string;
  /** Hindi and Punjabi drop the inherent vowel in speech; Tamil keeps it. */
  schwaDeletion: boolean;
};

const NUKTA: Record<string, string> = {
  k: "q",
  g: "gh",
  j: "z",
  d: "r",
  dh: "rh",
  ph: "f",
  s: "sh",
};

// Devanagari (U+09xx) and Gurmukhi (U+0Axx) share a layout, so one table of
// offsets into the block serves both.
const INDIC_CONSONANTS: [number, string][] = [
  [0x15, "k"], [0x16, "kh"], [0x17, "g"], [0x18, "gh"], [0x19, "ng"],
  [0x1a, "ch"], [0x1b, "chh"], [0x1c, "j"], [0x1d, "jh"], [0x1e, "ny"],
  [0x1f, "t"], [0x20, "th"], [0x21, "d"], [0x22, "dh"], [0x23, "n"],
  [0x24, "t"], [0x25, "th"], [0x26, "d"], [0x27, "dh"], [0x28, "n"],
  [0x2a, "p"], [0x2b, "ph"], [0x2c, "b"], [0x2d, "bh"], [0x2e, "m"],
  [0x2f, "y"], [0x30, "r"], [0x32, "l"], [0x35, "v"], [0x36, "sh"],
  [0x37, "sh"], [0x38, "s"], [0x39, "h"],
];
const INDIC_VOWELS: [number, string][] = [
  [0x05, "a"], [0x06, "aa"], [0x07, "i"], [0x08, "ee"], [0x09, "u"],
  [0x0a, "oo"], [0x0f, "e"], [0x10, "ai"], [0x13, "o"], [0x14, "au"],
];
const INDIC_MATRAS: [number, string][] = [
  [0x3e, "aa"], [0x3f, "i"], [0x40, "ee"], [0x41, "u"], [0x42, "oo"],
  [0x47, "e"], [0x48, "ai"], [0x4b, "o"], [0x4c, "au"],
];

function indicTable(pairs: [number, string][], block: number) {
  return Object.fromEntries(
    pairs.map(([offset, latin]) => [String.fromCodePoint(block + offset), latin]),
  );
}

function indicScript(block: number, extra: Partial<Script>): Script {
  return {
    consonants: indicTable(INDIC_CONSONANTS, block),
    vowels: indicTable(INDIC_VOWELS, block),
    matras: indicTable(INDIC_MATRAS, block),
    virama: String.fromCodePoint(block + 0x4d),
    nukta: String.fromCodePoint(block + 0x3c),
    nasals: String.fromCodePoint(block + 0x01, block + 0x02),
    schwaDeletion: true,
    ...extra,
  };
}

const DEVANAGARI = (() => {
  const s = indicScript(0x900, {});
  // Sanskrit's ri, and the o and e that English loanwords are written with.
  Object.assign(s.vowels, { "\u090B": "ri", "\u0911": "o", "\u090D": "e" });
  Object.assign(s.matras, { "\u0943": "ri", "\u0949": "o", "\u0945": "e" });
  return s;
})();
const GURMUKHI = (() => {
  const s = indicScript(0xa00, {
    nasals: "\u0A01\u0A02\u0A70",
    doubler: "\u0A71",
  });
  s.consonants["\u0A5C"] = "r";
  // The bare vowel carriers; a matra on one overrides this as on a consonant.
  Object.assign(s.vowels, { "\u0A72": "i", "\u0A73": "u" });
  return s;
})();
const TAMIL: Script = {
  consonants: {
    க: "k", ங: "ng", ச: "s", ஞ: "nj", ட: "t", ண: "n", த: "th", ந: "n",
    ப: "p", ம: "m", ய: "y", ர: "r", ல: "l", வ: "v", ழ: "zh", ள: "l",
    ற: "r", ன: "n", ஜ: "j", ஷ: "sh", ஶ: "sh", ஸ: "s", ஹ: "h",
  },
  vowels: {
    அ: "a", ஆ: "aa", இ: "i", ஈ: "ee", உ: "u", ஊ: "oo", எ: "e", ஏ: "e",
    ஐ: "ai", ஒ: "o", ஓ: "o", ஔ: "au",
  },
  matras: {
    "\u0BBE": "aa", "\u0BBF": "i", "\u0BC0": "ee", "\u0BC1": "u",
    "\u0BC2": "oo", "\u0BC6": "e", "\u0BC7": "e", "\u0BC8": "ai",
    "\u0BCA": "o", "\u0BCB": "o", "\u0BCC": "au",
  },
  virama: "\u0BCD",
  nasals: "",
  schwaDeletion: false,
};

// A word of one script: letters and marks, with joiners inside it, which only
// shape the letters. Danda and native digits sit outside and pass through.
const SCRIPT_RUN = new RegExp(
  [
    "\u0900-\u0963\u0970-\u097F",
    "\u0A00-\u0A65\u0A70-\u0A7F",
    "\u0B80-\u0BE5",
  ]
    .map((letters) => `[${letters}](?:[${letters}]|\u200C|\u200D)*`)
    .join("|"),
  "gu",
);

function scriptOf(run: string): Script {
  const cp = run.codePointAt(0)!;
  return cp < 0xa00 ? DEVANAGARI : cp < 0xb80 ? GURMUKHI : TAMIL;
}

type Akshara = {
  consonant: string;
  /** Written twice: Gurmukhi's addak on the letter after it. */
  doubled: boolean;
  vowel: string;
  /** The consonant's own vowel, not one a mark or a letter wrote. */
  inherent: boolean;
  nasal: boolean;
};

function parse(word: string, s: Script): Akshara[] {
  const out: Akshara[] = [];
  let doubled = false;
  for (const ch of word) {
    const last = out[out.length - 1];
    if (s.consonants[ch]) {
      out.push({
        consonant: s.consonants[ch],
        doubled,
        vowel: "a",
        inherent: true,
        nasal: false,
      });
      doubled = false;
    } else if (s.vowels[ch]) {
      out.push({
        consonant: "",
        doubled: false,
        vowel: s.vowels[ch],
        inherent: false,
        nasal: false,
      });
    } else if (last && s.matras[ch]) {
      last.vowel = s.matras[ch];
      last.inherent = false;
    } else if (last && ch === s.virama) {
      last.vowel = "";
      last.inherent = false;
    } else if (last && ch === s.nukta) {
      last.consonant = NUKTA[last.consonant] ?? last.consonant;
    } else if (last && s.nasals.includes(ch)) {
      last.nasal = true;
    } else if (ch === s.doubler) {
      doubled = true;
    }
  }
  return out;
}

/** Hindi and Punjabi don't say a word's last inherent vowel (kar, not kara), or
 *  one between two pronounced syllables (shikva, not shikava). A single letter
 *  keeps it (na), and so does a letter right after a cluster (mitra, zindagi). */
function deleteSchwas(a: Akshara[]): void {
  const last = a.length - 1;
  const clusterBeforeLast = last > 0 && a[last - 1].vowel === "";
  if (last > 0 && a[last].inherent && !clusterBeforeLast) a[last].vowel = "";
  for (let i = last - 1; i >= 1; i--) {
    if (!a[i].inherent || a[i].nasal) continue;
    if (a[i - 1].nasal) continue;
    if (a[i - 1].vowel && a[i + 1].consonant && a[i + 1].vowel) a[i].vowel = "";
  }
}

function spell(a: Akshara[], s: Script): string {
  let out = "";
  a.forEach((x, i) => {
    const end = i === a.length - 1;
    // Word-final long vowels are written short in the usual spelling (mera,
    // meri, tu). Tamil keeps them.
    let vowel = x.vowel;
    if (end && s.schwaDeletion) {
      vowel = { aa: "a", ee: "i", oo: "u" }[vowel] ?? vowel;
    }
    out += (x.doubled ? x.consonant[0] : "") + x.consonant + vowel;
    if (!x.nasal) return;
    // A final nasalized u is barely voiced (saanu, tu), and a nasal takes the
    // lips' shape before them (kambal).
    if (end && vowel === "u") return;
    const next = a[i + 1]?.consonant[0];
    out += next === "p" || next === "b" || next === "m" ? "m" : "n";
  });
  return out;
}

/** The line in Latin letters, or null when it holds none of these scripts.
 *  Anything else in the line (Latin words, digits, punctuation) stays as it is. */
export function romanize(text: string): string | null {
  const line = text.normalize("NFC");
  let found = false;
  const out = line.replace(SCRIPT_RUN, (word) => {
    found = true;
    const s = scriptOf(word);
    const akshara = parse(word, s);
    if (s.schwaDeletion) deleteSchwas(akshara);
    return spell(akshara, s);
  });
  return found ? out : null;
}

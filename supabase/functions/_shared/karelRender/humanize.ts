/**
 * karelRender/humanize.ts — HUMANIZATION LAYER (edge mirror)
 * Mirror of src/lib/karelRender/humanize.ts. Keep 1:1.
 */

const PROSE_PROHIBITED_PREFIXES: RegExp[] = [
  /^úkol\s*[:\-–]\s*/i,
  /^otázka\s*[:\-–]\s*/i,
  /^otazka\s*[:\-–]\s*/i,
  /^sezení\s*[:\-–]\s*/i,
  /^sezeni\s*[:\-–]\s*/i,
  /^dotaz\s*[:\-–]\s*/i,
  /^téma\s*[:\-–]\s*/i,
  /^tema\s*[:\-–]\s*/i,
  /^poznámka\s*[:\-–]\s*/i,
  /^poznamka\s*[:\-–]\s*/i,
  /^todo\s*[:\-–]\s*/i,
];

const PROSE_INLINE_TAGS: RegExp[] = [
  /\[recovery\]\s*/gi,
  /\[auto\]\s*/gi,
  /\[system\]\s*/gi,
  /\[debug\]\s*/gi,
  /\[bot\]\s*/gi,
];

const PROSE_CRISIS_HEADLINE =
  /^[🔴⚠️\s]*(?:krizová\s+intervence|krizova\s+intervence)\s*[–\-—]\s*([^–\-—]+?)\s*[–\-—].*$/i;

export function humanizeText(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = String(raw).trim();
  if (!s) return "";

  const m = s.match(PROSE_CRISIS_HEADLINE);
  if (m) s = `krizová situace u ${m[1].trim()}`;

  for (const re of PROSE_PROHIBITED_PREFIXES) s = s.replace(re, "");
  for (const re of PROSE_INLINE_TAGS) s = s.replace(re, "");

  s = s.replace(/\s+/g, " ").replace(/\s*:\s*$/g, "").trim();
  s = s.replace(/[.!?]+$/g, "").trim();
  return s;
}

export function czechTaskWord(n: number): string {
  if (n === 1) return "úkol";
  if (n >= 2 && n <= 4) return "úkoly";
  return "úkolů";
}

export function describeUrgentLoad(n: number, topTaskHumanized: string): string {
  if (n <= 0) return "";
  if (n === 1) {
    return topTaskHumanized
      ? `Dnes mě nejvíc zajímá toto: ${topTaskHumanized}.`
      : "Dnes je jeden úkol, který nesnese odklad.";
  }
  if (topTaskHumanized) {
    const rest = n - 1;
    const restWord = czechTaskWord(rest);
    const adjEnding = rest === 1 ? "í" : rest <= 4 ? "í" : "ích";
    return `Dnes je nejdůležitější toto: ${topTaskHumanized}. K tomu ještě ${rest} dalš${adjEnding} ${restWord} čeká na pozornost.`;
  }
  return `Dnes je ${n} ${czechTaskWord(n)} k vyřízení — detail níže.`;
}

export function addressTaskTo2ndPerson(
  text: string,
  target: "hanka" | "kata",
): string {
  if (!text) return "";
  let s = text.trim();

  const ownNamePatterns: RegExp[] = target === "hanka"
    ? [
        /\b(Hanič[kc]?[aueoy]?[mu]?)\b/gi,
        /\b(Han[kc][aueoy]?[mu]?)\b/gi,
        /\b(Han[aueoy]?[mu]?)\b/gi,
        /\b(mamk[aueoyi]|mám[aueoy]|maminc?[aueoyi])\b/gi,
      ]
    : [
        /\b(Káť?[aueoyi]?[mu]?)\b/gi,
        /\b(Kat[kc][aueoy]?[mu]?)\b/gi,
        /\b(Kat[aueoy]?[mu]?)\b/gi,
      ];

  const preps = "(?:s|se|pro|od|u|k|ke|na|do|o|v|ve|za|po|před|nad|pod)";
  for (const namePat of ownNamePatterns) {
    const phrasePat = new RegExp(`\\b${preps}\\s+${namePat.source}`, namePat.flags);
    s = s.replace(phrasePat, "");
    s = s.replace(namePat, "");
  }

  s = s.replace(/\s+/g, " ").replace(/\s+,/g, ",").replace(/,\s*,/g, ",");
  s = s.replace(/^[\s,;:.]+/, "").replace(/[\s,;:]+$/, "").trim();

  if (!s) return "";
  s = s.charAt(0).toLocaleLowerCase("cs") + s.slice(1);
  return s;
}

export const KAREL_FORBIDDEN_PATTERNS: RegExp[] = [
  /eviduji\s+\d/i,
  /priorita\s+(?:č(?:íslo)?\.?\s*)?\s*1\s*je/i,
  /čekám na tebe v\s+\d+\s+bodech/i,
  /systém hlásí/i,
  /pracoval(?:a)?\s+s\s+Karel\b/i,
  /\bÚkol:\s/,
  /\bOtázka:\s/,
  /\bSezení:\s/,
  /\(téma\s+["„].+?["„]?,\s*před\s+\d+/i,
  /\bmiláčku\b/i,
  /\blásko\b/i,
  /\bdrahá\b/i,
];

export function auditHumanizedText(text: string): string[] {
  const violations: string[] = [];
  for (const pattern of KAREL_FORBIDDEN_PATTERNS) {
    const m = text.match(pattern);
    if (m) violations.push(`forbidden: "${m[0]}" (${pattern})`);
  }
  return violations;
}

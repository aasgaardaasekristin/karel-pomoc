/**
 * karelVoiceGuide.ts (UI mirror)
 * Zrcadlo edge varianty: supabase/functions/_shared/karelVoiceGuide.ts
 *
 * Použij v UI surfaces, kde frontend skládá narativní výstup
 * pro Karla (např. KarelDailyPlan prose summary, voice-guard checks).
 *
 * Držet 1:1 s edge variantou.
 */

export type KarelVoiceMode =
  | "team_lead"
  | "direct_kata"
  | "direct_hanicka"
  | "weekly_review"
  | "monthly_review"
  | "supervision";

/** Slova / fráze, které Karel NIKDY nesmí pustit do user-facing výstupu. */
export const KAREL_VOICE_FORBIDDEN_PATTERNS: RegExp[] = [
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

/**
 * Auditní funkce: vrátí pole nalezených porušení voice guide.
 * Použij v dev/test režimu nebo jako post-render guard.
 */
export function auditVoiceGuide(text: string): string[] {
  const violations: string[] = [];
  for (const pattern of KAREL_VOICE_FORBIDDEN_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      violations.push(`Voice guide violation: "${match[0]}" (pattern ${pattern})`);
    }
  }
  return violations;
}

/** Lidský greeting podle denní doby (Praha). */
export function voiceGreeting(audience: "team" | "hanicka" | "kata"): string {
  const h = new Date().getHours();
  let timeOfDay: string;
  if (h < 10) timeOfDay = "Dobré ráno";
  else if (h < 14) timeOfDay = "Dobrý den";
  else if (h < 18) timeOfDay = "Dobré odpoledne";
  else timeOfDay = "Dobrý večer";

  switch (audience) {
    case "team":
      return `${timeOfDay}, Haničko a Káťo.`;
    case "hanicka":
      return `${timeOfDay}, Hani.`;
    case "kata":
      return `${timeOfDay}, Káťo.`;
  }
}

/**
 * Stručný popisek tone módu — pro debug/admin UI.
 */
export function describeVoiceMode(mode: KarelVoiceMode): string {
  switch (mode) {
    case "team_lead": return "Týmový hlas (Hanička + Káťa) — nejvyšší noblesa";
    case "direct_kata": return "Přímý hlas ke Kátě — věcnější, respektující";
    case "direct_hanicka": return "Přímý hlas k Haničce — teplejší, důstojný";
    case "weekly_review": return "Týdenní reflexe";
    case "monthly_review": return "Měsíční reflexe";
    case "supervision": return "Klinická supervize";
  }
}

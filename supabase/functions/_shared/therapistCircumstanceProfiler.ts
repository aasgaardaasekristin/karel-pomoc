/**
 * therapistCircumstanceProfiler.ts — Phase 3
 *
 * Extracts operational circumstances of therapists from recent activity
 * (24–48h) that may affect planning and task assignment.
 *
 * RULES:
 * - Captures: fatigue, child illness, family stress, reduced availability
 * - NEVER verbalizes private circumstances publicly
 * - Operational impact is always abstracted:
 *   "Snížit zátěž Káti na 3 dny" NOT "Tonička má zlomenou ruku"
 * - Source references are thread IDs only, never raw content
 *
 * Single responsibility: circumstance detection + abstraction.
 */

import type { TherapistCircumstance, InformationSensitivity } from "./phase3Types.ts";

// ── Signal Patterns ──

interface CircumstancePattern {
  patterns: RegExp[];
  type: TherapistCircumstance["circumstanceType"];
  // Full sensitivity union preserved — includes "secret_karel_only"
  defaultSensitivity: InformationSensitivity;
}

const CIRCUMSTANCE_PATTERNS: CircumstancePattern[] = [
  {
    // Child illness (Amálka, Tonička)
    patterns: [
      /\b(am[aá]lka|toni[cč]ka|holky|hol[cč]i[cč]ky)\b.*\b(nemocn|hore[cč]k|zl[aá]m|bol[ií]|l[eé][kk]a[rř]|nemoc|nachlazen)/i,
      /\b(nemocn|hore[cč]k|zl[aá]m|bol[ií]|l[eé][kk]a[rř]|nemoc|nachlazen)\b.*\b(am[aá]lka|toni[cč]ka|holky|hol[cč]i[cč]ky)/i,
    ],
    type: "child_illness",
    defaultSensitivity: "therapist_private",
  },
  {
    // Personal fatigue
    patterns: [
      /\b(unaven[aá]|vy[cč]erpan[aá]|nem[uů][zž]u\s+sp[aá]t|nespala\s+jsem|jsem\s+na\s+dn[eě])/i,
      /\b(padám\s+na\s+hubu|padám\s+únavou|nemám\s+sílu)/i,
    ],
    type: "personal_fatigue",
    defaultSensitivity: "team_operational",
  },
  {
    // Family stress
    patterns: [
      /\b(h[aá]dka|konflikt|ji[rř][ií]\s+.*zase|man[zž]el.*probl[eé]m)/i,
      /\b(nervy\s+doma|doma\s+to\s+v[rř]e|rodinn[aá]\s+krize)/i,
    ],
    type: "family_stress",
    defaultSensitivity: "therapist_private",
  },
  {
    // Reduced availability
    patterns: [
      /\b(nebudu\s+dostupn|budu\s+pry[cč]|mus[ií]m\s+pry[cč]|nejsem\s+doma|odj[ií][zž]d[ií]m)/i,
      /\b(o\s+v[ií]kend\s+ne|nem[uů][zž]u\s+z[ií]tra|nestihnu)/i,
    ],
    type: "reduced_availability",
    defaultSensitivity: "team_operational",
  },
  {
    // Work overload
    patterns: [
      /\b(p[rř]et[ií][zž]en|moc\s+pr[aá]ce|nestíhám|centrum\s+.*pl[nň])/i,
      /\b(v\s+centru\s+je\s+toho|sez[eě]n[ií]\s+jedno\s+za\s+druh[yý]m)/i,
    ],
    type: "work_overload",
    defaultSensitivity: "team_operational",
  },
  {
    // Emotional burden (guilt, shame, sadness)
    patterns: [
      /\b(c[ií]t[ií]m\s+vinu|m[aá]m\s+v[yý][cč]itky|styd[ií]m\s+se|je\s+mi\s+smutno)/i,
      /\b(sel?hal[aá]\s+jsem|ned[eě]l[aá]m\s+dost|jsem\s+[sš]patn[aá])/i,
    ],
    type: "emotional_burden",
    defaultSensitivity: "secret_karel_only",
  },
  {
    // Positive energy
    patterns: [
      /\b(m[aá]m\s+energii|dnes\s+se\s+c[ií]t[ií]m\s+dob[rř]e|je\s+mi\s+l[eé]pe)/i,
      /\b(povzbudil|poda[rř]ilo\s+se|[uú]sp[eě]ch|radost)/i,
    ],
    type: "positive_energy",
    defaultSensitivity: "team_operational",
  },
];

// ── Core Profiler ──

export interface TherapistActivitySnippet {
  therapist: "hanka" | "kata";
  threadId: string;
  timestamp: string;
  /** Summary text (NOT raw chat). Should be already pre-summarized. */
  summaryText: string;
}

/**
 * Scan recent therapist activity for circumstances affecting collaboration.
 * Input must be pre-summarized snippets, NOT raw chat transcripts.
 */
export function detectCircumstances(
  snippets: TherapistActivitySnippet[],
): TherapistCircumstance[] {
  const results: TherapistCircumstance[] = [];
  const seen = new Set<string>(); // dedup key: therapist+type

  for (const snippet of snippets) {
    for (const pattern of CIRCUMSTANCE_PATTERNS) {
      if (pattern.patterns.some(p => p.test(snippet.summaryText))) {
        const key = `${snippet.therapist}:${pattern.type}`;
        if (seen.has(key)) continue;
        seen.add(key);

        results.push({
          therapist: snippet.therapist,
          detectedAt: snippet.timestamp,
          circumstanceType: pattern.type,
          summary: abstractCircumstance(pattern.type, snippet.therapist),
          operationalImpact: deriveOperationalImpact(pattern.type, snippet.therapist),
          // Preserve full sensitivity — do NOT cast away "secret_karel_only"
          sensitivity: pattern.defaultSensitivity,
          sources: [snippet.threadId],
        });
      }
    }
  }

  return results;
}

// ── Abstraction (never leak raw private details) ──

function abstractCircumstance(
  type: TherapistCircumstance["circumstanceType"],
  therapist: "hanka" | "kata",
): string {
  const name = therapist === "hanka" ? "Hanka" : "Káťa";
  switch (type) {
    case "child_illness":
      return `${name} má dočasně omezenou kapacitu z rodinných důvodů`;
    case "personal_fatigue":
      return `${name} signalizuje únavu`;
    case "family_stress":
      return `${name} má zvýšenou osobní zátěž`;
    case "reduced_availability":
      return `${name} bude dočasně méně dostupná`;
    case "work_overload":
      return `${name} má vysoké pracovní vytížení`;
    case "emotional_burden":
      return `${name} prochází náročným obdobím`;
    case "positive_energy":
      return `${name} má dobrou energii a kapacitu`;
    default:
      return `${name} — detekován kontextový signál`;
  }
}

function deriveOperationalImpact(
  type: TherapistCircumstance["circumstanceType"],
  therapist: "hanka" | "kata",
): string {
  const name = therapist === "hanka" ? "Hanka" : "Káťa";
  switch (type) {
    case "child_illness":
      return `Snížit počet úkolů pro ${name} na nejnutnější. Zvážit přeřazení na druhou terapeutku.`;
    case "personal_fatigue":
      return `Omezit nároky, prioritizovat jen akutní úkoly.`;
    case "family_stress":
      return `Nepřidávat nové úkoly, nechat prostor pro stabilizaci.`;
    case "reduced_availability":
      return `Plánovat úkoly mimo období nedostupnosti. Předat urgentní věci druhé terapeutce.`;
    case "work_overload":
      return `Odložit méně naléhavé úkoly. Zvážit redistribuci.`;
    case "emotional_burden":
      return `Karel přizpůsobí tón a přístup. Žádné veřejné verbalizování.`;
    case "positive_energy":
      return `Lze přidat náročnější úkoly nebo nové iniciativy.`;
    default:
      return `Sledovat vývoj situace.`;
  }
}

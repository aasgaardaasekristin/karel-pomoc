import type { TeamDeliberation } from "@/types/teamDeliberation";

function sessionParamsOf(deliberation: Pick<TeamDeliberation, "session_params"> | null | undefined) {
  return deliberation?.session_params && typeof deliberation.session_params === "object"
    ? (deliberation.session_params as Record<string, unknown>)
    : {};
}

export function isPlayroomDeliberation(
  deliberation: (Pick<TeamDeliberation, "session_params"> & { deliberation_type?: unknown }) | null | undefined,
): boolean {
  const p = sessionParamsOf(deliberation);
  return (
    String(deliberation?.deliberation_type) === "playroom" ||
    p.session_actor === "karel_direct" ||
    p.ui_surface === "did_kids_playroom" ||
    p.session_format === "playroom" ||
    Boolean(p.playroom_plan)
  );
}

export function hasActiveExternalCurrentEventReplan(
  deliberation: Pick<TeamDeliberation, "session_params"> | null | undefined,
): boolean {
  const p = sessionParamsOf(deliberation);
  const replan = p.external_current_event_replan;
  return !!replan && typeof replan === "object" && (replan as Record<string, unknown>).active === true;
}

export function getPlanChangeLabel(
  deliberation: Pick<TeamDeliberation, "status" | "hanka_signed_at" | "kata_signed_at" | "session_params">,
): string {
  const p = sessionParamsOf(deliberation);
  const replan = p.external_current_event_replan;
  const status = String(deliberation.status ?? "").toLowerCase();

  if (replan && typeof replan === "object" && (replan as Record<string, unknown>).active === true) {
    const rawLabel = (replan as Record<string, unknown>).event_label ?? "externí událost";
    const label = String(rawLabel).trim();
    return label
      ? `vráceno k úpravě po urgentní externí události (${label})`
      : "vráceno k úpravě po urgentní externí události";
  }

  if (status === "in_revision") return "vráceno k úpravě";

  if (deliberation.hanka_signed_at == null || deliberation.kata_signed_at == null) {
    return "čeká na nové schválení terapeutkami";
  }

  return "beze změny";
}

export function getLiveProgramTitle(
  deliberation: Pick<TeamDeliberation, "deliberation_type" | "session_params">,
): string {
  return isPlayroomDeliberation(deliberation) ? "Živý program Herny" : "Živý program Sezení";
}

/**
 * Visible-text guard pro Herna modal a další klinická UI místa.
 * Tyto výrazy NESMÍ být viditelné terapeutkám ani dětem — jsou interní
 * technický slovník (DB sloupce, programatické klíče, anglicko-technické hybridy).
 */
export const HERNA_VISIBLE_FORBIDDEN_TERMS = [
  "first_draft",
  "Karel-led",
  "karel-led",
  "Karel_led",
  "program_draft",
  "session_params",
  "backend",
  "pipeline",
  "source_ref",
  "source_kind",
  "Pantry",
  "DID-relevantní",
  "event_ingestion",
  "karel_pantry_b_entries",
  "Živý program sezení",
  "Změna plánu: beze změny",
  "Vyžaduje terapeutku: Ne",
  // Kostrbaté / neklinické české fráze (jazyková akceptace, ne jen regex):
  "Herna je vedená Karlem práce",
  "vedená Karlem práce s částí",
  "vedená Karlem práce",
  "nepoužije se plán terapeutického sezení ani pracovní návrh",
  "nepoužije se plán terapeutického sezení",
  "nepřebírá pracovní návrh",
  "ani pracovní návrh",
  "pracovní návrh",
] as const;

const HERNA_GOOD_SENTENCE_A =
  "Herna má svůj vlastní bezpečný herní program. Karel ji může vést až po schválení Haničkou a Káťou.";

/**
 * Sanitize visible plan/brief text — replace any leaked technical tokens
 * AND kostrbaté české fráze za přirozenou klinickou češtinu.
 */
export function sanitizeHernaVisibleText(input: string | null | undefined): string {
  if (!input) return "";
  let out = String(input);

  // 1) Celé špatné věty → jedna dobrá náhradní věta.
  // Varianty se "Karel-led" i "vedená Karlem".
  const badSentencePatterns: RegExp[] = [
    /Herna je (?:Karel[-_ ]led|vedená Karlem) práce s částí[^.]*?(?:first[_ ]draft|pracovní návrh)\s*\./gi,
    /Herna je (?:Karel[-_ ]led|vedená Karlem) práce s částí[^.]*\./gi,
    /Herna je (?:Karel[-_ ]led|vedená Karlem) práce[^.]*\./gi,
    /Herna je práce vedená Karlem po schválení terapeutkami;[^.]*nepřebírá plán terapeutického Sezení\s*\./gi,
  ];
  for (const rx of badSentencePatterns) {
    out = out.replace(rx, HERNA_GOOD_SENTENCE_A);
  }

  // 2) Tvrdé technické tokeny → klinický jazyk (defense-in-depth).
  out = out.replace(/\bKarel[-_ ]led\b/gi, "vedená Karlem");
  out = out.replace(/\bfirst[_ ]draft\b/gi, "pracovní podklad");
  out = out.replace(/\bprogram[_ ]draft\b/gi, "pracovní program");
  out = out.replace(/\bsession[_ ]params\b/gi, "parametry sezení");

  // 3) Reziduální "pracovní návrh" v Herna kontextu → odstranit jako mrtvou frázi.
  out = out.replace(/\s*ani pracovní návrh\b/gi, "");
  out = out.replace(/\bpracovní návrh\b/gi, "pracovní podklad");

  return out;
}

/**
 * Returns count of forbidden visible terms in given text.
 * Used by tests and DOM scans.
 */
export function countHernaForbiddenTerms(text: string): number {
  if (!text) return 0;
  let n = 0;
  for (const term of HERNA_VISIBLE_FORBIDDEN_TERMS) {
    if (text.includes(term)) n += 1;
  }
  return n;
}


/**
 * Shared recency sanitizer for ALL visible therapeutic workspace artifacts
 * outside the core daily briefing (DeliberationRoom, Návrh Herny / Sezení,
 * plan cards, program_draft, karel_proposed_plan, plan_markdown).
 *
 * Purpose: even when stored DB text or LLM output literally says
 * "navázat na včerejší Hernu" / "Symboly z včerejška" /
 * "POUŽITÝ VČEREJŠÍ KONTEXT", we MUST NOT render that to the user
 * verbatim, because the source playroom/session may have happened
 * 2+ days ago. The sanitizer rewrites these patterns to safe,
 * absolute-date-first phrasing whenever a date or label is available,
 * and to a date-agnostic safe form ("starší") otherwise.
 *
 * The sanitizer never invents dates; if no date is available, it falls
 * back to date-free generic wording.
 */

const formatPragueDateLabel = (iso?: string | null): string | null => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("cs-CZ", {
    timeZone: "Europe/Prague",
    day: "numeric",
    month: "numeric",
    year: "numeric",
  }).format(d);
};

export interface RecencyHint {
  /** ISO datum poslední doložené Herny */
  last_playroom_date_iso?: string | null;
  /** Lidsky čitelný popis stáří poslední Herny ("před 3 dny") */
  last_playroom_recency_label?: string | null;
  /** ISO datum posledního Sezení */
  last_session_date_iso?: string | null;
  last_session_recency_label?: string | null;
  /** Dnes je včera = 1, předevčírem = 2, atd. Pokud ===1, výrazy "včerejší" jsou pravdivé. */
  playroom_days_since_today?: number | null;
  session_days_since_today?: number | null;
}

const FORBIDDEN_HEADING_RE = /POU[ŽZ]IT[ÝY]\s+V[ČC]EREJ[ŠS][ÍI]\s+KONTEXT/giu;
const FORBIDDEN_HEADING_LOWER_RE = /pou[žz]it[ýy]\s+v[čc]erej[šs][íi]\s+kontext/giu;
const FORBIDDEN_DULEZITY_HEADING_RE = /V[ČC]EREJ[ŠS][ÍI]\s+D[ŮU]LE[ŽZ]IT[ÝY]\s+KONTEXT/giu;

/**
 * Apply recency-aware sanitization to any visible therapeutic text.
 * Safe to call on stored DB strings as well as LLM-generated strings.
 */
export function sanitizeRecencyText(input: string, hint: RecencyHint = {}): string {
  if (!input) return input;
  let text = input;

  // 1) Section headings — never personalize to "yesterday"
  text = text
    .replace(FORBIDDEN_HEADING_RE, "POUŽITÝ KONTEXT Z POSLEDNÍCH DNÍ")
    .replace(FORBIDDEN_HEADING_LOWER_RE, "Použitý kontext z posledních dní")
    .replace(FORBIDDEN_DULEZITY_HEADING_RE, "DŮLEŽITÝ KONTEXT Z POSLEDNÍCH DNÍ");

  const playDate = formatPragueDateLabel(hint.last_playroom_date_iso ?? null);
  const playLabel = hint.last_playroom_recency_label ?? null;
  const playDays = hint.playroom_days_since_today ?? null;
  const playFresh = playDays === 1; // skutečně včerejší

  const sessDate = formatPragueDateLabel(hint.last_session_date_iso ?? null);
  const sessLabel = hint.last_session_recency_label ?? null;
  const sessDays = hint.session_days_since_today ?? null;
  const sessFresh = sessDays === 1;

  // Helper builders
  const playFullLabel = playDate
    ? `poslední doložené Herny z ${playDate}${playLabel ? `, ${playLabel}` : ""}`
    : "poslední doložené Herny";
  const playShortLabel = playDate
    ? `poslední doložená Herna z ${playDate}${playLabel ? ` (${playLabel})` : ""}`
    : "poslední doložená Herna";
  const playMaterialLabel = playDate ? `materiál z Herny ${playDate}` : "starší herní materiál";
  const playSymbolsLabel = playDate
    ? `Symboly z poslední doložené Herny (${playDate})`
    : "Symboly z poslední doložené Herny";

  const sessShortLabel = sessDate
    ? `poslední Sezení z ${sessDate}${sessLabel ? ` (${sessLabel})` : ""}`
    : "poslední doložené Sezení";

  // 2) Playroom rewrites — only when source is NOT actually yesterday
  if (!playFresh) {
    text = text
      // "navázat na včerejší Hernu"
      .replace(
        /nav[áa]zat\s+(?:jen\s+opatrn[ěe]\s+)?na\s+v[čc]erej[šs][íi]\s+Hernu/giu,
        `navázat jen opatrně na ${playFullLabel}`,
      )
      // "ze včerejší Herny"
      .replace(/ze\s+v[čc]erej[šs][íi]\s+Herny/giu, `z ${playShortLabel}`)
      // "Symboly z včerejška"
      .replace(/Symboly\s+z\s+v[čc]erej[šs]ka/giu, playSymbolsLabel)
      .replace(/symboly\s+z\s+v[čc]erej[šs]ka/giu, playSymbolsLabel.toLowerCase())
      // generic "z včerejška"
      .replace(/\bze?\s+v[čc]erej[šs]ka\b/giu, playDate ? `z ${playDate}` : "z dřívější Herny")
      // "včerejší herní materiál"
      .replace(/v[čc]erej[šs][íi]\s+hern[íi]\s+materi[áa]l/giu, playMaterialLabel)
      // "Včerejší Herna" (capitalized noun)
      .replace(/V[čc]erej[šs][íi]\s+Herna/gu, playShortLabel.charAt(0).toUpperCase() + playShortLabel.slice(1))
      .replace(/v[čc]erej[šs][íi]\s+Herna/giu, playShortLabel)
      .replace(/v[čc]erej[šs][íi]\s+Hernu/giu, playShortLabel)
      .replace(/v[čc]erej[šs][íi]\s+herna/giu, playShortLabel)
      .replace(/v[čc]erej[šs][íi]\s+hernu/giu, playShortLabel);
  }

  // 3) Session rewrites — only when source is NOT actually yesterday
  if (!sessFresh) {
    text = text
      .replace(/V[čc]erej[šs][íi]\s+Sezen[íi]\s+prob[eě]hlo[^.!?\n]*[.!?]?/giu, `${sessShortLabel.charAt(0).toUpperCase() + sessShortLabel.slice(1)}.`)
      .replace(/v[čc]erej[šs][íi]ho?\s+sezen[íi]/giu, sessShortLabel)
      .replace(/v[čc]erej[šs][íi]\s+Sezen[íi]/giu, sessShortLabel)
      .replace(/po\s+na[šs]em\s+v[čc]erej[šs][íi]m\s+sezen[íi]/giu, `po našem ${sessShortLabel}`);
  }

  // 4) Generic context phrasing — these are ALWAYS unsafe because
  //    "včerejší kontext" implies a single day boundary; the panel
  //    may aggregate multiple days. Always rewrite.
  text = text
    .replace(/v[čc]erej[šs][íi]\s+kontext/giu, "kontext z posledních dní")
    .replace(/V[čc]erej[šs][íi]\s+kontext/gu, "Kontext z posledních dní");

  return text;
}

/** True if string still contains a forbidden frozen recency pattern. */
export function hasForbiddenRecencyPattern(input: string): boolean {
  if (!input) return false;
  const FORBIDDEN: RegExp[] = [
    FORBIDDEN_HEADING_RE,
    FORBIDDEN_DULEZITY_HEADING_RE,
    /nav[áa]zat\s+na\s+v[čc]erej[šs][íi]\s+Hernu/iu,
    /Symboly\s+z\s+v[čc]erej[šs]ka/iu,
    /v[čc]erej[šs][íi]\s+hern[íi]\s+materi[áa]l/iu,
    /V[čc]erej[šs][íi]\s+Herna/u,
    /ze\s+v[čc]erej[šs][íi]\s+Herny/iu,
    /v[čc]erej[šs][íi]\s+kontext/iu,
  ];
  return FORBIDDEN.some((re) => re.test(input));
}

/**
 * dailyPlanSelection.ts — Část 1 (Scénář D fix)
 *
 * Deterministická selekce kanonického dnešního plánu mezi více řádky
 * pro stejnou (plan_date, selected_part). Řeší produktovou chybu, kdy
 * novější "prázdný" manual řádek přebil grounded plán jen proto, že
 * UI bralo MAX(created_at).
 *
 * Princip: vyber podle KVALITY OBSAHU, ne podle pořadí zápisu.
 *  1) plán s validní `playroom_plan.therapeutic_program` má vždy
 *     vyšší prioritu než plán bez něj (i kdyby byl novější)
 *  2) v rámci stejné kvality vyhrává vyšší meta.source_status
 *     (grounded > weakly_grounded > fallback > legacy/unknown)
 *  3) tie-break: novější created_at
 *
 * Žádné writes, žádný side effect — pure resolver.
 */

export type PlanSourceStatus =
  | "grounded"
  | "weakly_grounded"
  | "fallback"
  | "legacy_unknown"
  | "markdown_only"
  | "empty";

/**
 * Minimální tvar řádku z `did_daily_session_plans`, který resolver
 * potřebuje. Schválně netáhneme celý SessionPlan, aby šel test mockovat.
 */
export interface PlanLikeRow {
  id: string;
  created_at?: string | null;
  plan_markdown?: string | null;
  urgency_breakdown?: Record<string, any> | null;
}

const hasTherapeuticProgram = (p: PlanLikeRow): boolean => {
  const pp = p.urgency_breakdown?.playroom_plan;
  return (
    !!pp &&
    typeof pp === "object" &&
    Array.isArray(pp.therapeutic_program) &&
    pp.therapeutic_program.length > 0
  );
};

const hasPlayroomShell = (p: PlanLikeRow): boolean => {
  const pp = p.urgency_breakdown?.playroom_plan;
  return !!pp && typeof pp === "object";
};

const hasMarkdown = (p: PlanLikeRow): boolean =>
  typeof p.plan_markdown === "string" && p.plan_markdown.trim().length > 0;

/**
 * Klasifikace source_status pro UI badge. Legacy řádek BEZ meta se
 * NESMÍ tvářit jako grounded — vrací `legacy_unknown`.
 */
export function getPlanSourceStatus(p: PlanLikeRow): PlanSourceStatus {
  const pp = p.urgency_breakdown?.playroom_plan;
  const metaStatus = pp?.meta?.source_status;
  if (metaStatus === "grounded") return "grounded";
  if (metaStatus === "weakly_grounded") return "weakly_grounded";
  if (metaStatus === "fallback") return "fallback";
  if (hasTherapeuticProgram(p) || hasPlayroomShell(p)) return "legacy_unknown";
  if (hasMarkdown(p)) return "markdown_only";
  return "empty";
}

export function getGroundingTokenCount(p: PlanLikeRow): number {
  const tokens = p.urgency_breakdown?.playroom_plan?.meta?.grounding_tokens_available;
  return Array.isArray(tokens) ? tokens.length : 0;
}

/**
 * Skóre kvality. Vyšší = lepší. Tie-break přes created_at řeší
 * `selectCanonicalPlan` zvlášť, aby skóre zůstalo deterministické
 * a nezáviselo na čase.
 */
export function getPlanQualityScore(p: PlanLikeRow): number {
  let score = 0;
  if (hasTherapeuticProgram(p)) score += 1000;
  switch (getPlanSourceStatus(p)) {
    case "grounded":
      score += 500;
      break;
    case "weakly_grounded":
      score += 250;
      break;
    case "fallback":
      score += 100;
      break;
    case "legacy_unknown":
      score += 50;
      break;
    case "markdown_only":
      score += 10;
      break;
    case "empty":
      break;
  }
  return score;
}

/**
 * Vybere kanonický plán. Vstup = všechny dnešní řádky pro danou
 * (plan_date, selected_part) — filtrování dle stavu/karantény dělá
 * volající. Vrací null, pokud je vstup prázdný.
 */
export function selectCanonicalPlan<T extends PlanLikeRow>(
  plans: ReadonlyArray<T>,
): T | null {
  if (!plans || plans.length === 0) return null;
  let best: T | null = null;
  let bestScore = -1;
  let bestTime = -1;
  for (const p of plans) {
    const score = getPlanQualityScore(p);
    const t = p.created_at ? Date.parse(p.created_at) : 0;
    if (
      score > bestScore ||
      (score === bestScore && t > bestTime)
    ) {
      best = p;
      bestScore = score;
      bestTime = t;
    }
  }
  return best;
}

/**
 * Lidsky čitelný label pro UI badge.
 */
export function getPlanSourceStatusLabel(s: PlanSourceStatus): string {
  switch (s) {
    case "grounded":
      return "Živý program (grounded)";
    case "weakly_grounded":
      return "Slabě ukotvený program";
    case "fallback":
      return "Fallback (bez kotvení)";
    case "legacy_unknown":
      return "Legacy / neznámý zdroj";
    case "markdown_only":
      return "Bez živé Herny";
    case "empty":
      return "Prázdný řádek";
  }
}

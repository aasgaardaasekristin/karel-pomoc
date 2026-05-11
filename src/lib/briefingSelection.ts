/**
 * P33.3 — frontend selector for "best valid full" Karel briefing row.
 *
 * Backend may write multiple briefing rows for the same date (auto, manual,
 * sla_watchdog, fallback). The UI must NEVER blindly take the latest row;
 * a fresh fallback/degraded row must not override an older fully-rendered
 * truth-gated briefing.
 *
 * Public:
 *   - isFullRenderableBriefing(row)
 *   - selectBestBriefing(rows)
 *
 * Pure functions, no I/O. Mirror logic kept simple so it can be tested
 * deterministically against fixtures.
 */

const FULL_ALLOWED_PROVIDER_STATUSES = new Set<string>([
  "configured",
  "provider_not_configured",
  "provider_error",
  "not_run",
]);

const DEGRADED_METHOD_HINTS = [
  "fallback",
  "truth_gate_blocked",
  "degraded",
  "backup",
  "náhrad",
  "nahrad",
];

const DIRTY_VISIBLE_BRIEFING_RE = /\b00[0-9]_[A-Za-zÁ-Žá-ž]|Opora\s+v\s+podklade?ch\s+je\s+n[ií]zk[áa]|S[ií]la\s+d[ůu]kazu\s+je\s+n[ií]zk[áa]|dolo[žz]en[ýy]\s+praktickou|\.\.|\bAI polish\b|Technick[ée]\s+podklady|\baudit\b|\bpayload\b|provider_status|query_plan_version|source_cycle_id|nem[áa]m\s+u\s+sebe\s+podrobn[ěe]j[šs][íi]\s+p[řr]ehled/i;

export interface BriefingSelectionRow {
  id?: string;
  briefing_date?: string | null;
  generated_at?: string | null;
  is_stale?: boolean | null;
  generation_method?: string | null;
  payload?: Record<string, any> | null;
}

export function isFullRenderableBriefing(row: BriefingSelectionRow | null | undefined): boolean {
  if (!row) return false;
  const p: any = row.payload ?? {};
  const hb = p.karel_human_briefing;
  const audit = hb?.render_audit ?? {};
  const ext = p.external_reality_watch;
  const humanText = Array.isArray(hb?.sections)
    ? hb.sections.map((s: any) => String(s?.karel_text ?? "")).join("\n")
    : "";

  const generation = String(row.generation_method ?? "").toLowerCase();
  const degraded = DEGRADED_METHOD_HINTS.some((h) => generation.includes(h));

  return (
    row.is_stale === false &&
    p?.briefing_truth_gate?.ok === true &&
    hb?.ok === true &&
    Array.isArray(hb.sections) &&
    hb.sections.length >= 6 &&
    !!ext &&
    FULL_ALLOWED_PROVIDER_STATUSES.has(String(ext.provider_status ?? "")) &&
    Number(audit.unsupported_claims_count ?? 0) === 0 &&
    Number(audit.robotic_phrase_count ?? 0) === 0 &&
    !DIRTY_VISIBLE_BRIEFING_RE.test(humanText) &&
    !degraded
  );
}

/**
 * Pick the best briefing row for display:
 *   1. Latest full renderable briefing (regardless of age within the input set).
 *   2. Otherwise the latest row in the input set (likely a fallback/degraded one).
 *   3. null when input is empty.
 */
export function selectBestBriefing<T extends BriefingSelectionRow>(rows: T[] | null | undefined): T | null {
  if (!rows || rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => {
    const ta = new Date(a.generated_at ?? 0).getTime();
    const tb = new Date(b.generated_at ?? 0).getTime();
    return tb - ta;
  });
  return sorted.find(isFullRenderableBriefing) ?? sorted[0] ?? null;
}

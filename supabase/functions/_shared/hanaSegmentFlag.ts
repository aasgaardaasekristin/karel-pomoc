/**
 * FIX 8.3 — feature flag pro persistenci segmentace Hančiných tahů.
 *
 * Vzor převzat z `crisisFeatureFlag.ts` (system_config single source of truth).
 * Fail-closed: jakákoli chyba → false → memory write se neprovede,
 * AUDIT se však zapisuje vždy (per brief 8.3) nezávisle na flagu.
 *
 * key:   hana_segment_writes_enabled
 * true:  povoluje insert do hana_personal_memory per non-ambiguous segment
 * false: pouze audit do hana_personal_identity_audit, žádný memory write
 */
export async function isHanaSegmentWritesEnabled(sb: any): Promise<boolean> {
  try {
    const { data, error } = await sb
      .from("system_config")
      .select("value")
      .eq("key", "hana_segment_writes_enabled")
      .maybeSingle();
    if (error || !data) return false;
    return String(data.value).toLowerCase().trim() === "true";
  } catch {
    return false;
  }
}

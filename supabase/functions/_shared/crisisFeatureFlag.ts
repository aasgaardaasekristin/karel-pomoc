/**
 * FIX 1.8 — Crisis feature flag (fail-closed).
 * Vrací true pouze pokud system_config.crisis_enabled == 'true'.
 * V případě jakékoli chyby vrací false (crisis OFF) — fail-closed.
 */
export async function isCrisisEnabled(sb: any): Promise<boolean> {
  try {
    const { data, error } = await sb
      .from("system_config")
      .select("value")
      .eq("key", "crisis_enabled")
      .maybeSingle();
    if (error || !data) return false;
    return String(data.value).toLowerCase().trim() === "true";
  } catch {
    return false;
  }
}

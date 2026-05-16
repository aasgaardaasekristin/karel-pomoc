/**
 * FIX 1.5 (2026-05-16) — Drive 01_INDEX → did_part_registry sync pause flag.
 *
 * Dokud Kristin nedokončí konverzi Drive 01_INDEX na Google Sheets s 39
 * kanonickými částmi, žádná funkce nesmí psát do did_part_registry na základě
 * Drive zdroje. Tento helper čte flag z public.system_config.
 *
 * Aktivace zpět: UPDATE system_config SET value='true' WHERE key='drive_index_sync_enabled';
 * (žádný deploy potřeba)
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

export const DRIVE_INDEX_SYNC_FLAG_KEY = "drive_index_sync_enabled";
export const DRIVE_INDEX_SYNC_PAUSED_REASON = "drive_index_sync_paused_fix_1_5";

/**
 * Returns true if Drive 01_INDEX → DB sync is currently allowed.
 * Fail-closed: any error or missing row ⇒ false (sync paused).
 */
export async function isDriveIndexSyncEnabled(
  sb: ReturnType<typeof createClient>,
): Promise<boolean> {
  try {
    const { data, error } = await sb
      .from("system_config")
      .select("value")
      .eq("key", DRIVE_INDEX_SYNC_FLAG_KEY)
      .maybeSingle();
    if (error) {
      console.warn("[FIX 1.5] system_config read failed, fail-closed (paused):", error.message);
      return false;
    }
    return data?.value === "true";
  } catch (err) {
    console.warn("[FIX 1.5] system_config read threw, fail-closed (paused):", err);
    return false;
  }
}

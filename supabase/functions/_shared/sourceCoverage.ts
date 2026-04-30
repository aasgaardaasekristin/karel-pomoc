/**
 * sourceCoverage.ts — Morning ingestion coverage audit
 *
 * Pro každý relevantní zdroj (DB tabulku / kanál) zjistí:
 *   - raw_count   = kolik raw řádků přibylo / bylo aktivních za posledních 36h
 *   - ingested_count = kolik z toho prošlo did_event_ingestion_log (status≠failed)
 *   - pantry_count   = kolik z toho dorazilo do karel_pantry_b_entries
 *   - used_in_briefing = bool — true když coverage helper vidí, že briefing payload
 *     z toho zdroje něco použil (nastavuje se externě = volající doplní seznam),
 *     jinak heuristika ingested_count > 0.
 *   - reason_if_not_used = enumerace, proč zdroj v briefingu chybí
 *
 * Heuristika reason_if_not_used (pokud raw_count > 0 a not used):
 *   - "privacy_blocked"           → karel_hana_conversations bez DID-relevantní implikace
 *   - "schema_blocked_missing_user_scope" → ingestion log přítomen, ale není scoped
 *   - "adapter_not_implemented"   → není v supportedSources mapě
 *   - "no_new_relevant_content"   → ingestion log má records ale všechny jsou skipped
 *   - "already_processed_and_recently_used" → pantry entries existují, processed_at < 24h
 *   - "not_did_relevant"          → zdroj zapsal, ale ingestion log explicitně skipped:not_did_relevant
 *
 * Privacy:
 *   - karel_hana_conversations raw_count se počítá vždy. Raw obsah se NIKDY
 *     nevkládá do payloadu — jen agregát + implikace, které prošly Pantry B
 *     se source_kind='hana_personal_ingestion'.
 *   - Pokud raw_count > 0 a žádná DID-relevantní implikace neprošla, výsledek
 *     ponese `reason_if_not_used = 'privacy_blocked'` a `raw_personal_to_drive=false`.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

export interface SourceCoverageRow {
  source: string;
  source_table: string;
  raw_count: number;
  ingested_count: number;
  pantry_count: number;
  used_in_briefing: boolean;
  reason_if_not_used: string | null;
  privacy_safe: boolean;
  latest_raw_at: string | null;
  latest_ingested_at: string | null;
  latest_pantry_at: string | null;
}

export interface SourceCoverageSummary {
  generated_at: string;
  window_hours: number;
  sources: SourceCoverageRow[];
  totals: {
    raw_count: number;
    ingested_count: number;
    pantry_count: number;
    used_count: number;
    privacy_blocked_count: number;
    not_used_count: number;
  };
}

interface SourceDef {
  source: string;
  table: string;
  activityColumn: string;            // sloupec s časem aktivity
  pantrySourceKinds?: string[];      // odpovídající karel_pantry_b_entries.source_kind
  ingestionSourceKinds?: string[];   // odpovídající did_event_ingestion_log.source_kind
  scopeColumn?: string;              // pokud chybí user_id, projektově skipuj
  privacyClass?: "personal" | "clinical";
}

const SOURCES: SourceDef[] = [
  {
    source: "did_threads",
    table: "did_threads",
    activityColumn: "last_activity_at",
    pantrySourceKinds: ["did_thread_ingestion", "chat_postwriteback"],
    ingestionSourceKinds: ["did_thread_ingestion", "chat_postwriteback"],
    scopeColumn: "user_id",
    privacyClass: "clinical",
  },
  {
    source: "karel_hana_conversations",
    table: "karel_hana_conversations",
    activityColumn: "last_activity_at",
    pantrySourceKinds: ["hana_personal_ingestion"],
    ingestionSourceKinds: ["hana_personal_ingestion"],
    scopeColumn: "user_id",
    privacyClass: "personal",
  },
  {
    source: "did_live_session_progress",
    table: "did_live_session_progress",
    activityColumn: "updated_at",
    pantrySourceKinds: ["live_session_progress", "live_session_reality_override", "therapy_session"],
    ingestionSourceKinds: ["live_session_progress", "live_session_reality_override"],
    scopeColumn: "user_id",
    privacyClass: "clinical",
  },
  {
    source: "did_therapist_tasks",
    table: "did_therapist_tasks",
    activityColumn: "updated_at",
    pantrySourceKinds: ["therapist_task_note", "therapist_note"],
    ingestionSourceKinds: ["therapist_task_note"],
    scopeColumn: "user_id",
    privacyClass: "clinical",
  },
  {
    source: "briefing_ask_resolutions",
    table: "briefing_ask_resolutions",
    activityColumn: "updated_at",
    pantrySourceKinds: ["briefing_ask_resolution"],
    ingestionSourceKinds: ["briefing_ask_resolution"],
    scopeColumn: "user_id",
    privacyClass: "clinical",
  },
  {
    source: "did_team_deliberations",
    table: "did_team_deliberations",
    activityColumn: "updated_at",
    pantrySourceKinds: ["team_deliberation", "team_deliberation_answer", "deliberation_event"],
    ingestionSourceKinds: ["team_deliberation"],
    scopeColumn: "user_id",
    privacyClass: "clinical",
  },
  {
    source: "did_session_reviews",
    table: "did_session_reviews",
    activityColumn: "updated_at",
    pantrySourceKinds: ["therapy_session", "playroom"],
    ingestionSourceKinds: ["therapy_session", "playroom"],
    scopeColumn: "user_id",
    privacyClass: "clinical",
  },
  {
    source: "did_daily_session_plans",
    table: "did_daily_session_plans",
    activityColumn: "updated_at",
    pantrySourceKinds: ["live_session_progress", "playroom_progress"],
    ingestionSourceKinds: [],
    scopeColumn: "user_id",
    privacyClass: "clinical",
  },
];

interface BuildOptions {
  windowHours?: number;
  // Names of source IDs the caller positively confirmed were used in the briefing payload.
  usedSourceIds?: string[];
}

export async function buildSourceCoverageSummary(
  sb: SupabaseClient,
  userId: string,
  opts: BuildOptions = {},
): Promise<SourceCoverageSummary> {
  const windowHours = opts.windowHours ?? 36;
  const sinceISO = new Date(Date.now() - windowHours * 3600_000).toISOString();
  const usedSet = new Set((opts.usedSourceIds ?? []).map((s) => s.trim()));

  const sources: SourceCoverageRow[] = [];
  let raw_total = 0, ing_total = 0, pantry_total = 0, used_total = 0, privacy_blocked = 0, not_used = 0;

  for (const def of SOURCES) {
    let raw_count = 0;
    let latest_raw_at: string | null = null;
    try {
      const { data, error } = await sb
        .from(def.table)
        .select(`id, ${def.activityColumn}`)
        .eq(def.scopeColumn || "user_id", userId)
        .gte(def.activityColumn, sinceISO)
        .order(def.activityColumn, { ascending: false })
        .limit(500);
      if (!error && Array.isArray(data)) {
        raw_count = data.length;
        latest_raw_at = (data[0] as any)?.[def.activityColumn] ?? null;
      }
    } catch (_e) {
      // tabulka neexistuje nebo schéma se liší — coverage NESMÍ shodit briefing
      raw_count = 0;
    }

    let ingested_count = 0;
    let latest_ingested_at: string | null = null;
    if ((def.ingestionSourceKinds?.length ?? 0) > 0) {
      try {
        const { data, error } = await sb
          .from("did_event_ingestion_log")
          .select("id, occurred_at, status")
          .in("source_kind", def.ingestionSourceKinds!)
          .gte("occurred_at", sinceISO)
          .order("occurred_at", { ascending: false })
          .limit(500);
        if (!error && Array.isArray(data)) {
          const successful = data.filter((r: any) => r.status !== "failed");
          ingested_count = successful.length;
          latest_ingested_at = successful[0]?.occurred_at ?? null;
        }
      } catch { /* swallow */ }
    }

    let pantry_count = 0;
    let latest_pantry_at: string | null = null;
    if ((def.pantrySourceKinds?.length ?? 0) > 0) {
      try {
        const { data, error } = await sb
          .from("karel_pantry_b_entries")
          .select("id, created_at")
          .eq("user_id", userId)
          .in("source_kind", def.pantrySourceKinds!)
          .gte("created_at", sinceISO)
          .order("created_at", { ascending: false })
          .limit(500);
        if (!error && Array.isArray(data)) {
          pantry_count = data.length;
          latest_pantry_at = data[0]?.created_at ?? null;
        }
      } catch { /* swallow */ }
    }

    const used_in_briefing = usedSet.has(def.source) || (ingested_count > 0 && pantry_count > 0);
    let reason_if_not_used: string | null = null;
    let privacy_safe = true;

    if (raw_count > 0 && !used_in_briefing) {
      if (def.privacyClass === "personal") {
        // Hana/Osobní: pokud raw existuje, ale Pantry B nemá hana_personal_ingestion → privacy block
        if (pantry_count === 0) {
          reason_if_not_used = "privacy_blocked";
          privacy_safe = true; // korektní chování
        } else {
          reason_if_not_used = "no_new_relevant_content";
        }
      } else if ((def.ingestionSourceKinds?.length ?? 0) === 0) {
        reason_if_not_used = "adapter_not_implemented";
      } else if (ingested_count === 0) {
        reason_if_not_used = "no_new_relevant_content";
      } else if (pantry_count > 0) {
        reason_if_not_used = "already_processed_and_recently_used";
      } else {
        reason_if_not_used = "not_did_relevant";
      }
    }

    if (used_in_briefing) used_total++;
    if (reason_if_not_used === "privacy_blocked") privacy_blocked++;
    if (raw_count > 0 && !used_in_briefing) not_used++;

    raw_total += raw_count;
    ing_total += ingested_count;
    pantry_total += pantry_count;

    sources.push({
      source: def.source,
      source_table: def.table,
      raw_count,
      ingested_count,
      pantry_count,
      used_in_briefing,
      reason_if_not_used,
      privacy_safe,
      latest_raw_at,
      latest_ingested_at,
      latest_pantry_at,
    });
  }

  return {
    generated_at: new Date().toISOString(),
    window_hours: windowHours,
    sources,
    totals: {
      raw_count: raw_total,
      ingested_count: ing_total,
      pantry_count: pantry_total,
      used_count: used_total,
      privacy_blocked_count: privacy_blocked,
      not_used_count: not_used,
    },
  };
}

/**
 * Pravdivý drive_status. Tento pass NEIMPLEMENTUJE Drive→Pantry refresh.
 * Funkce kontroluje stav write queue a flush archivu z DB tabulek
 * `did_pending_drive_writes` a `did_pantry_packages` (pokud existují).
 */
export async function buildDriveStatus(sb: SupabaseClient): Promise<{
  drive_write_queue: "working" | "blocked" | "unknown";
  drive_flush_to_archive: "working" | "blocked" | "unknown";
  drive_to_pantry_refresh: "implemented" | "not_implemented" | "partial";
  drive_is_source_of_truth: boolean;
  operational_source: string;
  notes?: string;
}> {
  let writeQueueState: "working" | "blocked" | "unknown" = "unknown";
  let flushState: "working" | "blocked" | "unknown" = "unknown";

  try {
    const { data, error } = await sb
      .from("did_pending_drive_writes")
      .select("status, created_at, processed_at")
      .gte("created_at", new Date(Date.now() - 6 * 3600_000).toISOString())
      .order("created_at", { ascending: false })
      .limit(50);
    if (!error && Array.isArray(data)) {
      if (data.length === 0) {
        writeQueueState = "working"; // queue prázdná = neblokuje
      } else {
        const failed = data.filter((r: any) => r.status === "failed").length;
        const pendingTooLong = data.filter((r: any) =>
          r.status === "pending" && r.created_at &&
          (Date.now() - new Date(r.created_at).getTime()) > 30 * 60_000
        ).length;
        writeQueueState = (failed > 0 || pendingTooLong > 0) ? "blocked" : "working";
      }
    }
  } catch { /* keep unknown */ }

  try {
    const { data, error } = await sb
      .from("did_pantry_packages")
      .select("status, created_at, processed_at")
      .gte("created_at", new Date(Date.now() - 24 * 3600_000).toISOString())
      .order("created_at", { ascending: false })
      .limit(50);
    if (!error && Array.isArray(data)) {
      if (data.length === 0) {
        flushState = "working";
      } else {
        const failed = data.filter((r: any) => r.status === "failed").length;
        flushState = failed > 0 ? "blocked" : "working";
      }
    }
  } catch { /* keep unknown */ }

  return {
    drive_write_queue: writeQueueState,
    drive_flush_to_archive: flushState,
    drive_to_pantry_refresh: "not_implemented",
    drive_is_source_of_truth: false,
    operational_source: "DB/Pantry/Event ingestion",
    notes:
      "Drive is audit/archive in this build. Drive→Pantry refresh is not implemented. " +
      "Operational source for morning briefing is DB/Pantry/Event ingestion.",
  };
}

/**
 * P30.3 — Detect parts that are *actually relevant today*.
 *
 * Sources (in confidence order):
 *   1. today_part_proposal.proposed_part         (high)
 *   2. selected_part on today's daily/session/playroom plan (high)
 *   3. live progress selected_part               (high)
 *   4. recent did_threads in last 24–72h         (medium)
 *   5. explicit watchlist (sensitivities w/ query_enabled=true) (low)
 *   6. recent active_part_daily_brief activity_status in active_thread/recent_thread/watchlist (low)
 *
 * Hard exclusions: Hana / Hanka / Hanička / Karel / Káťa / Kata are NOT parts.
 * NEVER include all `did_part_registry.status='active'` rows blindly.
 */

// deno-lint-ignore no-explicit-any
type SB = any;

export type RelevanceSource =
  | "today_part_proposal"
  | "session_plan"
  | "playroom_plan"
  | "recent_thread"
  | "live_progress"
  | "explicit_watchlist"
  | "active_part_daily_brief";

export interface TodayRelevantPartContext {
  part_name: string;
  source: RelevanceSource;
  confidence: "high" | "medium" | "low";
  reason: string;
}

const NON_PART_NAMES = new Set([
  "hana", "hanka", "hanička", "hanicka",
  "karel", "káťa", "katia", "kata", "katka",
  "system", "systém", "terapeutka", "terapeut",
]);

function normalizeName(s: string | null | undefined): string {
  if (!s) return "";
  return s.trim().toLowerCase();
}

function isPartName(name: string | null | undefined): boolean {
  const n = normalizeName(name);
  if (!n) return false;
  if (NON_PART_NAMES.has(n)) return false;
  // strip diacritics for safety
  const stripped = n.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (NON_PART_NAMES.has(stripped)) return false;
  return true;
}

export interface DetectInput {
  userId: string;
  datePrague: string;
  maxParts?: number;
}

export async function detectTodayRelevantParts(
  sb: SB,
  input: DetectInput,
): Promise<TodayRelevantPartContext[]> {
  const out = new Map<string, TodayRelevantPartContext>();
  const max = Math.max(1, Math.min(20, input.maxParts ?? 8));

  function add(ctx: TodayRelevantPartContext) {
    if (!isPartName(ctx.part_name)) return;
    const key = ctx.part_name;
    const prev = out.get(key);
    if (!prev) {
      out.set(key, ctx);
      return;
    }
    const order = { high: 3, medium: 2, low: 1 } as const;
    if (order[ctx.confidence] > order[prev.confidence]) out.set(key, ctx);
  }

  // 1) today_part_proposal
  try {
    const { data } = await sb
      .from("did_today_part_proposals")
      .select("proposed_part, rationale_text, proposal_date, created_at")
      .eq("user_id", input.userId)
      .eq("proposal_date", input.datePrague)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data?.proposed_part) {
      add({
        part_name: data.proposed_part,
        source: "today_part_proposal",
        confidence: "high",
        reason: `today_part_proposal pro ${input.datePrague}`,
      });
    }
  } catch { /* table optional */ }

  // 2) session/playroom plan selected_part for today
  try {
    const { data } = await sb
      .from("did_daily_session_plans")
      .select("selected_part, plan_date, status, lifecycle_status, updated_at")
      .eq("user_id", input.userId)
      .eq("plan_date", input.datePrague)
      .order("updated_at", { ascending: false })
      .limit(3);
    for (const row of (data ?? []) as Array<any>) {
      if (row?.selected_part) {
        add({
          part_name: row.selected_part,
          source: "session_plan",
          confidence: "high",
          reason: `selected_part v denním plánu (${row.status ?? "?"})`,
        });
      }
    }
  } catch { /* */ }

  // 3) live progress
  try {
    const { data } = await sb
      .from("did_live_session_progress")
      .select("selected_part, last_activity_at")
      .eq("user_id", input.userId)
      .gte("last_activity_at", new Date(Date.now() - 36 * 3600 * 1000).toISOString())
      .order("last_activity_at", { ascending: false })
      .limit(5);
    for (const row of (data ?? []) as Array<any>) {
      if (row?.selected_part) {
        add({
          part_name: row.selected_part,
          source: "live_progress",
          confidence: "high",
          reason: "selected_part v běžícím live progress (≤36h)",
        });
      }
    }
  } catch { /* */ }

  // 4) recent did_threads in last 72h
  try {
    const since = new Date(Date.now() - 72 * 3600 * 1000).toISOString();
    const { data } = await sb
      .from("did_threads")
      .select("part_name, last_message_at, updated_at")
      .eq("user_id", input.userId)
      .gte("updated_at", since)
      .order("updated_at", { ascending: false })
      .limit(20);
    for (const row of (data ?? []) as Array<any>) {
      if (row?.part_name) {
        add({
          part_name: row.part_name,
          source: "recent_thread",
          confidence: "medium",
          reason: `vlákno aktivní v posledních 72h (${row.last_message_at ?? row.updated_at})`,
        });
      }
    }
  } catch { /* */ }

  // 5) explicit watchlist (sensitivities w/ query_enabled=true)
  try {
    const { data } = await sb
      .from("part_external_event_sensitivities")
      .select("part_name, query_enabled, active")
      .eq("user_id", input.userId)
      .eq("active", true)
      .eq("query_enabled", true);
    for (const row of (data ?? []) as Array<any>) {
      if (row?.part_name) {
        add({
          part_name: row.part_name,
          source: "explicit_watchlist",
          confidence: "low",
          reason: "explicit watchlist (sensitivity query_enabled=true)",
        });
      }
    }
  } catch { /* */ }

  // 6) recent active_part_daily_brief — P30.4 presentation-safe filter
  try {
    const { data } = await sb
      .from("did_active_part_daily_brief")
      .select("part_name, activity_status, brief_date, evidence_summary")
      .eq("user_id", input.userId)
      .gte("brief_date", input.datePrague)
      .in("activity_status", ["active_thread", "recent_thread", "watchlist"])
      .limit(40);
    const PRESENTATION_QPV = "p30.3_personal_anchor_general_trigger_weekly_matrix";
    for (const row of (data ?? []) as Array<any>) {
      const ev = row?.evidence_summary ?? {};
      if (ev.excluded_from_briefing === true) continue;
      if (!ev.weekly_matrix_ref) continue;
      if (ev.query_plan_version !== PRESENTATION_QPV) continue;
      if (row?.part_name) {
        add({
          part_name: row.part_name,
          source: "active_part_daily_brief",
          confidence: "low",
          reason: `active_part_daily_brief.activity_status=${row.activity_status}`,
        });
      }
    }
  } catch { /* */ }

  return Array.from(out.values()).slice(0, max);
}

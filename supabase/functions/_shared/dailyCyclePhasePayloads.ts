/**
 * P33.5G — phase4_centrum_tail payload-ref ensure helper.
 *
 * `phase4_centrum_tail` is in P29B3_REQUIRED_PHASE_JOB_KINDS and therefore
 * must have a row in did_daily_cycle_phase_jobs for EVERY full daily cycle.
 * Previously the orchestrator silently skipped it whenever the upstream
 * payload upsert returned no row, leaving the cycle with 13/14 required
 * jobs. That state was incorrectly treated as "accepted with caveat".
 *
 * This helper guarantees a deterministic payload row exists for the cycle,
 * so the early-enqueue helper can always enqueue the job. When no real
 * centrum payload data is available, a deterministic empty payload is
 * persisted; the worker treats `empty_payload=true` as `controlled_skipped`
 * with reason `empty_centrum_payload_no_tail_work`. The job row itself is
 * never missing.
 */

export interface CentrumTailPayloadRef {
  payload_table: "did_daily_cycle_phase_payloads";
  payload_id: string;
  payload_hash: string;
  job_kind: "phase4_centrum_tail";
}

export interface EnsureCentrumTailPayloadRefInput {
  sb: any;
  cycleId: string;
  userId: string;
  source: string;
  /** Optional real payload. If absent / empty, an empty payload is persisted. */
  centrumPayload?: Record<string, unknown> | null;
}

export interface EnsureCentrumTailPayloadRefResult {
  ok: boolean;
  ref: CentrumTailPayloadRef | null;
  created: boolean;
  reused: boolean;
  empty_payload: boolean;
  reason?: string;
  errors: string[];
}

function djb2Hex(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return (h >>> 0).toString(16);
}

function isEmptyPayload(p: Record<string, unknown> | null | undefined): boolean {
  if (!p || typeof p !== "object") return true;
  const keys = Object.keys(p);
  if (keys.length === 0) return true;
  // Heuristic: real centrum payload always carries validatedAnalysisText.
  const hasText = typeof (p as any).validatedAnalysisText === "string"
    && ((p as any).validatedAnalysisText as string).trim().length > 0;
  return !hasText;
}

/**
 * Ensure a payload row exists for (cycle_id, job_kind='phase4_centrum_tail').
 * Returns a stable payload_ref the orchestrator can pass to the early enqueue.
 * Never silently returns null `ref` when ok=true.
 */
export async function ensureCentrumTailPayloadRef(
  i: EnsureCentrumTailPayloadRefInput,
): Promise<EnsureCentrumTailPayloadRefResult> {
  const errors: string[] = [];
  const empty = isEmptyPayload(i.centrumPayload ?? null);

  // 1) Reuse an existing row if any.
  try {
    const { data: existing, error: selErr } = await i.sb
      .from("did_daily_cycle_phase_payloads")
      .select("id,payload_hash,payload")
      .eq("cycle_id", i.cycleId)
      .eq("job_kind", "phase4_centrum_tail")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (selErr) {
      errors.push(`select:${selErr.message ?? String(selErr)}`);
    } else if (existing?.id) {
      return {
        ok: true,
        ref: {
          payload_table: "did_daily_cycle_phase_payloads",
          payload_id: existing.id as string,
          payload_hash: (existing.payload_hash as string) ?? "reused",
          job_kind: "phase4_centrum_tail",
        },
        created: false,
        reused: true,
        empty_payload: !!(existing.payload && (existing.payload as any).empty_payload === true),
        errors,
      };
    }
  } catch (e: any) {
    errors.push(`select_ex:${e?.message ?? String(e)}`);
  }

  // 2) Build the payload to insert.
  const nowIso = new Date().toISOString();
  const payload = empty
    ? {
        kind: "phase4_centrum_tail",
        source: `p33_5g_empty_centrum_payload:${i.source}`,
        empty_payload: true,
        reason: "centrum_tail_payload_missing_but_required_job_must_be_enqueued",
        items: [] as unknown[],
        created_at: nowIso,
      }
    : {
        ...((i.centrumPayload ?? {}) as Record<string, unknown>),
        kind: "phase4_centrum_tail",
        source: i.source,
        empty_payload: false,
      };

  const payload_hash = djb2Hex(
    empty
      ? `empty:${i.cycleId}:phase4_centrum_tail`
      : JSON.stringify(payload),
  );

  // 3) Insert / upsert.
  try {
    const { data: row, error: insErr } = await i.sb
      .from("did_daily_cycle_phase_payloads")
      .upsert(
        {
          cycle_id: i.cycleId,
          user_id: i.userId,
          job_kind: "phase4_centrum_tail",
          payload_kind: empty ? "tail_input_empty_v1" : "tail_input_v1",
          payload,
          payload_hash,
        },
        { onConflict: "cycle_id,job_kind,payload_kind" },
      )
      .select("id")
      .single();
    if (insErr || !row?.id) {
      errors.push(`upsert:${insErr?.message ?? "no_row"}`);
      return {
        ok: false,
        ref: null,
        created: false,
        reused: false,
        empty_payload: empty,
        reason: "payload_upsert_failed",
        errors,
      };
    }
    return {
      ok: true,
      ref: {
        payload_table: "did_daily_cycle_phase_payloads",
        payload_id: row.id as string,
        payload_hash,
        job_kind: "phase4_centrum_tail",
      },
      created: true,
      reused: false,
      empty_payload: empty,
      errors,
    };
  } catch (e: any) {
    errors.push(`upsert_ex:${e?.message ?? String(e)}`);
    return {
      ok: false,
      ref: null,
      created: false,
      reused: false,
      empty_payload: empty,
      reason: "payload_upsert_exception",
      errors,
    };
  }
}

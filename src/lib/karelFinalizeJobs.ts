import { supabase } from "@/integrations/supabase/client";

type FinalizeJobStatus = "queued" | "running" | "completed" | "failed" | "already_done";

type FinalizeJobResult = {
  ok: boolean;
  status: FinalizeJobStatus | "unknown";
  jobId?: string | null;
  reviewId?: string | null;
  error?: string;
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJobStatus(dedupeKey: string, jobId?: string | null) {
  const { data, error } = await (supabase as any).functions.invoke("karel-action-job-status", {
    body: jobId ? { job_id: jobId } : { dedupe_key: dedupeKey },
  });
  if (error) throw error;
  return data as any;
}

async function currentReviewExists(planId: string) {
  const { data } = await (supabase as any)
    .from("did_session_reviews")
    .select("id, status")
    .eq("plan_id", planId)
    .eq("is_current", true)
    .maybeSingle();
  return data as { id: string; status: string } | null;
}

export async function finalizeDidSessionWithJob(params: {
  planId: string;
  source: string;
  reason: string;
  onAccepted?: () => void;
}): Promise<FinalizeJobResult> {
  const dedupeKey = `finalize_session:${params.planId}`;
  let initial: any = null;

  try {
    const { data, error } = await (supabase as any).functions.invoke("karel-did-session-finalize", {
      body: { planId: params.planId, source: params.source, reason: params.reason, async: true },
    });
    if (error) throw error;
    initial = data;
  } catch (e: any) {
    try {
      initial = await getJobStatus(dedupeKey);
    } catch {
      const review = await currentReviewExists(params.planId);
      if (review?.id) return { ok: true, status: "already_done", reviewId: review.id };
      return { ok: false, status: "unknown", error: e?.message || "Stav finalizace se nepodařilo ověřit." };
    }
  }

  const jobId = initial?.job_id ?? null;
  let status = (initial?.job_status ?? initial?.status) as FinalizeJobStatus | undefined;
  if (status === "completed" || status === "already_done") {
    return { ok: true, status, jobId, reviewId: initial?.review_id ?? initial?.result_payload?.review_id ?? null };
  }
  if (status === "failed") return { ok: false, status, jobId, error: initial?.error || initial?.error_message || "Finalizace selhala." };

  params.onAccepted?.();
  for (let i = 0; i < 30; i += 1) {
    await wait(2500);
    const job = await getJobStatus(dedupeKey, jobId);
    status = job?.status as FinalizeJobStatus;
    if (status === "completed" || status === "already_done") {
      return { ok: true, status, jobId: job?.job_id ?? jobId, reviewId: job?.result_payload?.review_id ?? null };
    }
    if (status === "failed") {
      return { ok: false, status, jobId: job?.job_id ?? jobId, error: job?.error_message || "Finalizace selhala." };
    }
  }

  return { ok: true, status: status ?? "running", jobId };
}
/**
 * P29B.3-H4: phase76b_auto_feedback_ai helper.
 *
 * Detached version of the inline FÁZE 7.6b "Karel auto-feedback" block
 * from karel-did-daily-cycle. AI generation is triple-guarded:
 *
 *   - dry_run        (default true)  → only candidate selection + planning
 *   - generate_ai    (default false) → no AI call unless explicitly true
 *   - apply_output   (default false) → no DB write of AI output unless true
 *
 * The helper MUST NEVER:
 *   - send email
 *   - enqueue / perform any Drive write
 *   - mutate session / playroom / therapy plan rows
 *
 * The original inline block read from `did_therapist_tasks` + dedup table
 * `did_task_auto_feedback`, called the AI gateway via aiCallWrapper, and
 * inserted the AI result into `did_task_auto_feedback`. This helper
 * preserves that behavior — but only when generate_ai && apply_output.
 */

export interface Phase76bAutoFeedbackAiInput {
  dry_run?: boolean;
  generate_ai?: boolean;
  apply_output?: boolean;
  source?: string;
  max_candidates?: number;
}

export interface Phase76bAutoFeedbackAiParams {
  sb: any;
  cycleId: string;
  userId: string;
  input?: Phase76bAutoFeedbackAiInput;
  setHeartbeat?: () => Promise<void> | void;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface Phase76bAutoFeedbackAiResult {
  outcome: "completed" | "controlled_skipped";
  duration_ms: number;
  dry_run: boolean;
  generate_ai: boolean;
  apply_output: boolean;
  candidates_count: number;
  would_generate_count: number;
  ai_calls_made: number;
  generated_count: number;
  applied_count: number;
  skipped_count: number;
  deduped_count: number;
  controlled_skips: string[];
  errors: string[];
  source?: string;
}

const DEFAULT_MAX_CANDIDATES = 3;
const HARD_MAX_CANDIDATES = 10;
const AI_TIMEOUT_MS = 25_000;

export async function runPhase76bAutoFeedbackAi(
  params: Phase76bAutoFeedbackAiParams,
): Promise<Phase76bAutoFeedbackAiResult> {
  const started = Date.now();
  const input = params.input ?? {};
  const dry_run = input.dry_run !== false; // default TRUE
  const generate_ai = input.generate_ai === true; // default FALSE
  const apply_output = input.apply_output === true; // default FALSE
  const max_candidates = Math.min(
    Math.max(Number(input.max_candidates ?? DEFAULT_MAX_CANDIDATES), 1),
    HARD_MAX_CANDIDATES,
  );

  const errors: string[] = [];
  const controlled_skips: string[] = [];

  const result: Phase76bAutoFeedbackAiResult = {
    outcome: "completed",
    duration_ms: 0,
    dry_run,
    generate_ai,
    apply_output,
    candidates_count: 0,
    would_generate_count: 0,
    ai_calls_made: 0,
    generated_count: 0,
    applied_count: 0,
    skipped_count: 0,
    deduped_count: 0,
    controlled_skips,
    errors,
    source: input.source,
  };

  try {
    await params.setHeartbeat?.();

    // ── Phase 1: candidate selection (cheap DB) ──
    const { data: candidates, error: readErr } = await params.sb
      .from("did_therapist_tasks")
      .select("id, task, detail_instruction, assigned_to, status, created_at, completed_at, note")
      .in("status", ["done", "needs_review"])
      .order("completed_at", { ascending: false })
      .limit(Math.max(max_candidates * 3, 10));

    if (readErr) {
      const msg = String(readErr.message ?? readErr);
      if (/relation .* does not exist|missing/i.test(msg)) {
        controlled_skips.push("missing_required_table");
        result.outcome = "controlled_skipped";
        result.duration_ms = Date.now() - started;
        return result;
      }
      errors.push(`read_candidates: ${msg}`);
    }

    const candidateRows = (candidates ?? []) as Array<{
      id: string;
      task: string | null;
      detail_instruction: string | null;
      assigned_to: string | null;
      status: string | null;
      created_at: string | null;
      completed_at: string | null;
      note: string | null;
    }>;

    if (candidateRows.length === 0) {
      controlled_skips.push("no_auto_feedback_candidates");
      result.outcome = "controlled_skipped";
      result.duration_ms = Date.now() - started;
      return result;
    }

    // Dedup against existing auto-feedback rows.
    const ids = candidateRows.map(c => c.id);
    const { data: existing } = await params.sb
      .from("did_task_auto_feedback")
      .select("task_id")
      .in("task_id", ids);
    const haveFb = new Set<string>((existing ?? []).map((r: any) => r.task_id));

    const fresh = candidateRows.filter(c => {
      if (haveFb.has(c.id)) { result.deduped_count++; return false; }
      return true;
    }).slice(0, max_candidates);

    result.candidates_count = fresh.length;

    if (fresh.length === 0) {
      controlled_skips.push("no_auto_feedback_candidates");
      result.outcome = "controlled_skipped";
      result.duration_ms = Date.now() - started;
      return result;
    }

    // ── Phase 2: generation planning ──
    result.would_generate_count = fresh.length;

    if (dry_run) {
      controlled_skips.push("dry_run_no_ai_call");
      result.outcome = "completed";
      result.duration_ms = Date.now() - started;
      return result;
    }
    if (!generate_ai) {
      controlled_skips.push("generate_ai_false");
      result.outcome = "completed";
      result.duration_ms = Date.now() - started;
      return result;
    }

    const apiKey = (globalThis as any).Deno?.env?.get?.("LOVABLE_API_KEY");
    if (!apiKey) {
      controlled_skips.push("ai_gateway_not_configured");
      result.outcome = "controlled_skipped";
      result.duration_ms = Date.now() - started;
      return result;
    }

    // ── Phase 3: optional generation (guarded) ──
    // Lazy import to keep dry-run path AI-free even at module load.
    const { callAiForJson } = await import("./aiCallWrapper.ts");

    for (const task of fresh) {
      try {
        await params.setHeartbeat?.();
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), AI_TIMEOUT_MS);
        let fb: any = null;
        try {
          const r = await callAiForJson({
            systemPrompt: PHASE76B_SYSTEM_PROMPT,
            userPrompt: buildUserPrompt(task),
            apiKey,
            model: "google/gemini-2.5-flash-lite",
            requiredKeys: ["feedback_text", "quality_score"],
            maxRetries: 0,
            fallback: null,
            callerName: "phase76b_auto_feedback_ai",
          });
          result.ai_calls_made++;
          if (r.success && r.data) {
            fb = r.data;
            result.generated_count++;
          } else {
            result.skipped_count++;
          }
        } finally {
          clearTimeout(t);
        }

        if (fb && apply_output) {
          const text = String(fb.feedback_text ?? "").slice(0, 1000);
          const score = Math.min(5, Math.max(1, Number(fb.quality_score) || 3));
          const suggestions = (Array.isArray(fb.suggestions) ? fb.suggestions : []).slice(0, 3);
          const { error: insErr } = await params.sb
            .from("did_task_auto_feedback")
            .insert({
              task_id: task.id,
              part_name: null,
              feedback_text: text,
              feedback_type: task.status === "needs_review" ? "partial_review" : "completion",
              quality_score: score,
              suggestions,
              generated_by: "p29b3_h4_phase76b_auto_feedback_ai",
            });
          if (insErr) {
            errors.push(`apply_${task.id}: ${String(insErr.message ?? insErr)}`);
          } else {
            result.applied_count++;
          }
        } else if (fb && !apply_output) {
          if (!controlled_skips.includes("apply_output_false")) {
            controlled_skips.push("apply_output_false");
          }
        }
      } catch (e: any) {
        errors.push(`gen_${task.id}: ${e?.message ?? String(e)}`);
        result.skipped_count++;
      }
    }

    result.outcome = "completed";
    result.duration_ms = Date.now() - started;
    return result;
  } catch (e: any) {
    errors.push(e?.message ?? String(e));
    result.outcome = "completed";
    result.duration_ms = Date.now() - started;
    return result;
  }
}

const PHASE76B_SYSTEM_PROMPT = `Jsi Karel — klinický psycholog. Generuješ STRUČNOU pracovní zpětnou vazbu pro terapeutku ke splněnému/k revizi určenému úkolu.

PŘÍSNÁ PRAVIDLA (anti-halucinace):
- Nevytvářej klinický závěr bez evidence v dodaném kontextu.
- Nevytvářej nový plán Sezení ani Herny.
- Neměň žádný stávající terapeutický plán.
- Nevkládej raw intimní text klienta — pracuj jen s pracovními poznámkami.
- Vždy označ, co je hypotéza, a co je třeba ověřit.
- Žádné medical/legal claims.
- Žádné potvrzení neověřených DID faktů.
- Buď konkrétní (obecné fráze typu "dobrá práce" jsou ZAKÁZÁNY).

OUTPUT: výhradně JSON dle schématu.`;

function buildUserPrompt(task: {
  task: string | null;
  detail_instruction: string | null;
  assigned_to: string | null;
  status: string | null;
  created_at: string | null;
  note: string | null;
}): string {
  return `ÚKOL: "${task.task ?? ""}"
DETAIL: ${task.detail_instruction ?? "žádný"}
PŘIŘAZENO: ${task.assigned_to ?? "n/a"}
STATUS: ${task.status ?? "n/a"}
POZNÁMKA: ${task.note ?? "žádná"}
VYTVOŘENO: ${task.created_at ?? "n/a"}

Vrať JSON:
{
  "feedback_text": "2-4 věty konkrétní pracovní zpětné vazby s vyznačením jistoty (jistě/hypotéza/k ověření)",
  "quality_score": 1-5,
  "suggestions": ["follow-up 1", "follow-up 2"],
  "certainty": "low|medium|high",
  "needs_verification": ["co je třeba ověřit"]
}`;
}

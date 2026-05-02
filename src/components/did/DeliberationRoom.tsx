import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useVisibleClinicalTextAudit } from "@/lib/visibleClinicalTextGuard";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import RichMarkdown from "@/components/ui/RichMarkdown";
import {
  Loader2,
  CheckCircle2,
  Send,
  ArrowRight,
  Users,
  Brain,
  AlertTriangle,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { useTeamDeliberations } from "@/hooks/useTeamDeliberations";
import DidLiveSessionPanel from "./DidLiveSessionPanel";
import { getAuthHeaders } from "@/lib/auth";
import { liveStartStatusText, planApprovalSynced } from "@/lib/dailyPlanStartPolicy";
import {
  signoffProgress,
  type TeamDeliberation,
  type DeliberationQuestion,
  type KarelSynthesis,
  type AgendaBlock,
} from "@/types/teamDeliberation";
import { sanitizeRecencyText } from "@/lib/recencySanitizer";
import {
  getLiveProgramTitle,
  getPlanChangeLabel,
  hasActiveExternalCurrentEventReplan,
  isPlayroomDeliberation,
  sanitizeHernaVisibleText,
} from "./deliberationRoomUiHelpers";

interface Props {
  deliberationId: string | null;
  onClose: () => void;
  onChanged?: () => void;
}

const TYPE_LABEL: Record<string, string> = {
  team_task: "Společné rozhodnutí",
  session_plan: "Plán sezení",
  crisis: "Krizová koordinace",
  followup_review: "Vyhodnocení sezení",
  supervision: "Supervize",
};

interface LiveSessionPlanRow {
  id: string;
  selected_part: string;
  session_lead: string | null;
  therapist: string | null;
  plan_markdown: string;
  status?: string | null;
  lifecycle_status?: string | null;
  program_status?: string | null;
  approved_at?: string | null;
  urgency_breakdown?: Record<string, unknown> | null;
}

const PROGRAM_START_BLOCKED_STATUSES = new Set([
  "draft",
  "in_revision",
  "awaiting_signatures",
  "awaiting_signature",
  "pending_review",
]);

function unsignedStartBlockReason(
  d: TeamDeliberation | null | undefined,
  plan?: LiveSessionPlanRow | null,
) {
  const contract =
    plan?.urgency_breakdown && typeof plan.urgency_breakdown === "object"
      ? (plan.urgency_breakdown as Record<string, any>)
      : {};
  const programStatus = String(
    plan?.program_status ||
      contract.review_state ||
      contract.approval?.review_state ||
      "",
  ).toLowerCase();
  const humanReviewRequired =
    contract.human_review_required === true ||
    contract.approval?.required === true ||
    contract.playroom_plan?.approval?.required === true ||
    contract.playroom_plan?.therapist_review?.required === true;
  const reviewFulfilled =
    ["approved", "ready_to_start", "in_progress", "completed"].includes(
      programStatus,
    ) || !!plan?.approved_at || !!contract.approved_at;
  const childFacingPlayroom =
    contract.session_actor === "karel_direct" ||
    contract.ui_surface === "did_kids_playroom" ||
    !!contract.playroom_plan;
  const approvedForChild =
    contract.approved_for_child_session === true ||
    contract.approval?.approved_for_child_session === true ||
    contract.playroom_plan?.approval?.approved_for_child_session === true ||
    contract.playroom_plan?.therapist_review?.approved_for_child_session ===
      true;
  if (
    !d ||
    d.hanka_signed_at === null ||
    d.kata_signed_at === null ||
    d.status !== "approved" ||
    (humanReviewRequired && !reviewFulfilled) ||
    PROGRAM_START_BLOCKED_STATUSES.has(programStatus) ||
    (childFacingPlayroom && !approvedForChild)
  ) {
    return "Program byl upraven podle odpovědi terapeutky a čeká na podpis Haničky a Káti.";
  }
  return null;
}

type LiveProgramBlock = {
  block?: string | null;
  minutes?: number | null;
  detail?: string | null;
  clinical_intent?: string | null;
  playful_form?: string | null;
  script?: string | null;
  observe?: string[] | string | null;
  evidence_to_record?: string[] | string | null;
  stop_if?: string[] | string | null;
  fallback?: string | null;
  requires_physical_therapist?: boolean | null;
  karel_can_do_alone?: boolean | null;
};

const PROGRAM_TEXT_FIELDS: Array<[keyof LiveProgramBlock, string]> = [
  ["clinical_intent", "Záměr"],
  ["playful_form", "Hravá forma"],
  ["script", "Věta"],
  ["fallback", "Fallback"],
];

const PROGRAM_LIST_FIELDS: Array<[keyof LiveProgramBlock, string]> = [
  ["observe", "Sledovat"],
  ["evidence_to_record", "Zapsat pro Karla"],
  ["stop_if", "Zastavit když"],
];

function textValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function listValue(value: unknown) {
  if (Array.isArray(value))
    return value.map((item) => String(item ?? "").trim()).filter(Boolean);
  const single = textValue(value);
  return single ? [single] : [];
}

const FORBIDDEN_VISIBLE_DEBUG_RE = /pending_review|evidence_limited|needs_therapist_input|awaiting_therapist_review|backend_context_inputs|source_ref|therapist_factual_correction|external_fact|evidence discipline|child evidence|real-world context|operational context|faktick[áa]\s+korekce\s+reality|nepředstírat klinické závěry|průběh, který nemá transcript|První pracovní návrh:\s*Část|Stav:\s*awaiting/i;

function cleanVisiblePlanText(value: unknown, fallback = "") {
  const cleaned = sanitizeRecencyText(
    String(value ?? "")
      .replace(/\bpending_review\b/gi, "čeká na klinické dovyhodnocení")
      .replace(/\bevidence_limited\b/gi, "zatím bez dostatečných podkladů")
      .replace(/\bneeds_therapist_input\b/gi, "čeká na doplnění od terapeutek")
      .replace(/\bawaiting_therapist_review\b/gi, "čeká na schválení terapeutkami")
      .replace(/nepředstírat klinické závěry[^.\n]*/gi, "klinické závěry dělat až po přímé reakci kluků")
      .replace(/průběh, který nemá transcript/gi, "situaci bez dostatečného přímého materiálu")
      .replace(/briefing_input|source_ref|source_kind|backend_context_inputs|processed_at|ingestion|Pantry B|karel_pantry_b_entries|did_event_ingestion_log/gi, "podklad")
      .trim(),
    {},
  );
  if (!cleaned || FORBIDDEN_VISIBLE_DEBUG_RE.test(cleaned)) return fallback;
  return cleaned;
}

function isUnsafeFallbackBlock(block: LiveProgramBlock) {
  return FORBIDDEN_VISIBLE_DEBUG_RE.test(JSON.stringify(block)) || /Evidence-limited/i.test(String(block.block ?? ""));
}

function hasStructuredProgramFields(block: LiveProgramBlock) {
  return (
    [...PROGRAM_TEXT_FIELDS, ...PROGRAM_LIST_FIELDS].some(([key]) => {
      const value = block[key];
      return Array.isArray(value)
        ? listValue(value).length > 0
        : textValue(value).length > 0;
    }) ||
    typeof block.requires_physical_therapist === "boolean" ||
    typeof block.karel_can_do_alone === "boolean"
  );
}

function yesNo(value: boolean) {
  return value ? "Ano" : "Ne";
}

type LiveDeliberationSource = Pick<
  TeamDeliberation,
  "title" | "reason" | "agenda_outline" | "final_summary"
> & {
  program_draft?: LiveProgramBlock[] | null;
  session_params?: Record<string, unknown> | null;
};

function buildApprovedLivePlanMarkdown(
  source: LiveDeliberationSource | null | undefined,
) {
  if (!source) return "";

  const sessionParams =
    source.session_params && typeof source.session_params === "object"
      ? (source.session_params as Record<string, unknown>)
      : {};

  const ledBy =
    typeof sessionParams.led_by === "string" ? sessionParams.led_by.trim() : "";
  const duration =
    typeof sessionParams.duration_min === "number"
      ? sessionParams.duration_min
      : null;
  const whyToday =
    typeof sessionParams.why_today === "string"
      ? sessionParams.why_today.trim()
      : "";
  const kataInvolvement =
    typeof sessionParams.kata_involvement === "string"
      ? sessionParams.kata_involvement.trim()
      : "";

  const programBlocks: LiveProgramBlock[] =
    Array.isArray(source.program_draft) && source.program_draft.length > 0
      ? source.program_draft
      : Array.isArray(source.agenda_outline)
        ? source.agenda_outline
        : [];

  const normalizedReason = [
    whyToday,
    kataInvolvement ? `(Káťa: ${kataInvolvement})` : "",
  ]
    .filter(Boolean)
    .join(" — ")
    .trim();

  const fallbackReason =
    typeof source.reason === "string" ? source.reason.trim() : "";
  const finalReason = normalizedReason || fallbackReason;

  const lines: string[] = [
    "# Schválený plán z týmové porady",
    source.title ? `**Porada:** ${source.title}` : "",
    ledBy ? `**Vede:** ${ledBy}` : "",
    duration ? `**Délka:** ~${duration} min` : "",
    finalReason ? `**Důvod dnešního sezení:** ${finalReason}` : "",
    "",
  ];

  if (programBlocks.length > 0) {
    lines.push("## Program sezení", "");
    programBlocks.forEach((block, index) => {
      const title = String(block?.block ?? "").trim();
      if (!title) return;
      const minutes =
        typeof block?.minutes === "number" && block.minutes > 0
          ? ` (${block.minutes} min)`
          : "";
      lines.push(`${index + 1}. **${title}**${minutes}`);
      const hasStructured = hasStructuredProgramFields(block);
      if (
        !hasStructured &&
        typeof block?.detail === "string" &&
        block.detail.trim()
      ) {
        lines.push(`   ${block.detail.trim()}`);
      }
      PROGRAM_TEXT_FIELDS.forEach(([key, label]) => {
        const value = textValue(block[key]);
        if (value) lines.push(`   - **${label}:** ${value}`);
      });
      PROGRAM_LIST_FIELDS.forEach(([key, label]) => {
        const values = listValue(block[key]);
        if (values.length > 0)
          lines.push(`   - **${label}:** ${values.join("; ")}`);
      });
      if (typeof block.requires_physical_therapist === "boolean") {
        lines.push(
          `   - **Vyžaduje fyzickou terapeutku:** ${yesNo(block.requires_physical_therapist)}`,
        );
      }
      if (typeof block.karel_can_do_alone === "boolean") {
        lines.push(
          `   - **Karel může sám:** ${yesNo(block.karel_can_do_alone)}`,
        );
      }
      lines.push("");
    });
  }

  if (source.final_summary?.trim()) {
    lines.push("## Závěr porady", source.final_summary.trim());
  }

  return lines.filter(Boolean).join("\n");
}

function areAllQuestionsAnswered(questions: DeliberationQuestion[] = []) {
  return questions.length > 0 && questions.every((q) => !!q.answer?.trim());
}

function QuestionList({
  questions,
  who,
  onAnswer,
  readOnly = false,
}: {
  questions: DeliberationQuestion[];
  who: "hanka" | "kata";
  onAnswer: (idx: number, answer: string) => Promise<void>;
  readOnly?: boolean;
}) {
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<number | null>(null);

  if (!questions || questions.length === 0) {
    return (
      <p className="text-[11px] text-muted-foreground italic">
        Žádná otázka pro {who === "hanka" ? "Haničku" : "Káťu"}.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {questions.map((q, i) => (
        <div
          key={i}
          className="rounded-md border border-border/60 bg-card/40 p-2.5 space-y-1.5"
        >
          <p className="text-[12px] font-medium text-foreground">
            {q.question}
          </p>
          {q.answer ? (
            <div className="rounded bg-muted/40 p-2 text-[11px] text-foreground/90">
              <span className="text-[9px] text-muted-foreground block mb-1">
                {who === "hanka" ? "Hanička" : "Káťa"} odpověděla:
              </span>
              {q.answer}
            </div>
          ) : readOnly ? (
            <p className="text-[10px] text-muted-foreground italic">
              Bez odpovědi.
            </p>
          ) : (
            <div className="space-y-1.5">
              <Textarea
                value={drafts[i] ?? ""}
                onChange={(e) =>
                  setDrafts((d) => ({ ...d, [i]: e.target.value }))
                }
                placeholder={`Odpověď ${who === "hanka" ? "Haničky" : "Káti"}...`}
                className="min-h-[56px] text-[11px]"
              />
              <Button
                size="sm"
                className="h-7 text-[11px]"
                disabled={!drafts[i]?.trim() || busy === i}
                onClick={async () => {
                  setBusy(i);
                  try {
                    await onAnswer(i, drafts[i].trim());
                    setDrafts((d) => ({ ...d, [i]: "" }));
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                {busy === i ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Send className="w-3 h-3" />
                )}
                <span className="ml-1">Odeslat</span>
              </Button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * THERAPIST-LED TRUTH PASS (2026-04-22):
 * Živý program_draft panel. Karel ho přepisuje po každém vstupu terapeutky
 * (přes karel-team-deliberation-iterate). Tady se jen renderuje + ukáže
 * Karlův poslední komentář "co konkrétně změnil".
 */
function LiveProgramDraftPanel({
  d,
  iterating,
  lastIterateComment,
}: {
  d: TeamDeliberation;
  iterating: boolean;
  lastIterateComment: string | null;
}) {
  const draft = ((d as any).program_draft as AgendaBlock[] | null) ?? [];
  const fallback = (d.agenda_outline ?? []) as AgendaBlock[];
  const blocks = draft.length > 0 ? draft : fallback;
  const usingDraft = draft.length > 0;
  const sp = d.session_params && typeof d.session_params === "object" ? d.session_params as Record<string, unknown> : {};
  const isPlayroom = isPlayroomDeliberation(d);
  const isExternalReplan = hasActiveExternalCurrentEventReplan(d);
  const isPlayroomAwaitingApproval =
    isPlayroom && (d.status !== "approved" || !d.hanka_signed_at || !d.kata_signed_at);
  const liveProgramTitle = getLiveProgramTitle(d);
  const unsafeExecutable = d.deliberation_type === "session_plan" && !isPlayroom && (blocks.length < 4 || blocks.some((b) => isUnsafeFallbackBlock(b as LiveProgramBlock)));

  if (blocks.length === 0 || unsafeExecutable) {
    return (
      <section className="rounded-lg border border-dashed border-border/60 bg-card/30 p-3">
        <h4 className="text-[11px] font-semibold text-foreground mb-1.5 flex items-center gap-1.5">
          <Sparkles className="w-3.5 h-3.5 text-primary" />
          {liveProgramTitle} není připravený
        </h4>
        <p className="text-[10.5px] text-muted-foreground italic">
          Karel zatím nemá dost podkladů pro vykonatelné terapeutické Sezení.
          Potřebuje od Haničky nebo Káti upřesnit aktuální stav části, bezpečnost
          a dostupnost; potom sestaví nový návrh bod po bodu.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-primary/25 bg-primary/5 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-[11px] font-semibold text-primary flex items-center gap-1.5">
          <Sparkles className="w-3.5 h-3.5" />
          {liveProgramTitle} {usingDraft ? "" : "(první návrh)"}
        </h4>
        {iterating && (
          <span className="text-[10px] text-primary/70 italic flex items-center gap-1">
            <Loader2 className="w-3 h-3 animate-spin" />
            Karel přepisuje program…
          </span>
        )}
      </div>
      {isPlayroomAwaitingApproval && (
        <p className="text-[10.5px] text-foreground/80 rounded-md border border-primary/15 bg-card/45 px-2 py-1.5">
          Před spuštěním Herny zůstává povinný jemný check: tělo, emoce a bezpečí kluků; Karel vede až po schválení terapeutkami.
        </p>
      )}
      <ol className="space-y-2">
        {blocks.map((b, i) => {
          const block = b as LiveProgramBlock;
          const hasStructured = hasStructuredProgramFields(block);
          return (
            <li
              key={i}
              className="text-[11px] rounded-md border border-primary/15 bg-card/45 p-2.5 space-y-1.5"
            >
              <div className="flex gap-2">
                <span className="font-semibold text-primary shrink-0">
                  {i + 1}.
                  {typeof block.minutes === "number" && block.minutes > 0
                    ? ` ${block.minutes}′`
                    : ""}
                </span>
                <span className="font-medium text-foreground">
                  {cleanVisiblePlanText(block.block, `Krok ${i + 1}`)}
                </span>
              </div>
              {!hasStructured && block.detail && (
                <p className="text-foreground/75">{cleanVisiblePlanText(block.detail)}</p>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1">
                {PROGRAM_TEXT_FIELDS.map(([key, label]) => {
                  const value = cleanVisiblePlanText(textValue(block[key]));
                  if (!value) return null;
                  return (
                    <p key={String(key)} className="text-foreground/85">
                      <span className="font-semibold text-foreground">
                        {label}:{" "}
                      </span>
                      {value}
                    </p>
                  );
                })}
                {PROGRAM_LIST_FIELDS.map(([key, label]) => {
                  const values = listValue(block[key]).map((value) => cleanVisiblePlanText(value)).filter(Boolean);
                  if (values.length === 0) return null;
                  return (
                    <p key={String(key)} className="text-foreground/85">
                      <span className="font-semibold text-foreground">
                        {label}:{" "}
                      </span>
                      {values.join("; ")}
                    </p>
                  );
                })}
              </div>
              {(typeof block.requires_physical_therapist === "boolean" ||
                typeof block.karel_can_do_alone === "boolean") && (
                <div className="flex flex-wrap gap-1.5 pt-0.5">
                  {typeof block.requires_physical_therapist === "boolean" && (
                    <Badge variant="outline" className="text-[10px] h-5">
                      {isPlayroom && (isExternalReplan || isPlayroomAwaitingApproval)
                        ? "Vyžaduje schválení terapeutkami: Ano"
                        : `Vyžaduje terapeutku: ${yesNo(isPlayroom ? Boolean(block.requires_physical_therapist) : true)}`}
                    </Badge>
                  )}
                  {typeof block.karel_can_do_alone === "boolean" && (
                    <Badge variant="outline" className="text-[10px] h-5">
                      {isPlayroom && (isExternalReplan || isPlayroomAwaitingApproval)
                        ? "Karel vede až po schválení"
                        : `Karel asistuje: ${isPlayroom ? "po schválení" : "Ano"}`}
                    </Badge>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {lastIterateComment && (
        <div className="rounded-md border border-primary/20 bg-card/60 p-2 text-[10.5px] text-foreground/85 italic">
          <span className="text-primary not-italic font-semibold mr-1">
            Karel:
          </span>
          {lastIterateComment}
        </div>
      )}
    </section>
  );
}

function ClinicalContractPanel({ d }: { d: TeamDeliberation }) {
  const sp =
    d.session_params && typeof d.session_params === "object"
      ? d.session_params
      : {};
  const isPlayroom = isPlayroomDeliberation(d);
  const entries = [
    ["Fáze", sp.treatment_phase],
    ["Připravenost", sp.readiness_today],
    ["Role", isPlayroom ? "Herna: Karel vede až po schválení terapeutkami" : "Sezení: terapeutka vede, Karel asistuje"],
    ["První otázka", sp.first_question],
    ["Změna plánu", getPlanChangeLabel(d)],
  ].filter(
    ([, value]) => typeof value === "string" && value.trim().length > 0,
  ) as Array<[string, string]>;
  const stopRules = Array.isArray(sp.stop_rules)
    ? sp.stop_rules.map(String).filter(Boolean).slice(0, 4)
    : [];
  if (entries.length === 0 && stopRules.length === 0) return null;
  return (
    <section className="rounded-lg border border-border/60 bg-card/40 p-3 space-y-2">
      <h4 className="text-[11px] font-semibold text-foreground">
        Klinický kontrakt
      </h4>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
        {entries.map(([label, value]) => (
          <div key={label} className="text-[10.5px]">
            <span className="text-muted-foreground">{label}: </span>
            <span className="text-foreground/90">{cleanVisiblePlanText(value)}</span>
          </div>
        ))}
      </div>
      {stopRules.length > 0 && (
        <ul className="list-disc pl-4 text-[10.5px] text-foreground/85 space-y-0.5">
          {stopRules.map((rule, idx) => (
            <li key={idx}>{cleanVisiblePlanText(rule)}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * @deprecated SESSION-PLAN cesta je nahrazená iterativní logikou
 * (`karel-team-deliberation-iterate`). Tento blok zůstává jen pro typ
 * `crisis`, kde je explicitní syntéza pořád potřebná před uzavřením.
 */

function KarelSynthesisBlock({
  d,
  synthesizing,
  onSynthesize,
  readOnly = false,
}: {
  d: TeamDeliberation;
  synthesizing: boolean;
  onSynthesize: () => void;
  readOnly?: boolean;
}) {
  const isCrisis = d.deliberation_type === "crisis";
  const synth = d.karel_synthesis as KarelSynthesis | null;
  const crisisAnswersReady =
    areAllQuestionsAnswered(d.questions_for_hanka ?? []) &&
    areAllQuestionsAnswered(d.questions_for_kata ?? []);

  const hasInput =
    (d.questions_for_hanka ?? []).some((q) => q.answer?.trim()) ||
    (d.questions_for_kata ?? []).some((q) => q.answer?.trim()) ||
    (d.discussion_log ?? []).length > 0;
  const canSynthesize = isCrisis ? crisisAnswersReady : hasInput;

  if (!synth) {
    if (!isCrisis && !hasInput) return null;
    if (readOnly) return null;
    return (
      <section
        className={`rounded-lg border p-3 space-y-2 ${
          isCrisis
            ? "border-amber-500/40 bg-amber-500/5"
            : "border-border/60 bg-card/40"
        }`}
      >
        <div className="flex items-start gap-2">
          {isCrisis ? (
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
          ) : (
            <Brain className="w-4 h-4 text-primary shrink-0 mt-0.5" />
          )}
          <div className="flex-1">
            <h4 className="text-[11px] font-semibold text-foreground">
              {isCrisis
                ? "Karlova syntéza je povinná před podpisem"
                : "Karlova syntéza"}
            </h4>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              {isCrisis
                ? "Karel musí nejdřív vyhodnotit kompletní odpovědi Haničky a Káti (krize trvá / polevuje / lze uzavřít) a teprve potom může podepsat."
                : "Karel může vyhodnotit odpovědi terapeutek a navrhnout další krok."}
            </p>
          </div>
        </div>
        <Button
          size="sm"
          className="h-7 text-[11px] w-full"
          disabled={!canSynthesize || synthesizing}
          onClick={onSynthesize}
        >
          {synthesizing ? (
            <Loader2 className="w-3 h-3 mr-1 animate-spin" />
          ) : (
            <Brain className="w-3 h-3 mr-1" />
          )}
          {canSynthesize
            ? "Spustit Karlovu syntézu"
            : isCrisis
              ? "Čeká na kompletní odpovědi terapeutek"
              : "Čeká na odpovědi terapeutek"}
        </Button>
      </section>
    );
  }

  const verdictLabel: Record<string, { label: string; tone: string }> = {
    crisis_persists: {
      label: "🔴 Krize trvá",
      tone: "border-destructive/40 bg-destructive/5 text-destructive",
    },
    crisis_easing: {
      label: "🟡 Krize polevuje",
      tone: "border-amber-500/40 bg-amber-500/5 text-amber-700",
    },
    crisis_resolvable: {
      label: "🟢 Krizi lze uzavřít",
      tone: "border-emerald-500/40 bg-emerald-500/5 text-emerald-700",
    },
    non_crisis: {
      label: "Bez krizového stavu",
      tone: "border-border/60 bg-card/40 text-foreground",
    },
  };
  const v = verdictLabel[synth.verdict] ?? verdictLabel.crisis_persists;

  return (
    <section className={`rounded-lg border p-3 space-y-2 ${v.tone}`}>
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-[11px] font-semibold flex items-center gap-1.5">
          <Brain className="w-3.5 h-3.5" />
          Karlova syntéza — {v.label}
        </h4>
        {!readOnly && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[10px]"
            disabled={synthesizing}
            onClick={onSynthesize}
          >
            {synthesizing ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              "Přesyntetizovat"
            )}
          </Button>
        )}
      </div>
      <p className="text-[11px] text-foreground/90">
        <strong>Další krok:</strong> {synth.next_step}
      </p>
      {synth.needs_karel_interview && (
        <p className="text-[11px] text-foreground/90">
          <strong>
            Karel si přizve {(d.subject_parts ?? [])[0] || "část"} k vlastnímu
            rozhovoru.
          </strong>
        </p>
      )}
      {synth.recommended_session_focus && (
        <p className="text-[11px] text-foreground/90">
          <strong>Zaměření sezení:</strong> {synth.recommended_session_focus}
        </p>
      )}
      {synth.key_insights.length > 0 && (
        <div className="text-[11px]">
          <strong className="block mb-0.5">Klíčové vhledy:</strong>
          <ul className="list-disc pl-4 space-y-0.5 text-foreground/85">
            {synth.key_insights.map((k, i) => (
              <li key={i}>{k}</li>
            ))}
          </ul>
        </div>
      )}
      {synth.risk_signals.length > 0 && (
        <div className="text-[11px]">
          <strong className="block mb-0.5">Rizikové signály:</strong>
          <ul className="list-disc pl-4 space-y-0.5 text-foreground/85">
            {synth.risk_signals.map((k, i) => (
              <li key={i}>{k}</li>
            ))}
          </ul>
        </div>
      )}
      {synth.protective_signals.length > 0 && (
        <div className="text-[11px]">
          <strong className="block mb-0.5">Ochranné signály:</strong>
          <ul className="list-disc pl-4 space-y-0.5 text-foreground/85">
            {synth.protective_signals.map((k, i) => (
              <li key={i}>{k}</li>
            ))}
          </ul>
        </div>
      )}
      {d.karel_synthesized_at && (
        <p className="text-[9px] text-muted-foreground italic">
          Syntéza: {new Date(d.karel_synthesized_at).toLocaleString("cs-CZ")}
        </p>
      )}
    </section>
  );
}

const DeliberationRoom = ({ deliberationId, onClose, onChanged }: Props) => {
  const {
    sign,
    synthesize,
    answerQuestion,
    postMessage,
    iterateProgram,
    reload,
    items,
  } = useTeamDeliberations(0);
  const [d, setD] = useState<TeamDeliberation | null>(null);
  const [loading, setLoading] = useState(true);
  const [signing, setSigning] = useState<string | null>(null);
  const [synthesizing, setSynthesizing] = useState(false);
  const [chatDraft, setChatDraft] = useState("");
  const [chatAuthor, setChatAuthor] = useState<"hanka" | "kata">("hanka");
  const [bridgedPlanId, setBridgedPlanId] = useState<string | null>(null);
  // THERAPIST-LED TRUTH PASS — iterativní program
  const [iterating, setIterating] = useState(false);
  const [lastIterateComment, setLastIterateComment] = useState<string | null>(
    null,
  );
  const lastIterateInputRef = useRef<string>("");
  const [startingLive, setStartingLive] = useState(false);
  const [livePlan, setLivePlan] = useState<LiveSessionPlanRow | null>(null);
  const [linkedPlan, setLinkedPlan] = useState<LiveSessionPlanRow | null>(null);
  const [lastStartErrorCode, setLastStartErrorCode] = useState<string | null>(null);

  useEffect(() => {
    const found = items.find((x) => x.id === deliberationId) ?? null;
    if (found) {
      setD(found);
      setLoading(false);
      return;
    }
    if (!deliberationId) return;
    let alive = true;
    (async () => {
      const { data, error } = await (supabase as any)
        .from("did_team_deliberations")
        .select("*")
        .eq("id", deliberationId)
        .maybeSingle();
      if (!alive) return;
      if (!error && data) setD(data as TeamDeliberation);
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [deliberationId, items]);

  // realtime row refresh
  useEffect(() => {
    if (!deliberationId) return;
    const ch = (supabase as any)
      .channel(`delib_${deliberationId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "did_team_deliberations",
          filter: `id=eq.${deliberationId}`,
        },
        (payload: any) => setD(payload.new as TeamDeliberation),
      )
      .subscribe();
    return () => {
      (supabase as any).removeChannel(ch);
    };
  }, [deliberationId]);

  useEffect(() => {
    const planId = bridgedPlanId ?? d?.linked_live_session_id;
    if (!planId) {
      setLinkedPlan(null);
      return;
    }
    let alive = true;
    (async () => {
      const { data } = await (supabase as any)
        .from("did_daily_session_plans")
        .select(
          "id, selected_part, session_lead, therapist, plan_markdown, status, lifecycle_status, program_status, approved_at, urgency_breakdown",
        )
        .eq("id", planId)
        .maybeSingle();
      if (alive) setLinkedPlan((data as LiveSessionPlanRow | null) ?? null);
    })();
    return () => {
      alive = false;
    };
  }, [bridgedPlanId, d?.linked_live_session_id, startingLive]);

  if (!deliberationId) return null;

  /**
   * THERAPIST-LED TRUTH PASS — fire-and-forget volání iterace programu.
   * Spouští se po každé nové odpovědi nebo diskusní zprávě terapeutky
   * (pro typ `session_plan`). Krize zůstává ve starém synthesis flow.
   */
  const triggerIterate = async (input: {
    author: "hanka" | "kata";
    text: string;
    question?: string;
  }) => {
    if (!d || d.deliberation_type !== "session_plan") return;
    if (
      d.status === "approved" ||
      d.status === "closed" ||
      d.status === "archived"
    )
      return;
    const dedupe = `${input.author}::${input.text.trim()}`;
    if (dedupe === lastIterateInputRef.current) return;
    lastIterateInputRef.current = dedupe;
    setIterating(true);
    try {
      const res = await iterateProgram(d.id, input);
      if ((res as any)?.replan_completed) {
        toast.warning(
          "Externí aktuální událost změnila plán. Starý návrh čeká na přepracování — podpisy jsou pozastavené.",
        );
        setLastIterateComment(res.karel_inline_comment ?? null);
        onChanged?.();
      } else if (res?.no_op) {
        // Karel nic nezměnil — neukazujeme prázdný komentář.
      } else if (res?.karel_inline_comment) {
        setLastIterateComment(res.karel_inline_comment);
      }
    } catch (e: any) {
      console.warn(
        "[DeliberationRoom] iterateProgram failed:",
        e?.message ?? e,
      );
      // Tichá chyba — uživatelská akce (odpověď) už proběhla, iterace je doplňková.
    } finally {
      setIterating(false);
    }
  };

  const handleSign = async (who: "hanka" | "kata") => {
    if (!d) return;
    setSigning(who);
    try {
      const res = await sign(d.id, who);
      setD((res as any)?.deliberation ?? d);
      onChanged?.();
      if (res?.bridged_plan_id) {
        setBridgedPlanId(res.bridged_plan_id);
        toast.success(
          isPlayroomDeliberation(d as any)
            ? "Porada schválena. Herna je připravená ke spuštění."
            : "Porada schválena. Plán propsán do dnešního live sezení.",
        );
      } else if (res?.deliberation?.status === "approved") {
        toast.success("Porada schválena.");
      } else {
        toast.success(
          `Stvrzeno podpisem: ${who === "hanka" ? "Hanička" : "Káťa"}.`,
        );
      }
    } catch (e: any) {
      toast.error(e?.message ?? "Podpis selhal.");
    } finally {
      setSigning(null);
    }
  };

  const handleSynthesize = async () => {
    if (!d) return;
    setSynthesizing(true);
    try {
      const res = await synthesize(d.id);
      setD((res as any)?.deliberation ?? d);
      onChanged?.();
      if (res?.synthesis) {
        toast.success("Karlova syntéza hotová. Můžeš podepsat.");
      }
    } catch (e: any) {
      toast.error(
        e?.message ?? "Syntéza selhala. Mají Hanička a Káťa už odpověděno?",
      );
    } finally {
      setSynthesizing(false);
    }
  };

  const handleAnswer = async (
    who: "hanka" | "kata",
    idx: number,
    answer: string,
  ) => {
    if (!d) return;
    try {
      await answerQuestion(d.id, who, idx, answer);
      // Iterativní přepis programu po odpovědi terapeutky.
      const fieldName =
        who === "hanka" ? "questions_for_hanka" : "questions_for_kata";
      const question = ((d as any)[fieldName] ?? [])[idx]?.question;
      void triggerIterate({ author: who, text: answer, question });
    } catch (e: any) {
      toast.error(e?.message ?? "Uložení odpovědi selhalo.");
    }
  };

  const handlePostMessage = async () => {
    if (!d || !chatDraft.trim()) return;
    const text = chatDraft.trim();
    const author = chatAuthor;
    try {
      await postMessage(d.id, author, text);
      setChatDraft("");
      // Iterativní přepis programu po novém podnětu z diskuse.
      void triggerIterate({ author, text });
    } catch (e: any) {
      toast.error(e?.message ?? "Odeslání selhalo.");
    }
  };

  /** Backend-authoritative start: UI nesmí zapisovat in_progress přímo. */
  const goToLiveSession = async () => {
    const planId = bridgedPlanId ?? d?.linked_live_session_id;
    if (!d || !planId || startingLive) return;
    const preflightReason = unsignedStartBlockReason(d, linkedPlan);
    if (preflightReason) {
      toast.info(preflightReason);
      return;
    }
    setStartingLive(true);
    setLastStartErrorCode(null);
    try {
      const headers = await getAuthHeaders();
      const startResponse = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-daily-plan-sync-start`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ deliberation_id: d.id }),
        },
      );
      const startPayload = await startResponse.json().catch(() => ({}));
      if (!startResponse.ok || startPayload?.ok === false) {
        const errorCode = String(startPayload?.error_code ?? "sync_failed");
        setLastStartErrorCode(errorCode);
        toast.error(
          startPayload?.message ||
            "Porada je podepsaná, ale plán stále není bezpečně připravený ke spuštění.",
        );
        return;
      }

      const liveSource = d as any as LiveDeliberationSource | null;
      const isPlayroom = isPlayroomDeliberation(liveSource);

      const { data: planRow, error: fetchErr } = await (supabase as any)
        .from("did_daily_session_plans")
        .select(
          "id, selected_part, session_lead, therapist, plan_markdown, status, lifecycle_status, program_status, approved_at, urgency_breakdown",
        )
        .eq("id", planId)
        .single();

      if (fetchErr || !planRow) {
        console.error(
          "[DeliberationRoom] startLiveSession fetch failed:",
          fetchErr,
        );
        toast.error("Nepodařilo se načíst aktuální schválený plán.");
        return;
      }

      const planBlockReason = unsignedStartBlockReason(
        d,
        planRow as LiveSessionPlanRow,
      );
      if (planBlockReason) {
        toast.info(planBlockReason);
        return;
      }
      setLinkedPlan(planRow as LiveSessionPlanRow);

      if (isPlayroom) {
        const response = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-part-session-prepare`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              part_name: planRow.selected_part,
              plan_id: planRow.id,
            }),
          },
        );
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.thread_id)
          throw new Error(
            payload.message || payload.error || "Herna nejde otevřít.",
          );
        try {
          sessionStorage.setItem("karel_playroom_plan_id", planRow.id);
          sessionStorage.setItem("karel_playroom_thread_id", payload.thread_id);
        } catch {
          /* ignore */
        }
        onClose();
        window.location.assign(`/chat?workspace_thread=${payload.thread_id}`);
        toast.success("Herna zahájena.");
        return;
      }

      setLivePlan({
        ...(planRow as LiveSessionPlanRow),
      });
      toast.success("Sezení zahájeno.");
    } finally {
      setStartingLive(false);
    }
  };

  const sp = d ? signoffProgress(d) : { signed: 0, total: 2, missing: [] };
  const isReadOnly = d?.status === "approved";
  const sessionParams =
    d?.session_params && typeof d.session_params === "object"
      ? d.session_params
      : {};
  const hybridContract =
    (sessionParams as any).hybrid_contract &&
    typeof (sessionParams as any).hybrid_contract === "object"
      ? (sessionParams as any).hybrid_contract
      : {};
  const readinessRedBlocked =
    d?.deliberation_type === "session_plan" &&
    String(
      (sessionParams as any).readiness_today ??
        hybridContract.readiness_today ??
        "",
    ).toLowerCase() === "red" &&
    !["stabilization_checkin", "deferred", "human_review_required"].includes(
      String(
        (sessionParams as any).session_mode ??
          hybridContract.session_mode ??
          hybridContract.therapist_led_vs_karel_only ??
          "standard",
      ).toLowerCase(),
    );
  // PER-THERAPIST LOCK — pokud Hanka podepsala, její sekce read-only,
  // ale Káťa může pořád odpovídat / přidávat podněty (a obráceně).
  const hankaLocked = !!d?.hanka_signed_at;
  const kataLocked = !!d?.kata_signed_at;
  const isPlayroomPlan = isPlayroomDeliberation(d as any);

  // P1 visibleClinicalTextGuard — post-mount DOM audit safety net.
  // Surface tag flips to "herna-modal" for playroom deliberations so that
  // the herna-only forbidden labels ("Živý program sezení",
  // "Vyžaduje terapeutku: Ne" when unapproved) are enforced.
  const auditRootRef = useRef<HTMLDivElement>(null);
  const auditSurface: "herna-modal" | "team-deliberation" = isPlayroomPlan
    ? "herna-modal"
    : "team-deliberation";
  const hernaUnapproved =
    isPlayroomPlan && d?.status !== "closed" && d?.status !== "archived";
  useVisibleClinicalTextAudit(auditSurface, auditRootRef, {
    failInTest: false, // dialog mounts in real app — never block tests with stray legacy text
    logInProduction: true,
    status: d?.status ?? undefined,
    hernaUnapproved,
  });

  return (
    <Dialog open={!!deliberationId} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl w-[calc(100vw-2rem)] h-[90vh] sm:h-auto sm:max-h-[90vh] p-0 gap-0 overflow-hidden !grid-cols-1 grid-rows-[auto_minmax(0,1fr)_auto] sm:!flex sm:!flex-col">
        <div ref={auditRootRef} data-visible-clinical-panel={auditSurface} className="contents">
        {livePlan ? (
          <div className="relative h-full min-h-0 overflow-hidden">
            <DidLiveSessionPanel
              partName={livePlan.selected_part}
              therapistName={
                livePlan.session_lead === "kata" ? "Káťa" : "Hanka"
              }
              contextBrief={livePlan.plan_markdown}
              planId={livePlan.id}
              onBack={() => setLivePlan(null)}
              onEnd={() => {
                void reload();
                setLivePlan(null);
                onClose();
              }}
            />
          </div>
        ) : (
          <>
            <DialogHeader className="px-6 pt-6 pb-3 shrink-0 border-b border-border/40">
              <DialogTitle className="flex items-center gap-2 text-base">
                <Users className="w-4 h-4 text-primary" />
                {loading ? "Načítám…" : (d?.title ?? "Porada")}
              </DialogTitle>
              {d && (
                <DialogDescription className="text-[11px] flex flex-wrap items-center gap-1.5">
                  <Badge className="text-[9px] h-4 px-1.5 bg-muted text-muted-foreground border-border">
                    {TYPE_LABEL[d.deliberation_type] ?? d.deliberation_type}
                  </Badge>
                  {d.subject_parts?.map((p) => (
                    <Badge
                      key={p}
                      className="text-[9px] h-4 px-1.5 bg-primary/10 text-primary border-primary/20"
                    >
                      {p}
                    </Badge>
                  ))}
                  <span className="text-muted-foreground ml-1">
                    podpisy {sp.signed}/{sp.total}
                  </span>
                  {/* THERAPIST-LED 2-PODPIS — dynamický badge "Schválily: …" */}
                  {(hankaLocked || kataLocked) && (
                    <span className="ml-2 inline-flex items-center gap-1 text-emerald-700">
                      <CheckCircle2 className="w-3 h-3" />
                      <span className="text-[10px] font-medium">
                        Schválily:{" "}
                        {[
                          hankaLocked ? "Hanička" : null,
                          kataLocked ? "Káťa" : null,
                        ]
                          .filter(Boolean)
                          .join(", ")}
                      </span>
                    </span>
                  )}
                </DialogDescription>
              )}
            </DialogHeader>

            {loading || !d ? (
              <div className="flex justify-center py-8 px-6">
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="min-h-0 overflow-y-auto overscroll-contain px-6 py-4">
                <div className="space-y-4">
                  {isReadOnly && (
                    <section className="rounded-lg border border-primary/30 bg-primary/5 p-3 flex items-start gap-2">
                      <CheckCircle2 className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                      <div className="flex-1">
                        <h4 className="text-[11px] font-semibold text-foreground">
                          Porada je schválená — náhled jen pro čtení
                        </h4>
                        <p className="text-[10px] text-muted-foreground mt-0.5">
                          {d.deliberation_type === "session_plan"
                            ? "Odpovědi, podpisy a finální program jsou uzavřené. Nelze měnit, jen prohlížet."
                            : "Odpovědi, podpisy i Karlova syntéza jsou uzavřené. Nelze měnit, jen prohlížet."}
                          Pro nové rozhodnutí počkej na další briefing.
                        </p>
                      </div>
                    </section>
                  )}
                  {/* Karlův úvod */}
                  <section className="rounded-lg border border-border/60 bg-card/40 p-3">
                    <h4 className="text-[11px] font-semibold text-muted-foreground mb-1.5">
                      Karel svolal poradu
                    </h4>
                    <RichMarkdown compact>
                      {sanitizeHernaVisibleText(d.initial_karel_brief) || "(žádný brief)"}
                    </RichMarkdown>
                  </section>

                  {/* Karlův návrh — pro session_plan je to lidský pracovní návrh z briefingu */}
                  <section className="rounded-lg border border-primary/20 bg-primary/5 p-3">
                    <h4 className="text-[11px] font-semibold text-primary mb-1.5">
                      {d.deliberation_type === "session_plan"
                        ? "Lidský návrh k poradě"
                        : "Karlův pracovní návrh"}
                    </h4>
                    {d.deliberation_type === "session_plan" ? (
                      <p className="text-[12px] leading-relaxed text-foreground/85 whitespace-pre-line">
                        {cleanVisiblePlanText(d.reason || d.title, "Program je pracovní a čeká na doplnění terapeutek. Raw stav ani auditní metadata zde nezobrazuji.")}
                      </p>
                    ) : (
                      <RichMarkdown compact>
                        {cleanVisiblePlanText(d.karel_proposed_plan, "(zatím bez návrhu)")}
                      </RichMarkdown>
                    )}
                  </section>

                  {/* THERAPIST-LED TRUTH PASS — Živý program (program_draft).
                  Pro session_plan nahrazuje statickou agendu + Karlovu syntézu.
                  Karel sem dopisuje po každé odpovědi/podnětu terapeutek. */}
                  {d.deliberation_type === "session_plan" && (
                    <LiveProgramDraftPanel
                      d={d}
                      iterating={iterating}
                      lastIterateComment={lastIterateComment}
                    />
                  )}

                  {d.deliberation_type === "session_plan" && (
                    <ClinicalContractPanel d={d} />
                  )}

                  {/* SLICE 3 — Statická Agenda / minutáž — POUZE pro non-session_plan
                  typy (krize, supervize, …), kde iterativní program_draft nemá smysl. */}
                  {d.deliberation_type !== "session_plan" &&
                    Array.isArray((d as any).agenda_outline) &&
                    (d as any).agenda_outline.length > 0 && (
                      <section className="rounded-lg border border-border/60 bg-card/40 p-3">
                        <h4 className="text-[11px] font-semibold text-foreground mb-2">
                          Osnova / minutáž
                        </h4>
                        <ol className="space-y-1.5">
                          {(
                            (d as any).agenda_outline as Array<{
                              block: string;
                              minutes?: number | null;
                              detail?: string | null;
                            }>
                          ).map((b, i) => (
                            <li key={i} className="text-[11px] flex gap-2">
                              <span className="font-semibold text-primary shrink-0">
                                {i + 1}.
                                {typeof b.minutes === "number" && b.minutes > 0
                                  ? ` ${b.minutes}′`
                                  : ""}
                              </span>
                              <span className="flex-1">
                                <span className="font-medium text-foreground">
                                  {b.block}
                                </span>
                                {b.detail && (
                                  <span className="block text-foreground/75 mt-0.5">
                                    {b.detail}
                                  </span>
                                )}
                              </span>
                            </li>
                          ))}
                        </ol>
                      </section>
                    )}

                  {/* Otázky pro Haničku — read-only po jejím podpisu (Káťa stále edituje). */}
                  <section
                    className={`rounded-lg border p-3 ${hankaLocked ? "border-emerald-500/30 bg-emerald-500/5" : "border-border/60"}`}
                  >
                    <h4 className="text-[11px] font-semibold mb-2 text-foreground flex items-center gap-1.5">
                      Pro Haničku
                      {hankaLocked && (
                        <span className="text-[9px] text-emerald-700 inline-flex items-center gap-1">
                          <CheckCircle2 className="w-3 h-3" /> uzavřeno podpisem
                        </span>
                      )}
                    </h4>
                    <QuestionList
                      questions={d.questions_for_hanka ?? []}
                      who="hanka"
                      onAnswer={(idx, ans) => handleAnswer("hanka", idx, ans)}
                      readOnly={isReadOnly || hankaLocked}
                    />
                  </section>

                  {/* Otázky pro Káťu — read-only po jejím podpisu (Hanka stále edituje). */}
                  <section
                    className={`rounded-lg border p-3 ${kataLocked ? "border-emerald-500/30 bg-emerald-500/5" : "border-border/60"}`}
                  >
                    <h4 className="text-[11px] font-semibold mb-2 text-foreground flex items-center gap-1.5">
                      Pro Káťu
                      {kataLocked && (
                        <span className="text-[9px] text-emerald-700 inline-flex items-center gap-1">
                          <CheckCircle2 className="w-3 h-3" /> uzavřeno podpisem
                        </span>
                      )}
                    </h4>
                    <QuestionList
                      questions={d.questions_for_kata ?? []}
                      who="kata"
                      onAnswer={(idx, ans) => handleAnswer("kata", idx, ans)}
                      readOnly={isReadOnly || kataLocked}
                    />
                  </section>

                  {/* Volný diskusní log */}
                  {(d.discussion_log?.length ?? 0) > 0 && (
                    <section className="rounded-lg border border-border/60 p-3 space-y-1.5">
                      <h4 className="text-[11px] font-semibold mb-1 text-foreground">
                        Diskuse
                      </h4>
                      {d.discussion_log.map((m, i) => (
                        <div key={i} className="text-[11px]">
                          <span className="font-semibold mr-1">
                            {m.author === "karel"
                              ? "Karel"
                              : m.author === "hanka"
                                ? "Hanička"
                                : "Káťa"}
                            :
                          </span>
                          <span className="text-foreground/90 whitespace-pre-line">
                            {m.content}
                          </span>
                        </div>
                      ))}
                    </section>
                  )}

                  {/* KARLOVA SYNTÉZA — povinná POUZE pro `crisis` před uzavřením.
                  Pro `session_plan` ji nahrazuje iterativní program_draft. */}
                  {d.deliberation_type !== "session_plan" && (
                    <KarelSynthesisBlock
                      d={d}
                      synthesizing={synthesizing}
                      onSynthesize={handleSynthesize}
                      readOnly={isReadOnly}
                    />
                  )}

                  {!isReadOnly && !(hankaLocked && kataLocked) && (
                    <section className="rounded-lg border border-dashed border-border/60 p-3 space-y-2">
                      <div className="flex items-center gap-1.5">
                        {(["hanka", "kata"] as const)
                          .filter((who) =>
                            who === "hanka" ? !hankaLocked : !kataLocked,
                          )
                          .map((who) => (
                            <Button
                              key={who}
                              size="sm"
                              variant={
                                chatAuthor === who ? "default" : "outline"
                              }
                              className="h-6 px-2 text-[10px]"
                              onClick={() => setChatAuthor(who)}
                            >
                              {who === "hanka" ? "Hanička" : "Káťa"}
                            </Button>
                          ))}
                      </div>
                      <Textarea
                        value={chatDraft}
                        onChange={(e) => setChatDraft(e.target.value)}
                        placeholder="Příspěvek do diskuse…"
                        className="min-h-[50px] text-[11px]"
                      />
                      <Button
                        size="sm"
                        className="h-7 text-[11px]"
                        disabled={
                          !chatDraft.trim() ||
                          (chatAuthor === "hanka" ? hankaLocked : kataLocked)
                        }
                        onClick={handlePostMessage}
                      >
                        <Send className="w-3 h-3 mr-1" /> Odeslat
                      </Button>
                    </section>
                  )}
                </div>
              </div>
            )}

            {d && (
              <div className="shrink-0 border-t border-border/60 px-6 py-3 bg-background space-y-2">
                {/* THERAPIST-LED 2-PODPIS TRUTH PASS (2026-04-22):
                Karel není podepisující strana. Schválení = 2 podpisy
                (Hanička + Káťa). Karlův timestamp je audit log v DB triggeru.
                Po podpisu jedné terapeutky její tlačítko zůstane v read-only
                stavu, druhá stále edituje, dokud nepodepíše také. */}
                {(() => {
                  const visibleSigners: Array<"hanka" | "kata"> = [
                    "hanka",
                    "kata",
                  ];
                  return (
                    <div className="flex items-center gap-2">
                      {visibleSigners.map((who) => {
                        const signed =
                          who === "hanka"
                            ? d.hanka_signed_at
                            : d.kata_signed_at;
                        const crisisAnswersReady =
                          areAllQuestionsAnswered(
                            d.questions_for_hanka ?? [],
                          ) &&
                          areAllQuestionsAnswered(d.questions_for_kata ?? []);
                        // Krizová porada vyžaduje fresh syntézu předtím, než
                        // poslední podpis poradu uzavře.
                        const otherSigned =
                          who === "hanka"
                            ? !!d.kata_signed_at
                            : !!d.hanka_signed_at;
                        const crisisGateBlocked =
                          d.deliberation_type === "crisis" &&
                          otherSigned &&
                          (!crisisAnswersReady || !d.karel_synthesis);
                        const disabled =
                          !!signed ||
                          signing === who ||
                          crisisGateBlocked ||
                          readinessRedBlocked ||
                          isReadOnly;
                        const label = who === "hanka" ? "Hanička" : "Káťa";
                        return (
                          <Button
                            key={who}
                            size="sm"
                            variant={signed ? "secondary" : "default"}
                            disabled={disabled}
                            title={
                              crisisGateBlocked
                                ? 'Karel musí (znovu) syntetizovat odpovědi terapeutek — viz tlačítko „Spustit Karlovu syntézu".'
                                : readinessRedBlocked
                                  ? "Readiness red blokuje standardní sezení; zvol stabilizační/deferred/human-review režim."
                                  : undefined
                            }
                            className="h-8 text-[11px] flex-1"
                            onClick={() => handleSign(who)}
                          >
                            {signing === who ? (
                              <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                            ) : signed ? (
                              <CheckCircle2 className="w-3 h-3 mr-1 text-primary" />
                            ) : null}
                            {signed
                              ? `${label} ✓`
                              : `Stvrzuji podpisem souhlas (${label})`}
                          </Button>
                        );
                      })}
                    </div>
                  );
                })()}

                {d.deliberation_type === "session_plan" &&
                  !!d.hanka_signed_at &&
                  !!d.kata_signed_at &&
                  (() => {
                    const statusText = liveStartStatusText({
                      signed: true,
                      starting: startingLive,
                      plan: linkedPlan,
                      lastErrorCode: lastStartErrorCode,
                    });
                    const synced = planApprovalSynced(linkedPlan);
                    return (
                      <section className={`rounded-md border px-3 py-2 flex items-start gap-2 ${synced ? "border-primary/30 bg-primary/5" : "border-border/60 bg-muted/30"}`}>
                        {startingLive ? (
                          <Loader2 className="w-4 h-4 text-primary shrink-0 mt-0.5 animate-spin" />
                        ) : (
                          <CheckCircle2 className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                        )}
                        <div className="flex-1">
                          <p className="text-[11px] font-semibold text-foreground">
                            {statusText}
                          </p>
                          <p className="text-[10px] text-muted-foreground mt-0.5">
                            Start proběhne pouze přes bezpečnou backendovou sync+start kontrolu.
                          </p>
                        </div>
                      </section>
                    );
                  })()}

                {(d.status === "approved" || bridgedPlanId) &&
                  d.deliberation_type === "session_plan" &&
                  (() => {
                    const startBlockReason = unsignedStartBlockReason(d);
                    return (
                      <div className="space-y-2">
                        {startBlockReason && (
                          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[10px] text-amber-800 dark:text-amber-300">
                            {startBlockReason}
                          </div>
                        )}
                        <Button
                          size="sm"
                          className="w-full h-8 text-[11px]"
                          onClick={goToLiveSession}
                          disabled={
                            !!startBlockReason ||
                            (!bridgedPlanId && !d.linked_live_session_id) ||
                            startingLive
                          }
                          title={startBlockReason || undefined}
                        >
                          {startingLive ? (
                            <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                          ) : null}
                          {startingLive ? (
                            "Synchronizuji schválení…"
                          ) : (
                            <>
                              {isPlayroomPlan
                                ? "Spustit hernu"
                                : "Spustit sezení"}{" "}
                              <ArrowRight className="w-3 h-3 ml-1" />
                            </>
                          )}
                        </Button>
                      </div>
                    );
                  })()}
              </div>
            )}
          </>
        )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default DeliberationRoom;

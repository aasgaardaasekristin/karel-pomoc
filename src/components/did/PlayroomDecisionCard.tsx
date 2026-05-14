/**
 * PlayroomDecisionCard
 *
 * Klinický decision surface pro „Plán dnešní herny".
 *
 * Pravidla (viz docs/P33_6 + zadání 2026-05-14):
 *  - ŽÁDNÝ debug text/badge v produkčním view (source_status, grounding tokens,
 *    quality_score, render path, eligible candidates, has_playroom_plan, atd.).
 *    Debug detaily smí být jen za `isKarelDebugMode()`.
 *  - Sekce se zobrazují pouze, pokud pro ně existují data v `playroom_plan`
 *    (preferovaně top-level, fallback `playroom_plan.meta`). Žádné placeholder
 *    věty „Karel zatím nemá k tomu informace".
 *  - Jediná výjimka: „Co víme z minulé herny" — pokud chybí, jedna honest věta.
 *  - Inline otázky před schválením se ukládají do `did_pending_questions`.
 *  - Post-session formulář drží payload v localStorage draftu a po odeslání
 *    založí strukturovaný záznam v `did_pending_questions` (jako follow-up).
 *
 * Karta NEgeneruje žádný text Karlovým hlasem na frontendu — všechen lidský
 * text musí přijít z DB.
 */

import { useCallback, useMemo, useState } from "react";
import { ArrowRight, Sparkles, ChevronDown, ChevronUp, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { isKarelDebugMode } from "@/lib/karelDebugMode";
import { sanitizeKarelVisibleText } from "@/lib/karelBriefingVisibleSanitizer";

type ProposedPlayroom = {
  id?: string;
  part_name: string;
  status?: string;
  why_this_part_today?: string;
  main_theme?: string;
  goals?: string[];
  questions_for_hanka?: string[];
  questions_for_kata?: string[];
  playroom_plan: {
    therapeutic_program?: any[];
    child_safe_version?: string;
    risks_and_stop_signals?: string[];
    meta?: Record<string, any>;
    [k: string]: any;
  };
};

type PlayroomView = {
  title: string;
  part_name: string;
  rationale: string;
  goals: string[];
  blocks: { title: string; aim: string; duration: string }[];
  child_safe_text?: string;
  stop_rules: string[];
};

interface Props {
  playroom: ProposedPlayroom;
  view: PlayroomView;
  contextSummary?: string | null;
  contextLabel?: string;
  lastPlayroomReview?: LastPlayroomReview | null;
  onOpenDeliberation: (p: ProposedPlayroom) => void;
}

type LastPlayroomReview = {
  held?: boolean;
  completion?: "completed" | "partial" | "abandoned" | string;
  karel_summary?: string | null;
  key_finding_about_part?: string | null;
  implications_for_plan?: string | null;
  team_acknowledgement?: string | null;
  practical_report?: string | null;
  detailed_analysis?: string | null;
  recommendations_for_therapists?: string | null;
  recommendations_for_next_session?: string | null;
  recommendations_for_next_playroom?: string | null;
};

/* -------------------- helpers (pure, no Karel voice) -------------------- */

const pickFromPlan = (plan: any, key: string): any => {
  if (!plan) return undefined;
  if (plan[key] !== undefined && plan[key] !== null) return plan[key];
  if (plan.meta && plan.meta[key] !== undefined && plan.meta[key] !== null) return plan.meta[key];
  return undefined;
};

const cleanStr = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const cleanList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => cleanStr(x)).filter(Boolean) : [];

const FORBIDDEN_VISIBLE_PLAYROOM_RE = /\bgrounded\b|source_status|status\s*grounded|čerp[áa]\s+ze\s+skutečn[ýy]ch\s+dat|sestaven[ýy]\s+ze\s+skutečn[ýy]ch\s+dat|grounding\s*tokens?/giu;

const clinicalText = (value: unknown): string => sanitizeKarelVisibleText(value)
  .replace(FORBIDDEN_VISIBLE_PLAYROOM_RE, "")
  .replace(/\s*\(\s*\)\s*/g, " ")
  .replace(/[ \t]{2,}/g, " ")
  .replace(/\s+([.,;:!?])/g, "$1")
  .trim();

const clinicalList = (value: unknown, fallback: string[] = []): string[] => {
  const source = Array.isArray(value) ? value : fallback;
  return source.map((item) => clinicalText(item)).filter(Boolean);
};

const firstText = (...values: unknown[]): string => {
  for (const value of values) {
    const text = clinicalText(value);
    if (text) return text;
  }
  return "";
};

const statusToText = (status?: string): string => {
  const s = (status || "").toLowerCase();
  if (s === "approved" || s === "ready_to_start") return "stav: schváleno";
  if (s === "in_progress") return "stav: v běhu";
  if (s === "completed" || s === "evaluated") return "stav: dokončeno";
  if (s === "in_revision") return "stav: revidováno, čeká na vstupy";
  if (s === "awaiting_therapist_review") return "stav: čeká na vstupy terapeutek";
  if (s === "draft") return "stav: pracovní návrh";
  return "stav: čeká na vstupy";
};

/* -------------------- subcomponents -------------------- */

const SectionHead = ({ children }: { children: React.ReactNode }) => (
  <h4 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground mt-4 mb-1.5">
    {children}
  </h4>
);

const Prose = ({ children }: { children: React.ReactNode }) => (
  <p className="text-[13px] leading-relaxed text-foreground/85 whitespace-pre-line">{children}</p>
);

const BulletList = ({ items }: { items: string[] }) => (
  <ul className="mt-1 space-y-1 text-[13px] leading-relaxed text-foreground/85">
    {items.map((x, i) => (
      <li key={`${i}-${x.slice(0, 16)}`} className="flex gap-2">
        <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-foreground/40" />
        <span>{x}</span>
      </li>
    ))}
  </ul>
);

/* -------------------- pre-approval inline questions -------------------- */

const PreApprovalQuestions = ({
  partName,
  questions,
  planId,
}: {
  partName: string;
  questions: string[];
  planId?: string;
}) => {
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [submitting, setSubmitting] = useState<Record<number, boolean>>({});
  const [submitted, setSubmitted] = useState<Record<number, boolean>>({});

  const submit = async (idx: number, question: string) => {
    const answer = (answers[idx] || "").trim();
    if (!answer) {
      toast.error("Napiš krátkou odpověď.");
      return;
    }
    setSubmitting((s) => ({ ...s, [idx]: true }));
    try {
      const { error } = await (supabase as any).from("did_pending_questions").insert({
        question,
        directed_to: "karel",
        status: "answered",
        answer,
        answered_at: new Date().toISOString(),
        answered_by: "therapist_inline",
        source: "playroom_pre_approval",
        part_name: partName || "system",
        subject_type: "playroom_plan",
        crisis_event_id: null,
        ...(planId ? { related_plan_id: planId } : {}),
      });
      if (error) throw error;
      setSubmitted((s) => ({ ...s, [idx]: true }));
      toast.success("Odpověď uložena.");
    } catch (e: any) {
      console.error("[PreApprovalQuestions] insert failed", e);
      toast.error("Uložení selhalo.");
    } finally {
      setSubmitting((s) => ({ ...s, [idx]: false }));
    }
  };

  return (
    <div className="space-y-3">
      {questions.map((q, idx) => (
        <div key={idx} className="rounded-md border border-border/50 bg-background/35 p-2.5 space-y-1.5">
          <p className="text-[13px] leading-relaxed text-foreground/90">{q}</p>
          {submitted[idx] ? (
            <p className="text-[12px] text-muted-foreground italic">
              Odpověď zaznamenána: „{answers[idx]}"
            </p>
          ) : (
            <>
              <textarea
                value={answers[idx] || ""}
                onChange={(e) => setAnswers((a) => ({ ...a, [idx]: e.target.value }))}
                placeholder="Krátká odpověď, která může změnit plán…"
                rows={2}
                className="w-full text-[13px] rounded-sm border border-border/60 bg-background/70 px-2 py-1 focus:outline-none focus:ring-1 focus:ring-primary/40"
              />
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => submit(idx, q)}
                  disabled={submitting[idx]}
                  className="text-[11px] px-2 py-1 rounded-sm border border-primary/40 text-primary hover:bg-primary/10 disabled:opacity-50"
                >
                  {submitting[idx] ? <Loader2 className="w-3 h-3 animate-spin" /> : "Odeslat odpověď"}
                </button>
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  );
};

/* -------------------- post-session payload form -------------------- */

const POST_FIELDS: { key: string; label: string; rows?: number }[] = [
  { key: "whatHappened", label: "Co proběhlo", rows: 2 },
  { key: "whatDidNotHappen", label: "Co neproběhlo (a mělo)", rows: 2 },
  { key: "confirmedFacts", label: "Potvrzená fakta", rows: 2 },
  { key: "workingDeductions", label: "Pracovní dedukce (hypotézy)", rows: 2 },
  { key: "unknowns", label: "Co zůstává nejasné", rows: 2 },
  { key: "dataValidity", label: "Validita dat (nízká / střední / vyšší + proč)", rows: 1 },
  { key: "whatHelped", label: "Co pomohlo", rows: 1 },
  { key: "whatFailedOrBackfired", label: "Co selhalo / co se obrátilo proti", rows: 1 },
  { key: "implicationsForNextPlan", label: "Implikace pro další plán", rows: 2 },
  { key: "requiredFollowupsForHanka", label: "Follow-up pro Haničku", rows: 1 },
  { key: "requiredFollowupsForKata", label: "Follow-up pro Káťu", rows: 1 },
];

const draftKey = (partName: string, planId?: string) =>
  `playroom_post_session_draft:${planId || "no-plan"}:${partName}`;

const PostSessionForm = ({
  partName,
  planId,
}: {
  partName: string;
  planId?: string;
}) => {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const key = draftKey(partName, planId);
  const [values, setValues] = useState<Record<string, string>>(() => {
    if (typeof window === "undefined") return {};
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });

  const setField = useCallback(
    (k: string, v: string) => {
      setValues((prev) => {
        const next = { ...prev, [k]: v };
        try {
          window.localStorage.setItem(key, JSON.stringify(next));
        } catch {
          /* ignore */
        }
        return next;
      });
    },
    [key],
  );

  const requiredFilled = (values.whatHappened || "").trim().length > 0
    && (values.dataValidity || "").trim().length > 0;

  const submit = async () => {
    if (!requiredFilled) {
      toast.error('Vyplň minimálně „Co proběhlo" a „Validita dat".');
      return;
    }
    setSubmitting(true);
    try {
      const payloadText = POST_FIELDS
        .map((f) => {
          const v = (values[f.key] || "").trim();
          return v ? `${f.label}:\n${v}` : null;
        })
        .filter(Boolean)
        .join("\n\n");

      const { error } = await (supabase as any).from("did_pending_questions").insert({
        question: `Post-session zápis pro Hernu s ${partName}`,
        directed_to: "karel",
        status: "answered",
        answer: payloadText,
        answered_at: new Date().toISOString(),
        answered_by: "therapist_inline",
        source: "playroom_post_session_payload",
        part_name: partName || "system",
        subject_type: "playroom_post_session",
        crisis_event_id: null,
        ...(planId ? { related_plan_id: planId } : {}),
      });
      if (error) throw error;
      setDone(true);
      try {
        window.localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
      toast.success("Post-session zápis odeslán.");
    } catch (e: any) {
      console.error("[PostSessionForm] insert failed", e);
      toast.error("Uložení selhalo.");
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <p className="text-[12px] text-muted-foreground italic">
        Zápis odeslán — Karel vytvoří analýzu s oddělením fakt / dedukcí / neznámého.
      </p>
    );
  }

  return (
    <div className="rounded-md border border-border/50 bg-background/35 p-2.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 text-[13px] font-medium text-foreground/85 hover:text-primary transition-colors"
      >
        {open ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        Otevřít post-session formulář
      </button>
      {open && (
        <div className="mt-3 space-y-2.5">
          {POST_FIELDS.map((f) => (
            <div key={f.key} className="space-y-1">
              <label className="text-[11px] uppercase tracking-wide text-muted-foreground">
                {f.label}
              </label>
              <textarea
                value={values[f.key] || ""}
                onChange={(e) => setField(f.key, e.target.value)}
                rows={f.rows || 2}
                className="w-full text-[13px] rounded-sm border border-border/60 bg-background/70 px-2 py-1 focus:outline-none focus:ring-1 focus:ring-primary/40"
              />
            </div>
          ))}
          <div className="flex justify-end pt-1">
            <button
              type="button"
              onClick={submit}
              disabled={submitting}
              className="text-[12px] px-3 py-1.5 rounded-sm border border-primary/40 text-primary hover:bg-primary/10 disabled:opacity-50"
            >
              {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Odeslat zápis"}
            </button>
          </div>
          <p className="text-[11px] text-muted-foreground/80">
            Koncept se průběžně ukládá lokálně. Po odeslání se vytvoří strukturovaný záznam pro analýzu.
          </p>
        </div>
      )}
    </div>
  );
};

/* -------------------- Karlova promluva -------------------- */

const KarelOpeningSection = ({ opening }: { opening: string }) => (
  <>
    <SectionHead>Karlova promluva</SectionHead>
    <Prose>{opening}</Prose>
  </>
);

const buildLastSession = (plan: any, review?: LastPlayroomReview | null) => {
  const ls = pickFromPlan(plan, "last_session_summary")
    ?? pickFromPlan(plan, "last_playroom_summary")
    ?? pickFromPlan(plan, "previous_playroom_summary")
    ?? pickFromPlan(plan, "yesterday_playroom_summary")
    ?? {};
  const happened = clinicalList(ls.happened ?? ls.what_happened ?? ls.completed, [review?.practical_report || review?.karel_summary || "Poslední herna je evidovaná; pro dnešní rozhodnutí z ní bereme jen ověřené reakce a průběh, ne hotové závěry."]);
  const not_happened = clinicalList(ls.not_happened ?? ls.what_did_not_happen ?? ls.not_completed, ["V dostupném zápisu zatím není odděleně označeno, co z plánovaného programu odpadlo."]);
  const worked = clinicalList(ls.worked ?? ls.what_worked ?? ls.helped, [review?.key_finding_about_part || review?.recommendations_for_next_playroom || "Jako použitelný opěrný bod bereme jen to, co část unesla bez tlaku a bez ztráty bezpečí."]);
  const destabilized = clinicalList(ls.destabilized ?? ls.destabilising ?? ls.what_failed_or_backfired, ["Dnes nepřidávat výklad ani tlak tam, kde se objeví stažení, zmatek nebo tělesné zahlcení."]);
  const stop_signals = clinicalList(ls.stop_signals ?? ls.stop_rules ?? ls.risks_and_stop_signals, clinicalList(plan?.risks_and_stop_signals, ["stažení", "zahlcení", "zmatek", "odmítnutí pokračovat"]));
  return { happened, not_happened, worked, destabilized, stop_signals };
};

const buildClinicalOpening = (args: {
  explicit: string;
  partName: string;
  whyToday: string;
  lastSession: ReturnType<typeof buildLastSession>;
  directionGoal: string;
  contraindications: string[];
  questions: string[];
}) => {
  if (args.explicit) return args.explicit;
  const last = args.lastSession.happened[0] || "navazuji na poslední doloženou hernu opatrně a bez předčasného výkladu";
  const goal = args.directionGoal || "dnes ověřit bezpečný kontakt, aktuální dostupnost a jeden malý další krok";
  const caution = args.contraindications[0] || args.lastSession.destabilized[0] || "nepůjdu přes stažení, zahlcení ani nejasný stop signál";
  const need = args.questions[0] || "potřebuji od vás před schválením potvrdit bezpečný rámec a hranici, kde hernu zastavit";
  return [
    `Haničko a Káťo, dnešní hernu s ${args.partName} chápu jako úzký pracovní prostor pro ověření, ne jako hotový závěr.`,
    `Vycházím z toho, že ${last}. ${args.whyToday || "Dnešní zaměření proto držím u bezpečného kontaktu a přímých reakcí kluků."}`,
    `Navrhuji držet hlavní cíl: ${goal}. Zároveň platí hranice: ${caution}. Před schválením ${need}.`,
  ].map(clinicalText).filter(Boolean).join("\n\n");
};

const preApprovalQuestionsFromPlan = (plan: any): string[] => clinicalList(
  pickFromPlan(plan, "pre_approval_questions")
    ?? pickFromPlan(plan, "questions_before_approval")
    ?? pickFromPlan(plan, "approval_questions"),
);

/* -------------------- main card -------------------- */

const PlayroomDecisionCard = ({
  playroom,
  view,
  contextSummary,
  contextLabel,
  lastPlayroomReview,
  onOpenDeliberation,
}: Props) => {
  const plan = playroom.playroom_plan || {};
  const partName = view.part_name || playroom.part_name;

  // 3. Co víme z minulé herny
  const lastSession = useMemo(() => {
    return buildLastSession(plan, lastPlayroomReview);
  }, [plan, lastPlayroomReview]);

  // 4. Pracovní dedukce
  const deductions = useMemo(() => {
    const d = pickFromPlan(plan, "deductions");
    const confirmedFallback = clinicalList(plan?.evidence_to_record).length ? clinicalList(plan?.evidence_to_record).slice(0, 3) : lastSession.happened.slice(0, 2);
    const workingFallback = [view.rationale, lastPlayroomReview?.implications_for_plan].map(clinicalText).filter(Boolean).slice(0, 2);
    const unknownFallback = preApprovalQuestionsFromPlan(plan).slice(0, 3);
    if (!d || typeof d !== "object") return {
      confirmed: confirmedFallback,
      working: workingFallback,
      unknowns: unknownFallback.length ? unknownFallback : ["Potřebujeme ověřit přímou reakci kluků v průběhu herny."],
    };
    return {
      confirmed: clinicalList(d.confirmed, confirmedFallback),
      working: clinicalList(d.working, workingFallback),
      unknowns: clinicalList(d.unknowns, unknownFallback),
    };
  }, [plan, lastSession.happened, lastPlayroomReview?.implications_for_plan, view.rationale]);

  // 5. Dnešní směr práce
  const direction = useMemo(() => {
    const d = pickFromPlan(plan, "direction");
    const fallbackStop = clinicalList(plan?.risks_and_stop_signals, lastSession.stop_signals);
    if (!d || typeof d !== "object") return {
      phase: "pracovní ověření bezpečného kontaktu",
      readiness: "čeká na potvrzení terapeutkami",
      goal_primary: clinicalText(plan?.clinical_goal || view.goals[0] || view.rationale || "ověřit dnešní dostupnost bez tlaku na výkon"),
      goal_secondary: clinicalText(view.goals[1] || "získat přímý materiál pro další plán"),
      not_today: clinicalList(plan?.forbidden_directions, ["neotevírat trauma ani interpretace bez přímé reakce kluků"]),
      contraindications: fallbackStop,
      stop_rules: fallbackStop,
      fallback: clinicalText(plan?.fallback || "při zahlcení zastavit program a přejít na bezpečný kontakt"),
    };
    return {
      phase: clinicalText(d.phase),
      readiness: clinicalText(d.readiness),
      goal_primary: firstText(d.goal_primary, plan?.clinical_goal, view.goals[0]),
      goal_secondary: firstText(d.goal_secondary, view.goals[1]),
      not_today: clinicalList(d.not_today, clinicalList(plan?.forbidden_directions)),
      contraindications: clinicalList(d.contraindications, fallbackStop),
      stop_rules: clinicalList(d.stop_rules, fallbackStop),
      fallback: firstText(d.fallback, plan?.fallback),
    };
  }, [plan, lastSession.stop_signals, view.goals, view.rationale]);

  const hasDirection = direction
    && (direction.phase || direction.readiness || direction.goal_primary
      || direction.goal_secondary || direction.not_today.length || direction.contraindications.length
      || direction.stop_rules.length || direction.fallback);

  // 6/7. Doporučení per terapeutka
  const therapistActions = useMemo(() => {
    const ta = pickFromPlan(plan, "therapist_actions");
    if (!ta || typeof ta !== "object") {
      // fallback: questions_for_hanka/kata už máme jako legacy pole
      return {
        hanka: cleanList(playroom.questions_for_hanka),
        kata: cleanList(playroom.questions_for_kata),
      };
    }
    return {
      hanka: cleanList(ta.hanka),
      kata: cleanList(ta.kata),
    };
  }, [plan, playroom]);

  // 9. Otázky před schválením
  const preApprovalQuestions = useMemo(() => {
    const q = pickFromPlan(plan, "pre_approval_questions");
    return cleanList(q);
  }, [plan]);

  // Debug detaily jen pod debug guardem
  const debug = isKarelDebugMode();

  return (
    <div className="mt-2 w-full p-3 rounded-lg border border-primary/20 bg-primary/5 space-y-1">
      {/* HEADER — bez ozdobných chipů, jen název části + střízlivý textový stav */}
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h3 className="text-[15px] font-semibold text-foreground/90 flex items-center gap-1.5">
          <Sparkles className="w-3.5 h-3.5 text-primary" />
          Plán dnešní herny — {partName}
        </h3>
        <span className="text-[11px] text-muted-foreground italic">{statusToText(playroom.status)}</span>
      </div>

      {/* 1. Karlova promluva — DB-first, lokální draft fallback */}
      <KarelOpeningSection dbOpening={opening} />


      {/* 2. Proč právě dnes */}
      {view.rationale && (
        <>
          <SectionHead>Proč právě dnes</SectionHead>
          <Prose>{view.rationale}</Prose>
        </>
      )}

      {/* 3. Co víme z minulé herny */}
      <SectionHead>Co víme z minulé herny</SectionHead>
      {lastSession && (lastSession.happened.length || lastSession.not_happened.length
        || lastSession.worked.length || lastSession.destabilized.length || lastSession.stop_signals.length) ? (
        <div className="space-y-2">
          {lastSession.happened.length > 0 && (
            <div><p className="text-[11px] uppercase tracking-wide text-muted-foreground">Co proběhlo</p><BulletList items={lastSession.happened} /></div>
          )}
          {lastSession.not_happened.length > 0 && (
            <div><p className="text-[11px] uppercase tracking-wide text-muted-foreground">Co neproběhlo</p><BulletList items={lastSession.not_happened} /></div>
          )}
          {lastSession.worked.length > 0 && (
            <div><p className="text-[11px] uppercase tracking-wide text-muted-foreground">Co fungovalo</p><BulletList items={lastSession.worked} /></div>
          )}
          {lastSession.destabilized.length > 0 && (
            <div><p className="text-[11px] uppercase tracking-wide text-muted-foreground">Co destabilizovalo</p><BulletList items={lastSession.destabilized} /></div>
          )}
          {lastSession.stop_signals.length > 0 && (
            <div><p className="text-[11px] uppercase tracking-wide text-muted-foreground">Stop signály</p><BulletList items={lastSession.stop_signals} /></div>
          )}
        </div>
      ) : (
        <p className="text-[12px] text-muted-foreground italic">
          Z minulé herny zatím nemám podklad.
        </p>
      )}

      {/* 4. Pracovní dedukce */}
      {deductions && (deductions.confirmed.length || deductions.working.length || deductions.unknowns.length) && (
        <>
          <SectionHead>Pracovní dedukce</SectionHead>
          {deductions.confirmed.length > 0 && (
            <div><p className="text-[11px] uppercase tracking-wide text-muted-foreground">Potvrzená fakta</p><BulletList items={deductions.confirmed} /></div>
          )}
          {deductions.working.length > 0 && (
            <div><p className="text-[11px] uppercase tracking-wide text-muted-foreground">Pracovní hypotézy</p><BulletList items={deductions.working} /></div>
          )}
          {deductions.unknowns.length > 0 && (
            <div><p className="text-[11px] uppercase tracking-wide text-muted-foreground">Co zůstává nejasné</p><BulletList items={deductions.unknowns} /></div>
          )}
        </>
      )}

      {/* 5. Dnešní směr práce */}
      {hasDirection && direction && (
        <>
          <SectionHead>Dnešní směr práce</SectionHead>
          <div className="space-y-1.5">
            {direction.phase && <p className="text-[13px]"><span className="text-muted-foreground">Fáze: </span>{direction.phase}</p>}
            {direction.readiness && <p className="text-[13px]"><span className="text-muted-foreground">Dnešní připravenost: </span>{direction.readiness}</p>}
            {direction.goal_primary && <p className="text-[13px]"><span className="text-muted-foreground">Hlavní cíl: </span>{direction.goal_primary}</p>}
            {direction.goal_secondary && <p className="text-[13px]"><span className="text-muted-foreground">Vedlejší cíl: </span>{direction.goal_secondary}</p>}
            {direction.not_today.length > 0 && (
              <div><p className="text-[11px] uppercase tracking-wide text-muted-foreground">Co dnes nedělat</p><BulletList items={direction.not_today} /></div>
            )}
            {direction.contraindications.length > 0 && (
              <div><p className="text-[11px] uppercase tracking-wide text-muted-foreground">Kontraindikace</p><BulletList items={direction.contraindications} /></div>
            )}
            {direction.stop_rules.length > 0 && (
              <div><p className="text-[11px] uppercase tracking-wide text-muted-foreground">Stop pravidla</p><BulletList items={direction.stop_rules} /></div>
            )}
            {direction.fallback && <p className="text-[13px]"><span className="text-muted-foreground">Fallback při nedostupnosti: </span>{direction.fallback}</p>}
          </div>
        </>
      )}

      {/* 6. Doporučení pro Haničku */}
      {therapistActions.hanka.length > 0 && (
        <>
          <SectionHead>Doporučení pro Haničku</SectionHead>
          <BulletList items={therapistActions.hanka.slice(0, 3)} />
        </>
      )}

      {/* 7. Doporučení pro Káťu */}
      {therapistActions.kata.length > 0 && (
        <>
          <SectionHead>Doporučení pro Káťu</SectionHead>
          <BulletList items={therapistActions.kata.slice(0, 3)} />
        </>
      )}

      {/* 8. Návrh programu herny */}
      {view.blocks.length > 0 && (
        <>
          <SectionHead>Návrh programu herny</SectionHead>
          <div className="space-y-1.5">
            {view.blocks.map((block, index) => (
              <p key={`${index}-${block.title}`} className="text-[13px] leading-relaxed text-foreground/85">
                <span className="font-medium text-foreground/95">{index + 1}. {block.title}</span> — {block.aim}
              </p>
            ))}
          </div>
          {view.child_safe_text && (
            <>
              <p className="mt-2 text-[11px] uppercase tracking-wide text-muted-foreground">Dětsky bezpečná verze</p>
              <Prose>{view.child_safe_text}</Prose>
            </>
          )}
          {view.stop_rules.length > 0 && (
            <>
              <p className="mt-2 text-[11px] uppercase tracking-wide text-muted-foreground">Stop signály v programu</p>
              <BulletList items={view.stop_rules.slice(0, 4)} />
            </>
          )}
        </>
      )}

      {/* 9. Otázky před schválením — inline */}
      {preApprovalQuestions.length > 0 && (
        <>
          <SectionHead>Otázky před schválením</SectionHead>
          <PreApprovalQuestions
            partName={partName}
            questions={preApprovalQuestions.slice(0, 5)}
            planId={playroom.id}
          />
        </>
      )}

      {/* 10. Co zapsat po sezení */}
      <SectionHead>Co zapsat po sezení</SectionHead>
      <PostSessionForm partName={partName} planId={playroom.id} />

      {/* 11. Co se zapíše dál (statický popis writeback destinací) */}
      <SectionHead>Co se zapíše dál</SectionHead>
      <p className="text-[12px] leading-relaxed text-muted-foreground">
        Karta části — vždy. Operativní plán — vždy. Dlouhodobý plán — pouze když validita dat dovolí.
        Karlova paměť — pouze pro vztahové a workflow implikace, nikdy ne raw transcript.
      </p>

      {/* Akce: otevřít poradu ke schválení */}
      <div className="pt-3 mt-2 border-t border-border/40">
        <button
          type="button"
          onClick={() => onOpenDeliberation(playroom)}
          className="w-full flex items-center justify-center gap-1.5 text-[12px] text-primary hover:bg-primary/10 py-1.5 rounded-sm transition-colors"
        >
          Otevřít poradu ke schválení Herny
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Volitelný kontextový snippet pro debug */}
      {debug && contextSummary && (
        <div className="mt-3 rounded border border-dashed border-muted-foreground/30 bg-muted/20 p-2 text-[11px] text-muted-foreground">
          <div className="font-semibold mb-1">{contextLabel || "Použitý kontext"} (debug)</div>
          <p className="whitespace-pre-line">{contextSummary}</p>
        </div>
      )}
    </div>
  );
};

export default PlayroomDecisionCard;

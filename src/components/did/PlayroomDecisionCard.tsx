/**
 * PlayroomDecisionCard — BLOK 1 (frontend-only)
 *
 * Klinický decision surface pro „Hernu – [část]".
 *
 * BLOK 1 kontrakt:
 *  - Žádné UI mutace (žádné insert/update/delete do DB z této karty).
 *  - Žádný PreApprovalQuestions formulář — workflow přesunut do DeliberationRoom
 *    (existující surface, did_team_deliberations.questions[]).
 *  - Žádný PostSessionForm — odstraněn z BLOKu 1, bude reimplementován v BLOKu 3
 *    jako pavoučí noha post_session_writeback (zápisy do did_observations /
 *    diagnostic_node_entries přes nightly pipeline §4.3).
 *  - Karlova promluva strukturována do 6 named sub-sekcí (Oslovení, Profesní
 *    zjištění, Odborné souvislosti, Dnešní východiska, Diagnostické otázky,
 *    Jednovětý rámec) — render jen tam, kde DB / runtime preview má data.
 *  - Pipeline notice je jen malý podružný blok pod hlavním obsahem.
 *  - CTA „Otevřít poradu" volá existující idempotentní
 *    openProposedPlayroomDeliberation (přes karel-team-deliberation-create).
 *  - Žádný debug text/badge v produkčním view; debug detaily jen za
 *    isKarelDebugMode().
 */

import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Sparkles } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { isKarelDebugMode } from "@/lib/karelDebugMode";
import { sanitizeKarelVisibleText } from "@/lib/karelBriefingVisibleSanitizer";

/** Runtime preview kontrakt z karel-playroom-preview. */
type PipelineNotice = {
  level: "info" | "warning" | "error";
  broken_step?: string | null;
  reason?: string;
  repair_action?: { required: boolean; function: string | null; for_date: string; priority: string } | null;
};
type PlayroomRuntimePreview = {
  status: "preview_ready" | "preview_degraded" | "pipeline_repair_required";
  plannedpart?: string;
  treatmentphase?: string;
  readinessstatus?: "green" | "amber" | "red" | "unknown";
  card_opening_message?: string;
  reason?: string;
  source?: { daily_snapshot: boolean; working_memory: boolean; session_plan: boolean };
  pipeline_notice?: PipelineNotice | null;
  runtime_status?: "preview_ready" | "preview_degraded" | "pipeline_repair_required";
  action_label?: string;
  target_surface?: string;
};

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

type LastPlayroomReview = {
  held?: boolean;
  completion?: "completed" | "partial" | "abandoned" | string;
  karel_summary?: string | null;
  [k: string]: any;
};

interface Props {
  playroom: ProposedPlayroom;
  view: PlayroomView;
  contextSummary?: string | null;
  contextLabel?: string;
  lastPlayroomReview?: LastPlayroomReview | null;
  /** BLOK 1 CTA — existující idempotentní handler v DidDailyBriefingPanel. */
  onOpenDeliberation: (p: ProposedPlayroom) => void;
}

/* -------------------- helpers (pure, no Karel voice) -------------------- */

const pickFromPlan = (plan: any, key: string): any => {
  if (!plan) return undefined;
  if (plan[key] !== undefined && plan[key] !== null) return plan[key];
  if (plan.meta && plan.meta[key] !== undefined && plan.meta[key] !== null) return plan.meta[key];
  return undefined;
};

const cleanStr = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

const FORBIDDEN_VISIBLE_PLAYROOM_RE = /\bgrounded\b|source_status|status\s*grounded|čerp[áa]\s+ze\s+skutečn[ýy]ch\s+dat|sestaven[ýy]\s+ze\s+skutečn[ýy]ch\s+dat|grounding\s*tokens?|pracovn[íi]\s+ov[ěe]řen[íi]|podklad\s+pro\s+pl[áa]nov[áa]n[íi]/giu;

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

const statusToText = (status?: string, runtime?: string): string => {
  if (runtime === "preview_ready") return "stav: runtime náhled připraven";
  if (runtime === "preview_degraded") return "stav: runtime náhled omezený (pipeline neúplná)";
  if (runtime === "pipeline_repair_required") return "stav: pipeline vyžaduje opravu (bez bezpečného náhledu)";
  const s = (status || "").toLowerCase();
  if (s === "approved" || s === "ready_to_start") return "stav: schváleno";
  if (s === "in_progress") return "stav: v běhu";
  if (s === "completed" || s === "evaluated") return "stav: dokončeno";
  return "stav: vyžaduje runtime ověření workspace";
};

/* -------------------- subcomponents -------------------- */

const SectionHead = ({ children }: { children: React.ReactNode }) => (
  <h4 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground mt-4 mb-1.5">
    {children}
  </h4>
);

const SubLabel = ({ children }: { children: React.ReactNode }) => (
  <p className="text-[11px] uppercase tracking-wide text-muted-foreground/85 mt-2 mb-0.5">{children}</p>
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

/* -------------------- spider head (Karlova promluva) -------------------- */

type SpiderHead = {
  greeting: string;
  what_we_know_for_sure: string[];
  context_one_liner: string;
  for_hanka: string;
  for_kata: string;
  diagnostic_questions: string[];
  one_line_frame: string;
  /** Plain text fallback when DB returns string only. */
  plain: string;
};

const buildSpiderHead = (runtime: PlayroomRuntimePreview | null, plan: any): SpiderHead => {
  const empty: SpiderHead = {
    greeting: "",
    what_we_know_for_sure: [],
    context_one_liner: "",
    for_hanka: "",
    for_kata: "",
    diagnostic_questions: [],
    one_line_frame: "",
    plain: "",
  };

  const raw = pickFromPlan(plan, "opening_monologue")
    ?? pickFromPlan(plan, "karel_opening")
    ?? pickFromPlan(plan, "opening_message");

  const runtimeText = clinicalText(runtime?.card_opening_message);

  if (raw && typeof raw === "object") {
    const obj = raw as any;
    return {
      greeting: clinicalText(obj.greeting ?? obj.osloveni),
      what_we_know_for_sure: clinicalList(obj.what_we_know_for_sure ?? obj.profesni_zjisteni),
      context_one_liner: clinicalText(obj.context_one_liner ?? obj.odborne_souvislosti),
      for_hanka: clinicalText(obj.for_hanka),
      for_kata: clinicalText(obj.for_kata),
      diagnostic_questions: clinicalList(obj.diagnostic_questions ?? obj.what_we_dont_know_yet),
      one_line_frame: clinicalText(obj.one_line_frame ?? obj.jednovety_ramec),
      plain: clinicalText(obj.text ?? obj.opening_monologue_text) || runtimeText,
    };
  }

  if (typeof raw === "string" && cleanStr(raw)) {
    return { ...empty, plain: clinicalText(raw) || runtimeText };
  }

  return { ...empty, plain: runtimeText };
};

const spiderHasContent = (h: SpiderHead): boolean =>
  Boolean(
    h.greeting || h.what_we_know_for_sure.length || h.context_one_liner
      || h.for_hanka || h.for_kata || h.diagnostic_questions.length
      || h.one_line_frame || h.plain,
  );

const SpiderHeadView = ({ head }: { head: SpiderHead }) => {
  const sections: { label: string; render: () => React.ReactNode; visible: boolean }[] = [
    { label: "Oslovení", visible: !!head.greeting, render: () => <Prose>{head.greeting}</Prose> },
    { label: "Profesní zjištění", visible: head.what_we_know_for_sure.length > 0, render: () => <BulletList items={head.what_we_know_for_sure} /> },
    { label: "Odborné souvislosti", visible: !!head.context_one_liner, render: () => <Prose>{head.context_one_liner}</Prose> },
    {
      label: "Dnešní východiska",
      visible: !!(head.for_hanka || head.for_kata),
      render: () => (
        <div className="space-y-1.5">
          {head.for_hanka && <p className="text-[13px] leading-relaxed text-foreground/85"><span className="text-muted-foreground">Pro Haničku: </span>{head.for_hanka}</p>}
          {head.for_kata && <p className="text-[13px] leading-relaxed text-foreground/85"><span className="text-muted-foreground">Pro Káťu: </span>{head.for_kata}</p>}
        </div>
      ),
    },
    { label: "Diagnostické otázky", visible: head.diagnostic_questions.length > 0, render: () => <BulletList items={head.diagnostic_questions.slice(0, 6)} /> },
    { label: "Jednovětý rámec", visible: !!head.one_line_frame, render: () => <Prose>{head.one_line_frame}</Prose> },
  ];

  const anyStructured = sections.some((s) => s.visible);

  return (
    <>
      <SectionHead>Karlova promluva</SectionHead>
      {!anyStructured && head.plain && <Prose>{head.plain}</Prose>}
      {anyStructured && (
        <div className="space-y-1">
          {head.plain && !head.greeting && !head.context_one_liner && <Prose>{head.plain}</Prose>}
          {sections.filter((s) => s.visible).map((s) => (
            <div key={s.label}>
              <SubLabel>{s.label}</SubLabel>
              {s.render()}
            </div>
          ))}
        </div>
      )}
    </>
  );
};

/* -------------------- side-block builders (DB-only) -------------------- */

const buildLastSession = (plan: any) => {
  const ls = pickFromPlan(plan, "last_session_summary")
    ?? pickFromPlan(plan, "last_playroom_summary")
    ?? pickFromPlan(plan, "previous_playroom_summary")
    ?? pickFromPlan(plan, "yesterday_playroom_summary");
  if (!ls || typeof ls !== "object") {
    return { happened: [], not_happened: [], worked: [], destabilized: [], stop_signals: [] };
  }
  return {
    happened: clinicalList(ls.happened ?? ls.what_happened ?? ls.completed),
    not_happened: clinicalList(ls.not_happened ?? ls.what_did_not_happen ?? ls.not_completed),
    worked: clinicalList(ls.worked ?? ls.what_worked ?? ls.helped),
    destabilized: clinicalList(ls.destabilized ?? ls.destabilising ?? ls.what_failed_or_backfired),
    stop_signals: clinicalList(ls.stop_signals ?? ls.stop_rules ?? ls.risks_and_stop_signals),
  };
};

/* -------------------- main card -------------------- */

const PlayroomDecisionCard = ({
  playroom,
  view,
  contextSummary,
  contextLabel,
  lastPlayroomReview: _lastPlayroomReview,
  onOpenDeliberation,
}: Props) => {
  const plan = playroom.playroom_plan || {};
  const partName = view.part_name || playroom.part_name;

  // Runtime preview z karel-playroom-preview (canonical snapshot + WM + plan).
  const [runtime, setRuntime] = useState<PlayroomRuntimePreview | null>(null);
  const [runtimeLoading, setRuntimeLoading] = useState<boolean>(true);
  useEffect(() => {
    let cancelled = false;
    setRuntimeLoading(true);
    (supabase as any).functions
      .invoke("karel-playroom-preview", { body: { part_name: partName } })
      .then(({ data, error }: any) => {
        if (cancelled) return;
        if (error) { setRuntime(null); return; }
        if (data && typeof data === "object") setRuntime(data as PlayroomRuntimePreview);
      })
      .catch(() => { if (!cancelled) setRuntime(null); })
      .finally(() => { if (!cancelled) setRuntimeLoading(false); });
    return () => { cancelled = true; };
  }, [partName]);

  const clinicalRationale = useMemo(
    () => firstText(runtime?.reason, view.rationale, playroom.why_this_part_today, playroom.main_theme),
    [runtime?.reason, view.rationale, playroom.why_this_part_today, playroom.main_theme],
  );

  const spider = useMemo(() => buildSpiderHead(runtime, plan), [runtime, plan]);
  const hasSpider = spiderHasContent(spider);

  // Co víme z minulé herny — render jen pokud DB má alespoň jednu neprázdnou sub-položku.
  const lastSession = useMemo(() => buildLastSession(plan), [plan]);
  const hasLastSession = Boolean(lastSession.happened.length || lastSession.not_happened.length
    || lastSession.worked.length || lastSession.destabilized.length || lastSession.stop_signals.length);

  const deductions = useMemo(() => {
    const d = pickFromPlan(plan, "deductions");
    if (!d || typeof d !== "object") return null;
    const confirmed = clinicalList(d.confirmed);
    const working = clinicalList(d.working);
    const unknowns = clinicalList(d.unknowns);
    if (!confirmed.length && !working.length && !unknowns.length) return null;
    return { confirmed, working, unknowns };
  }, [plan]);

  const direction = useMemo(() => {
    const d = pickFromPlan(plan, "direction");
    if (!d || typeof d !== "object") return null;
    const phase = clinicalText(d.phase);
    const readiness = clinicalText(d.readiness);
    const goal_primary = clinicalText(d.goal_primary);
    if (!phase && !readiness && !goal_primary) return null;
    return {
      phase,
      readiness,
      goal_primary,
      goal_secondary: clinicalText(d.goal_secondary),
      not_today: clinicalList(d.not_today),
      contraindications: clinicalList(d.contraindications),
      stop_rules: clinicalList(d.stop_rules),
      fallback: clinicalText(d.fallback),
    };
  }, [plan]);

  const therapistActions = useMemo(() => {
    const ta = pickFromPlan(plan, "therapist_actions");
    if (!ta || typeof ta !== "object") return { hanka: [], kata: [] };
    return {
      hanka: clinicalList(ta.hanka),
      kata: clinicalList(ta.kata),
    };
  }, [plan]);

  const debug = isKarelDebugMode();

  // Honest empty state pouze pokud nemáme NIC — ani runtime preview, ani DB opening.
  const showOpeningEmptyState = !runtimeLoading && !hasSpider;

  return (
    <div className="mt-2 w-full p-3 rounded-lg border border-primary/20 bg-primary/5 space-y-1">
      {/* HEADER */}
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h3 className="text-[15px] font-semibold text-foreground/90 flex items-center gap-1.5">
          <Sparkles className="w-3.5 h-3.5 text-primary" />
          Herna – {partName}
        </h3>
        <span className="text-[11px] text-muted-foreground italic">
          {runtimeLoading ? "stav: načítám runtime náhled…" : statusToText(playroom.status, runtime?.status)}
        </span>
      </div>

      {(runtime?.status === "preview_ready" || runtime?.status === "preview_degraded") && (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
          {runtime.plannedpart && <span>Část: <span className="text-foreground/80">{runtime.plannedpart}</span></span>}
          {runtime.treatmentphase && <span>Fáze: <span className="text-foreground/80">{runtime.treatmentphase}</span></span>}
          {runtime.readinessstatus && <span>Readiness: <span className="text-foreground/80">{runtime.readinessstatus}</span></span>}
        </div>
      )}

      {/* Pavoučí HLAVA — 6 named sub-sekcí */}
      <div className="lg:grid lg:grid-cols-[2fr_1fr] lg:gap-4">
        <div>
          {hasSpider && <SpiderHeadView head={spider} />}
          {showOpeningEmptyState && (
            <>
              <SectionHead>Karlova promluva</SectionHead>
              <p className="text-[13px] leading-relaxed text-muted-foreground italic">
                Karlova promluva pro tuto Hernu zatím nebyla vygenerována.
              </p>
            </>
          )}

          {clinicalRationale && (
            <>
              <SectionHead>Proč právě dnes</SectionHead>
              <Prose>{clinicalRationale}</Prose>
            </>
          )}
        </div>

        {/* Side panel — boční bloky se renderují jen pokud mají strukturovaná data */}
        <div className="space-y-1">
          {hasLastSession && (
            <>
              <SectionHead>Co víme z minulé herny</SectionHead>
              <div className="space-y-2">
                {lastSession.happened.length > 0 && (
                  <div><SubLabel>Co proběhlo</SubLabel><BulletList items={lastSession.happened} /></div>
                )}
                {lastSession.not_happened.length > 0 && (
                  <div><SubLabel>Co neproběhlo</SubLabel><BulletList items={lastSession.not_happened} /></div>
                )}
                {lastSession.worked.length > 0 && (
                  <div><SubLabel>Co fungovalo</SubLabel><BulletList items={lastSession.worked} /></div>
                )}
                {lastSession.destabilized.length > 0 && (
                  <div><SubLabel>Co destabilizovalo</SubLabel><BulletList items={lastSession.destabilized} /></div>
                )}
                {lastSession.stop_signals.length > 0 && (
                  <div><SubLabel>Stop signály</SubLabel><BulletList items={lastSession.stop_signals} /></div>
                )}
              </div>
            </>
          )}

          {deductions && (
            <>
              <SectionHead>Pracovní dedukce</SectionHead>
              {deductions.confirmed.length > 0 && (
                <div><SubLabel>Potvrzená fakta</SubLabel><BulletList items={deductions.confirmed} /></div>
              )}
              {deductions.working.length > 0 && (
                <div><SubLabel>Pracovní hypotézy</SubLabel><BulletList items={deductions.working} /></div>
              )}
              {deductions.unknowns.length > 0 && (
                <div><SubLabel>Co zůstává nejasné</SubLabel><BulletList items={deductions.unknowns} /></div>
              )}
            </>
          )}

          {direction && (
            <>
              <SectionHead>Dnešní směr práce</SectionHead>
              <div className="space-y-1.5">
                {direction.phase && <p className="text-[13px]"><span className="text-muted-foreground">Fáze: </span>{direction.phase}</p>}
                {direction.readiness && <p className="text-[13px]"><span className="text-muted-foreground">Dnešní připravenost: </span>{direction.readiness}</p>}
                {direction.goal_primary && <p className="text-[13px]"><span className="text-muted-foreground">Hlavní cíl: </span>{direction.goal_primary}</p>}
                {direction.goal_secondary && <p className="text-[13px]"><span className="text-muted-foreground">Vedlejší cíl: </span>{direction.goal_secondary}</p>}
                {direction.not_today.length > 0 && (
                  <div><SubLabel>Co dnes nedělat</SubLabel><BulletList items={direction.not_today} /></div>
                )}
                {direction.contraindications.length > 0 && (
                  <div><SubLabel>Kontraindikace</SubLabel><BulletList items={direction.contraindications} /></div>
                )}
                {direction.stop_rules.length > 0 && (
                  <div><SubLabel>Stop pravidla</SubLabel><BulletList items={direction.stop_rules} /></div>
                )}
                {direction.fallback && <p className="text-[13px]"><span className="text-muted-foreground">Fallback při nedostupnosti: </span>{direction.fallback}</p>}
              </div>
            </>
          )}

          {therapistActions.hanka.length > 0 && (
            <>
              <SectionHead>Doporučení pro Haničku</SectionHead>
              <BulletList items={therapistActions.hanka.slice(0, 3)} />
            </>
          )}

          {therapistActions.kata.length > 0 && (
            <>
              <SectionHead>Doporučení pro Káťu</SectionHead>
              <BulletList items={therapistActions.kata.slice(0, 3)} />
            </>
          )}
        </div>
      </div>

      {/* Pipeline notice — malý podružný blok pod hlavním obsahem */}
      {!runtimeLoading && runtime?.pipeline_notice && (
        <div className="mt-3 rounded-sm border border-border/40 bg-muted/20 px-2 py-1.5 text-[11px] text-muted-foreground space-y-0.5">
          <p>
            <span className="font-medium text-foreground/70">Pipeline – {runtime.pipeline_notice.level === "error" ? "chyba" : runtime.pipeline_notice.level === "warning" ? "varování" : "info"}</span>
            {runtime.pipeline_notice.broken_step ? ` · krok: ${runtime.pipeline_notice.broken_step}` : ""}
          </p>
          {runtime.pipeline_notice.reason && <p>{runtime.pipeline_notice.reason}</p>}
          {runtime.pipeline_notice.repair_action?.function && (
            <p>Doporučený rerun: <code className="text-[10px]">{runtime.pipeline_notice.repair_action.function}</code> pro {runtime.pipeline_notice.repair_action.for_date}.</p>
          )}
        </div>
      )}

      {/* CTA — „Otevřít poradu" (existující idempotentní handler přes karel-team-deliberation-create) */}
      <div className="pt-3 mt-2 border-t border-border/40">
        <button
          type="button"
          onClick={() => onOpenDeliberation(playroom)}
          className="w-full flex items-center justify-center gap-1.5 text-[12px] text-primary hover:bg-primary/10 py-1.5 rounded-sm transition-colors"
          data-testid="playroom-open-deliberation"
        >
          Otevřít poradu ke schválení Herny
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </div>

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

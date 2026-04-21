/**
 * CrisisDetailWorkspace — Crisis Workspace Re-Architecture Pass (2026-04-21).
 *
 * Pracovní plocha krize (right-side Sheet drawer). Stejný entry point pro:
 *   - klik na „Otevřít detail" v signalizačním banneru (CrisisAlert)
 *   - klik na „Otevřít detail" v Karlově přehledu (KarelCrisisDeficits)
 *
 * Owner: `useCrisisDetail().openCrisisDetail(cardId)`.
 *
 * Re-architektura (2026-04-21, druhá vlna):
 *   Overview tab už není pasivní text. Je to LAUNCHPAD s 8 akčními kartami
 *   vedoucími do skutečných pracovních míst:
 *     1. Karlův přehled        → /chat (Pracovna, kde žije KarelOverviewPanel)
 *     2. Otevřené porady       → najde open deliberation → bridge do DidDashboard
 *     3. Úkoly terapeutů       → Pracovna → DidTherapistTaskBoard
 *     4. Otázky pro jednotlivce→ Pracovna → PendingQuestionsPanel
 *     5. Návrh na sezení s částí → Karlův plán dne (DidDailySessionPlan)
 *     6. Přímá terapie s částí → /chat?crisis_action=interview&part_name=…
 *     7. Krizové hodnocení dne → /chat?crisis_action=interview (gate na deficit)
 *     8. Feedback terapeutek   → /chat?crisis_action=feedback
 *
 * Tabs (Přehled / Řízení / Uzavření / Historie) jsou vyhrazeny jen pro
 * obsahový kontext téže krize. Tlačítka pro porady, úkoly, otázky, sezení
 * a přímou terapii NEJSOU tabs — jsou to akční karty v Overview, které
 * routují do jiných workflow míst.
 *
 * Žádné dead links: každá karta je buď funkční, nebo gated/disabled
 * s explicitním důvodem.
 */
import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  Shield,
  Users,
  Calendar,
  Activity,
  ArrowRight,
  CheckCircle,
  Clock,
  AlertCircle,
  Loader2,
  Play,
  ClipboardList,
  Handshake,
  ListChecks,
  MessageCircleQuestion,
  CalendarPlus,
  MessageSquare,
  Brain,
  ExternalLink,
} from "lucide-react";

import {
  useCrisisOperationalState,
  type CrisisOperationalCard,
} from "@/hooks/useCrisisOperationalState";
import { useCrisisDetail } from "@/contexts/CrisisDetailContext";

import CrisisClosureWorkflow from "./CrisisClosureWorkflow";
import CrisisHistoryTimeline, { type JournalEntry } from "./CrisisHistoryTimeline";

type TabKey = "overview" | "closure" | "history";

const TABS: { key: TabKey; label: string; hint: string }[] = [
  { key: "overview", label: "Přehled", hint: "akční launchpad" },
  { key: "closure", label: "Uzavření", hint: "closure readiness" },
  { key: "history", label: "Historie", hint: "deník zásahů" },
];

const STATE_LABELS: Record<string, string> = {
  active: "aktivní",
  intervened: "po zásahu",
  stabilizing: "stabilizace",
  awaiting_session_result: "čeká výsledek",
  awaiting_therapist_feedback: "čeká feedback",
  ready_for_joint_review: "k poradě",
  ready_to_close: "k uzavření",
  closed: "uzavřeno",
  monitoring_post: "monitoring",
};

// (acknowledge je řešen přímo přes supabase update — backend nemá akci `acknowledge_alert`)

const CrisisDetailWorkspace: React.FC = () => {
  const { activeCardId, closeCrisisDetail, initialTab } = useCrisisDetail();
  const { cards, refetch } = useCrisisOperationalState();
  const [activeTab, setActiveTab] = useState<TabKey>(initialTab);
  const [journalEntries, setJournalEntries] = useState<JournalEntry[]>([]);
  const [ackLoading, setAckLoading] = useState(false);

  const card = useMemo<CrisisOperationalCard | null>(() => {
    if (!activeCardId) return null;
    return (
      cards.find(
        (c) => (c.eventId || c.alertId || c.partName) === activeCardId,
      ) ?? null
    );
  }, [activeCardId, cards]);

  // Reset tab on každé otevření.
  useEffect(() => {
    if (activeCardId) setActiveTab(initialTab);
  }, [activeCardId, initialTab]);

  // Lazy-load journal entries když se aktivuje History.
  useEffect(() => {
    if (!card || activeTab !== "history") return;
    if (!card.eventId && !card.alertId) {
      setJournalEntries([]);
      return;
    }
    let cancelled = false;
    setJournalEntries([]);
    (async () => {
      const query = supabase
        .from("crisis_journal")
        .select(
          "id, date, day_number, karel_action, karel_notes, session_summary, what_worked, what_failed, crisis_trend",
        )
        .order("date", { ascending: false })
        .limit(50);
      if (card.eventId) query.eq("crisis_event_id", card.eventId);
      else if (card.alertId) query.eq("crisis_alert_id", card.alertId);
      const { data } = await query;
      if (!cancelled && data) {
        setJournalEntries(
          data.map((j: any) => ({
            id: j.id,
            date: j.date,
            dayNumber: j.day_number,
            karelAction: j.karel_action,
            karelNotes: j.karel_notes,
            sessionSummary: j.session_summary,
            whatWorked: j.what_worked,
            whatFailed: j.what_failed,
            crisisTrend: j.crisis_trend,
          })),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeTab, card]);

  const handleAcknowledge = async () => {
    if (!card) return;
    setAckLoading(true);
    try {
      // Direct DB updates — there is no acknowledge_alert backend action.
      // We mark the alert as acknowledged AND dismiss the banner on the event.
      const stamp = new Date().toISOString();
      const ops: Promise<any>[] = [];
      if (card.alertId) {
        ops.push(
          (supabase as any)
            .from("crisis_alerts")
            .update({ acknowledged_at: stamp, acknowledged_by: "karel" })
            .eq("id", card.alertId),
        );
      }
      if (card.eventId) {
        ops.push(
          (supabase as any)
            .from("crisis_events")
            .update({ banner_dismissed: true, banner_dismissed_at: stamp })
            .eq("id", card.eventId),
        );
      }
      const results = await Promise.all(ops);
      const firstError = results.find((r) => r?.error)?.error;
      if (firstError) throw new Error(firstError.message);
      toast.success("Vzato na vědomí — banner skryt");
      refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Chyba při potvrzení");
    } finally {
      setAckLoading(false);
    }
  };

  // Closure tab is only relevant when state is past stabilization
  const closureRelevant = card
    ? ["awaiting_therapist_feedback", "ready_for_joint_review", "ready_to_close", "closed", "monitoring_post"].includes(
        card.operatingState || "",
      )
    : false;

  const visibleTabs = TABS.filter((t) => t.key !== "closure" || closureRelevant);

  const isOpen = !!activeCardId;

  return (
    <Sheet open={isOpen} onOpenChange={(o) => { if (!o) closeCrisisDetail(); }}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-[680px] p-0 flex flex-col overflow-hidden bg-background"
      >
        {!card ? (
          <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
            {activeCardId ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin mr-2" /> Načítám krizový detail…
              </>
            ) : (
              "Žádná krize není vybrána."
            )}
          </div>
        ) : (
          <>
            <CrisisWorkspaceHeader card={card} onAcknowledge={handleAcknowledge} ackLoading={ackLoading} />

            {/* Tab bar */}
            <div className="flex border-b text-[12px] shrink-0 bg-muted/30">
              {visibleTabs.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setActiveTab(t.key)}
                  className={`flex-1 py-2.5 px-2 font-medium transition-colors ${
                    activeTab === t.key
                      ? "bg-background text-primary border-b-2 border-primary"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  title={t.hint}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto">
              {activeTab === "overview" && (
                <CrisisLaunchpadSection
                  card={card}
                  onJumpToClosure={closureRelevant ? () => setActiveTab("closure") : undefined}
                  onClose={closeCrisisDetail}
                />
              )}
              {activeTab === "closure" && (
                <div className="p-5">
                  <CrisisClosureWorkflow card={card} onRefetch={refetch} />
                </div>
              )}
              {activeTab === "history" && (
                <div className="p-5">
                  <CrisisHistoryTimeline card={card} journalEntries={journalEntries} />
                </div>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
};

// ── Header ────────────────────────────────────────────────────────────────

const CrisisWorkspaceHeader: React.FC<{
  card: CrisisOperationalCard;
  onAcknowledge: () => void;
  ackLoading: boolean;
}> = ({ card, onAcknowledge, ackLoading }) => {
  const stateLabel = card.operatingState
    ? STATE_LABELS[card.operatingState] || card.operatingState
    : "aktivní";

  return (
    <SheetHeader className="px-5 pt-5 pb-4 border-b shrink-0 bg-background space-y-2.5">
      <div className="flex items-start gap-3">
        <Shield className="w-5 h-5 mt-0.5 text-primary shrink-0" />
        <div className="flex-1 min-w-0">
          <SheetTitle className="text-base font-serif text-foreground truncate">
            Krizový detail — {card.displayName}
          </SheetTitle>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Pracovní plocha pro řízení této krize.
          </p>
        </div>
      </div>

      {/* Pracovní status řádek — kompaktní fakta */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-muted-foreground pl-8">
        <span className="inline-flex items-center gap-1">
          <Activity className="w-3 h-3" />
          severity: <strong className="text-foreground">{card.severity}</strong>
        </span>
        <span className="inline-flex items-center gap-1">
          <Calendar className="w-3 h-3" />
          stav: <strong className="text-foreground">{stateLabel}</strong>
        </span>
        {card.daysActive != null && (
          <span className="inline-flex items-center gap-1">
            den <strong className="text-foreground">{card.daysActive}</strong>
          </span>
        )}
        {card.isStale && (
          <span className="inline-flex items-center gap-1 text-accent-foreground/90">
            <Clock className="w-3 h-3" />
            {Math.round(card.hoursStale)}h bez kontaktu
          </span>
        )}
        {card.primaryTherapist && card.primaryTherapist !== "neurčeno" && (
          <span className="inline-flex items-center gap-1">
            <Users className="w-3 h-3" />
            tým: <strong className="text-foreground">{card.primaryTherapist}</strong>
            {card.secondaryTherapist && card.secondaryTherapist !== card.primaryTherapist && (
              <>, <strong className="text-foreground">{card.secondaryTherapist}</strong></>
            )}
          </span>
        )}
        {(card.alertId || card.eventId) && (
          <button
            onClick={onAcknowledge}
            disabled={ackLoading}
            className="ml-auto inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded text-muted-foreground hover:text-primary transition-colors disabled:opacity-50"
            title="Skrýt banner a označit jako vzato na vědomí"
          >
            {ackLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle className="w-3 h-3" />}
            Vzít na vědomí
          </button>
        )}
      </div>
    </SheetHeader>
  );
};

// ── Launchpad section (Overview = akční karty) ────────────────────────────

interface ActionCard {
  key: string;
  icon: React.ReactNode;
  title: string;
  description: string;
  cta: string;
  onClick?: () => void;
  /** Když je disabled, zobrazíme decentní disabled stav s důvodem. */
  disabledReason?: string;
  /** Vizuálně zvýrazněná akce (např. otevřená porada). */
  highlight?: boolean;
  /** Sekundární metainformace (např. počet otevřených úkolů). */
  meta?: string;
}

const CrisisLaunchpadSection: React.FC<{
  card: CrisisOperationalCard;
  onJumpToClosure?: () => void;
  onClose: () => void;
}> = ({ card, onJumpToClosure, onClose }) => {
  const navigate = useNavigate();
  const [openMeetingId, setOpenMeetingId] = useState<string | null>(null);
  const [openTaskCount, setOpenTaskCount] = useState<number | null>(null);
  const [openQuestionCount, setOpenQuestionCount] = useState<number | null>(null);
  const [meetingLoading, setMeetingLoading] = useState(true);

  // Lookup: open deliberation, open tasks, open questions for this crisis.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setMeetingLoading(true);
      try {
        // Open meeting (deliberation) for this crisis
        if (card.eventId) {
          const { data: del } = await (supabase as any)
            .from("did_team_deliberations")
            .select("id")
            .eq("crisis_event_id", card.eventId)
            .neq("status", "finalized")
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (!cancelled) setOpenMeetingId((del as { id?: string } | null)?.id ?? null);
        } else {
          if (!cancelled) setOpenMeetingId(null);
        }

        // Open tasks for crisis
        if (card.eventId) {
          const { count } = await (supabase as any)
            .from("crisis_tasks")
            .select("id", { count: "exact", head: true })
            .eq("crisis_event_id", card.eventId)
            .neq("status", "completed");
          if (!cancelled) setOpenTaskCount(count ?? 0);
        } else if (card.alertId) {
          const { count } = await (supabase as any)
            .from("crisis_tasks")
            .select("id", { count: "exact", head: true })
            .eq("crisis_alert_id", card.alertId)
            .neq("status", "completed");
          if (!cancelled) setOpenTaskCount(count ?? 0);
        }

        // Open questions for crisis
        if (card.eventId) {
          const { count } = await supabase
            .from("did_pending_questions")
            .select("id", { count: "exact", head: true })
            .eq("crisis_event_id", card.eventId)
            .neq("status", "answered");
          if (!cancelled) setOpenQuestionCount(count ?? 0);
        }
      } catch {
        /* graceful */
      } finally {
        if (!cancelled) setMeetingLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [card.eventId, card.alertId]);

  // ── Navigation helpers ──────────────────────────────────────────────
  const goPracovnaKarel = () => {
    try { sessionStorage.setItem("karel_hub_section", "did"); } catch {}
    try { sessionStorage.setItem("karel_terapeut_surface", "pracovna"); } catch {}
    onClose();
    navigate("/chat");
  };

  const goPracovnaMeeting = () => {
    try { sessionStorage.setItem("karel_hub_section", "did"); } catch {}
    try { sessionStorage.setItem("karel_terapeut_surface", "pracovna"); } catch {}
    if (openMeetingId) {
      try { sessionStorage.setItem("karel_open_deliberation_id", openMeetingId); } catch {}
      toast.success("Otevírám poradu týmu");
    } else {
      toast.info("Žádná otevřená porada — otevírám sekci Porady v Pracovně");
    }
    onClose();
    navigate("/chat");
  };

  const goCrisisInterview = () => {
    const params = new URLSearchParams();
    params.set("crisis_action", "interview");
    params.set("part_name", card.partName);
    if (card.eventId) params.set("crisis_event_id", card.eventId);
    try { sessionStorage.setItem("karel_hub_section", "did"); } catch {}
    onClose();
    navigate(`/chat?${params.toString()}`);
  };

  const goFeedback = () => {
    const params = new URLSearchParams();
    params.set("crisis_action", "feedback");
    if (card.eventId) params.set("crisis_event_id", card.eventId);
    try { sessionStorage.setItem("karel_hub_section", "did"); } catch {}
    onClose();
    navigate(`/chat?${params.toString()}`);
  };

  // ── Action cards ────────────────────────────────────────────────────
  const cards: ActionCard[] = [
    {
      key: "karel-overview",
      icon: <Brain className="w-4 h-4" />,
      title: "Karlův přehled",
      description: "Dnešní krizové deficity, plán dne a Karlův decision context.",
      cta: "Otevřít Pracovnu",
      onClick: goPracovnaKarel,
    },
    {
      key: "open-meeting",
      icon: <Handshake className="w-4 h-4" />,
      title: "Porada týmu",
      description: openMeetingId
        ? "Existuje otevřená porada k této krizi."
        : "Žádná otevřená porada — můžeš ji založit v Pracovně.",
      cta: openMeetingId ? "Otevřít poradu" : "Otevřít sekci Porady",
      onClick: goPracovnaMeeting,
      highlight: !!openMeetingId,
      meta: meetingLoading ? "…" : openMeetingId ? "1 otevřená" : "žádná",
    },
    {
      key: "therapist-tasks",
      icon: <ListChecks className="w-4 h-4" />,
      title: "Úkoly terapeutů",
      description: "Konkrétní krizové úkoly pro Haničku a Káťu.",
      cta: "Otevřít úkoly",
      onClick: goPracovnaKarel,
      meta: openTaskCount == null ? "…" : `${openTaskCount} otevřených`,
    },
    {
      key: "questions",
      icon: <MessageCircleQuestion className="w-4 h-4" />,
      title: "Otázky pro jednotlivce",
      description: "Dotazy směřované na konkrétní terapeutku — vyžadují odpověď.",
      cta: "Otevřít otázky",
      onClick: goPracovnaKarel,
      meta: openQuestionCount == null ? "…" : `${openQuestionCount} otevřených`,
    },
    {
      key: "session-proposal",
      icon: <CalendarPlus className="w-4 h-4" />,
      title: "Návrh sezení s částí",
      description: "Karlův plán dne nese návrh, kdy a jak vést sezení s částí.",
      cta: "Otevřít plán dne",
      onClick: goPracovnaKarel,
    },
    {
      key: "direct-therapy",
      icon: <MessageSquare className="w-4 h-4" />,
      title: "Přímá terapie s částí",
      description: card.eventId
        ? "Otevři krizové vlákno s částí — Karel povede přímou práci."
        : "Bez aktivního crisis_event nelze otevřít krizové vlákno.",
      cta: "Otevřít krizové vlákno",
      onClick: card.eventId ? goCrisisInterview : undefined,
      disabledReason: card.eventId
        ? undefined
        : "Krizová karta nemá navázaný crisis_event — vlákno nelze inicializovat.",
    },
    {
      key: "today-assessment",
      icon: <Play className="w-4 h-4" />,
      title: "Krizové hodnocení dne",
      description: card.missingTodayInterview
        ? "Karel ještě dnes nevedl interview s částí."
        : "Dnešní hodnocení je hotové.",
      cta: card.missingTodayInterview ? "Spustit hodnocení" : "Hotovo dnes",
      onClick: card.missingTodayInterview && card.eventId ? goCrisisInterview : undefined,
      disabledReason: !card.missingTodayInterview
        ? "Dnešní interview už proběhlo — další krok je v záložce Řízení."
        : !card.eventId
          ? "Bez crisis_event nelze hodnocení založit."
          : undefined,
    },
    {
      key: "feedback",
      icon: <ClipboardList className="w-4 h-4" />,
      title: "Feedback terapeutek",
      description: card.missingTherapistFeedback
        ? "Čekáme na vyjádření Haničky / Káti k poslednímu zásahu."
        : "Aktuální feedback není potřeba.",
      cta: card.missingTherapistFeedback ? "Vyžádat feedback" : "Není potřeba",
      onClick: card.missingTherapistFeedback && card.eventId ? goFeedback : undefined,
      disabledReason: !card.missingTherapistFeedback
        ? "Žádný čekající feedback — pokračuj v záložce Řízení."
        : !card.eventId
          ? "Bez crisis_event nelze feedback request vytvořit."
          : undefined,
    },
  ];

  // ── Render ──────────────────────────────────────────────────────────
  const mainProblem =
    card.mainBlocker ||
    card.triggerDescription ||
    card.clinicalSummary ||
    card.displaySummary ||
    "Není zaznamenán hlavní problém.";

  return (
    <div className="p-5 space-y-5">
      {/* Hlavní problém — krátké orientační shrnutí */}
      <section className="rounded-lg border border-border bg-card/50 p-3.5 space-y-1">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Hlavní problém</div>
        <p className="text-sm leading-relaxed text-foreground">{mainProblem}</p>
      </section>

      {/* Sekundární přehled — workflow akce v této kartě */}
      <div className="flex items-center justify-between gap-3 pt-1">
        <h3 className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
          Akční launchpad
        </h3>
        {onJumpToClosure && (
          <button
            onClick={onJumpToClosure}
            className="text-[11px] px-2 py-1 rounded text-muted-foreground hover:text-primary hover:bg-muted/50 transition-colors inline-flex items-center gap-1"
            title="Closure readiness této krize"
          >
            Uzavření <ArrowRight className="w-3 h-3" />
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        {cards.map((c) => (
          <ActionLaunchCard key={c.key} card={c} />
        ))}
      </div>

      {/* Pomocná deficit lišta */}
      {(card.missingTodayInterview ||
        card.missingTherapistFeedback ||
        card.missingSessionResult ||
        card.isStale) && (
        <section className="rounded-lg border border-accent/30 bg-accent/5 p-3 space-y-1.5">
          <div className="text-[10px] uppercase tracking-wide text-accent-foreground/80 flex items-center gap-1">
            <AlertCircle className="w-3 h-3" /> Co dnes chybí
          </div>
          <ul className="space-y-0.5 text-[12px] text-foreground">
            {card.missingTodayInterview && <li>· Dnešní krizové hodnocení části.</li>}
            {card.missingTherapistFeedback && <li>· Feedback terapeutek k poslednímu zásahu.</li>}
            {card.missingSessionResult && <li>· Výsledek posledního sezení.</li>}
            {card.isStale && <li>· Dlouho bez kontaktu ({Math.round(card.hoursStale)}h).</li>}
          </ul>
        </section>
      )}
    </div>
  );
};

const ActionLaunchCard: React.FC<{ card: ActionCard }> = ({ card }) => {
  const isDisabled = !!card.disabledReason || !card.onClick;
  return (
    <button
      onClick={card.onClick}
      disabled={isDisabled}
      title={card.disabledReason || card.description}
      className={`group text-left rounded-lg border p-3 transition-colors flex flex-col gap-1.5 ${
        isDisabled
          ? "border-border/50 bg-muted/20 cursor-not-allowed opacity-60"
          : card.highlight
            ? "border-primary/40 bg-primary/5 hover:bg-primary/10"
            : "border-border bg-card hover:bg-muted/40"
      }`}
    >
      <div className="flex items-center gap-2">
        <span className={`shrink-0 ${card.highlight ? "text-primary" : "text-muted-foreground"}`}>
          {card.icon}
        </span>
        <span className="text-[12px] font-medium text-foreground leading-tight flex-1 truncate">
          {card.title}
        </span>
        {card.meta && (
          <span className="text-[10px] text-muted-foreground shrink-0">{card.meta}</span>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground leading-snug">
        {card.disabledReason || card.description}
      </p>
      <span
        className={`mt-1 inline-flex items-center gap-1 text-[11px] ${
          isDisabled
            ? "text-muted-foreground/60"
            : card.highlight
              ? "text-primary"
              : "text-foreground/70 group-hover:text-primary"
        }`}
      >
        {card.cta}
        {!isDisabled && <ExternalLink className="w-3 h-3" />}
      </span>
    </button>
  );
};

export default CrisisDetailWorkspace;

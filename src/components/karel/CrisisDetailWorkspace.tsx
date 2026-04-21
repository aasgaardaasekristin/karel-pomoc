/**
 * CrisisDetailWorkspace — Crisis Detail UX Repair Pass (2026-04-21).
 *
 * Pracovní plocha krize (right-side Sheet drawer), do které vede:
 *   - klik na „Otevřít detail" v signalizačním banneru (CrisisAlert)
 *   - klik na „Otevřít detail" v Karlově přehledu (KarelCrisisDeficits)
 *
 * Oba vstupy používají stejný owner: `useCrisisDetail().openCrisisDetail(cardId)`.
 *
 * Drawer je renderovaný globálně v App.tsx, takže funguje napříč routy
 * (Pracovna i kdekoli jinde, kde banner žije).
 *
 * Struktura:
 *   1. Pracovní hlavička (kdo, severity, stav, den, ownership v detailu)
 *   2. Sekce „Přehled" (default) — okamžitá orientace: hlavní problém, co se
 *      změnilo, co dnes chybí, další krok, top 3 workflow akce.
 *   3. Sekce „Řízení" — plný workflow (existující CrisisDailyManagement + Q/A).
 *   4. Sekce „Uzavření" — closure workflow.
 *   5. Sekce „Historie" — journal timeline.
 *
 * Sekce „Audit" je natrvalo pryč (technický inspect patří do Adminu).
 */
import React, { useEffect, useMemo, useState } from "react";
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
} from "lucide-react";

import {
  useCrisisOperationalState,
  type CrisisOperationalCard,
} from "@/hooks/useCrisisOperationalState";
import { useCrisisDetail } from "@/contexts/CrisisDetailContext";

import CrisisDailyManagement from "./CrisisDailyManagement";
import CrisisSessionQA from "./CrisisSessionQA";
import CrisisClosureWorkflow from "./CrisisClosureWorkflow";
import CrisisHistoryTimeline, { type JournalEntry } from "./CrisisHistoryTimeline";

type TabKey = "overview" | "management" | "closure" | "history";

const TABS: { key: TabKey; label: string; hint: string }[] = [
  { key: "overview", label: "Přehled", hint: "okamžitá orientace" },
  { key: "management", label: "Řízení", hint: "denní workflow" },
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

async function callFn(fnName: string, body: Record<string, any>) {
  const projectId = import.meta.env.VITE_SUPABASE_PROJECT_ID;
  const session = (await supabase.auth.getSession()).data.session;
  const res = await fetch(`https://${projectId}.supabase.co/functions/v1/${fnName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const payload = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(payload?.error || `HTTP ${res.status}`);
  return payload;
}

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
    if (!card?.alertId) return;
    setAckLoading(true);
    try {
      const data = await callFn("karel-crisis-closure-meeting", {
        action: "acknowledge_alert",
        alert_id: card.alertId,
      });
      if (data.success) {
        toast.success("Alert vzat na vědomí");
        refetch();
      } else {
        toast.error(data.error || "Chyba při potvrzení");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Chyba při potvrzení");
    } finally {
      setAckLoading(false);
    }
  };

  const isOpen = !!activeCardId;

  return (
    <Sheet open={isOpen} onOpenChange={(o) => { if (!o) closeCrisisDetail(); }}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-[640px] p-0 flex flex-col overflow-hidden bg-background"
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
              {TABS.map((t) => (
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

            <div className="flex-1 overflow-y-auto p-5">
              {activeTab === "overview" && (
                <CrisisOverviewSection card={card} onJumpToManagement={() => setActiveTab("management")} />
              )}
              {activeTab === "management" && (
                <div className="space-y-5">
                  <CrisisDailyManagement card={card} onRefetch={refetch} />
                  <CrisisSessionQA card={card} onRefetch={refetch} />
                </div>
              )}
              {activeTab === "closure" && <CrisisClosureWorkflow card={card} onRefetch={refetch} />}
              {activeTab === "history" && <CrisisHistoryTimeline card={card} journalEntries={journalEntries} />}
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
            Pracovní plocha pro řízení této krize. Workflow akce zde, ne v banneru.
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
          <span className="inline-flex items-center gap-1 text-amber-700">
            <Clock className="w-3 h-3" />
            {Math.round(card.hoursStale)}h bez kontaktu
          </span>
        )}
        {card.primaryTherapist && card.primaryTherapist !== "neurčeno" && (
          <span className="inline-flex items-center gap-1">
            <Users className="w-3 h-3" />
            vede: <strong className="text-foreground">{card.primaryTherapist}</strong>
            {card.secondaryTherapist && (
              <> · podpora: <strong className="text-foreground">{card.secondaryTherapist}</strong></>
            )}
          </span>
        )}
        {card.alertId && (
          <button
            onClick={onAcknowledge}
            disabled={ackLoading}
            className="ml-auto inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded text-muted-foreground hover:text-primary transition-colors disabled:opacity-50"
            title="Vzít alert na vědomí"
          >
            {ackLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle className="w-3 h-3" />}
            Vzít na vědomí
          </button>
        )}
      </div>
    </SheetHeader>
  );
};

// ── Overview section (instant orientation) ────────────────────────────────

const CrisisOverviewSection: React.FC<{
  card: CrisisOperationalCard;
  onJumpToManagement: () => void;
}> = ({ card, onJumpToManagement }) => {
  const mainProblem =
    card.mainBlocker ||
    card.triggerDescription ||
    card.clinicalSummary ||
    card.displaySummary ||
    "Není zaznamenán hlavní problém.";

  const lastChange =
    card.lastEntrySummary ||
    card.lastInterventionType
      ? `Poslední zásah: ${card.lastInterventionType ?? "—"}${
          card.lastInterventionWorked === true
            ? " · zafungoval"
            : card.lastInterventionWorked === false
              ? " · nezafungoval"
              : ""
        }`
      : "Žádná nedávná změna nebyla zaznamenána.";

  const deficits: string[] = [];
  if (card.missingTodayInterview) deficits.push("Chybí dnešní hodnocení (Karel ještě nevedl interview).");
  if (card.missingTherapistFeedback) deficits.push("Čekáme na feedback terapeutek.");
  if (card.missingSessionResult) deficits.push("Chybí výsledek posledního zásahu.");
  if (card.isStale) deficits.push(`Dlouho bez kontaktu (${Math.round(card.hoursStale)}h).`);

  const nextStep =
    card.karelRequires?.[0] ||
    (card.computedCTAs?.[0]?.label
      ? `Karel doporučuje: ${card.computedCTAs[0].label}.`
      : "Žádný explicitní další krok není definovaný — otevři Řízení.");

  return (
    <div className="space-y-4">
      {/* Hlavní problém */}
      <section className="rounded-lg border border-border bg-card/50 p-3.5 space-y-1">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Hlavní problém</div>
        <p className="text-sm leading-relaxed text-foreground">{mainProblem}</p>
      </section>

      {/* Co se změnilo */}
      <section className="rounded-lg border border-border bg-card/50 p-3.5 space-y-1">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Co se změnilo</div>
        <p className="text-sm leading-relaxed text-foreground">{lastChange}</p>
      </section>

      {/* Co dnes chybí */}
      <section className="rounded-lg border border-border bg-card/50 p-3.5 space-y-1.5">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Co dnes chybí</div>
        {deficits.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">Žádné aktivní deficity.</p>
        ) : (
          <ul className="space-y-1">
            {deficits.map((d, i) => (
              <li key={i} className="text-sm text-foreground flex items-start gap-2">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 text-amber-700 shrink-0" />
                <span>{d}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Další krok */}
      <section className="rounded-lg border border-primary/30 bg-primary/5 p-3.5 space-y-2">
        <div className="text-[10px] uppercase tracking-wide text-primary">Další krok</div>
        <p className="text-sm leading-relaxed text-foreground">{nextStep}</p>
        <button
          onClick={onJumpToManagement}
          className="inline-flex items-center gap-1.5 text-[12px] px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          Přejít na Řízení <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </section>

      {/* Top 3 workflow akce — náhled, vlastní spuštění je v Řízení */}
      {card.computedCTAs && card.computedCTAs.length > 0 && (
        <section className="rounded-lg border border-border bg-card/40 p-3.5 space-y-2">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Hlavní workflow akce</div>
          <ul className="space-y-1">
            {card.computedCTAs.slice(0, 3).map((cta) => (
              <li key={cta.key} className="text-[12px] text-foreground flex items-center gap-2">
                {iconForCta(cta.action)}
                <span>{cta.label}</span>
                <span className="text-[10px] text-muted-foreground ml-auto">{cta.priority}</span>
              </li>
            ))}
          </ul>
          <p className="text-[10px] text-muted-foreground italic pt-1 border-t border-border/50">
            Spuštění proveď v záložce Řízení.
          </p>
        </section>
      )}
    </div>
  );
};

function iconForCta(action: string): React.ReactNode {
  switch (action) {
    case "start_interview":
      return <Play className="w-3.5 h-3.5 text-muted-foreground" />;
    case "request_feedback":
      return <ClipboardList className="w-3.5 h-3.5 text-muted-foreground" />;
    case "open_meeting":
      return <Handshake className="w-3.5 h-3.5 text-muted-foreground" />;
    default:
      return <ArrowRight className="w-3.5 h-3.5 text-muted-foreground" />;
  }
}

export default CrisisDetailWorkspace;

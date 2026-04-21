import React, { useState, useEffect } from "react";
import { CheckCircle, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { CrisisOperationalCard } from "@/hooks/useCrisisOperationalState";
import CrisisDailyManagement from "./CrisisDailyManagement";
import CrisisSessionQA from "./CrisisSessionQA";
import CrisisClosureWorkflow from "./CrisisClosureWorkflow";
import CrisisHistoryTimeline, { type JournalEntry } from "./CrisisHistoryTimeline";

interface Props {
  card: CrisisOperationalCard;
  onRefetch: () => void;
  initialTab?: TabKey;
}

type TabKey = "management" | "closure" | "history";

const TABS: { key: TabKey; label: string }[] = [
  { key: "management", label: "Řízení" },
  { key: "closure", label: "Uzavření" },
  { key: "history", label: "Historie" },
];

/**
 * CrisisOperationalDetail — Crisis Function Reallocation Repair Pass (2026-04-21).
 *
 * Změny:
 *   - Odstraněn `Audit` tab (technický inspect: card propagation, 05A sync)
 *     → tato low-level technická data patří do Admin / Inspect, ne do
 *       klinické krizové karty.
 *   - `Acknowledge alert` přesunut do hlavičky detailu (vedle tab baru)
 *     → zůstává operativní akce, ale není zamíchaná v technickém auditu.
 *   - Detail má teď tři klinicky smysluplné záložky: Řízení / Uzavření / Historie.
 */

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

const CrisisOperationalDetail: React.FC<Props> = ({ card, onRefetch, initialTab }) => {
  const [activeTab, setActiveTab] = useState<TabKey>(initialTab || "management");
  const [journalEntries, setJournalEntries] = useState<JournalEntry[]>([]);
  const [ackLoading, setAckLoading] = useState(false);

  useEffect(() => {
    if (initialTab) setActiveTab(initialTab);
  }, [initialTab]);

  // Lazy-load journal entries when history tab is activated
  useEffect(() => {
    if (activeTab !== "history") return;
    if (!card.eventId && !card.alertId) {
      setJournalEntries([]);
      return;
    }

    let cancelled = false;
    setJournalEntries([]);

    const load = async () => {
      const query = supabase
        .from("crisis_journal")
        .select("id, date, day_number, karel_action, karel_notes, session_summary, what_worked, what_failed, crisis_trend")
        .order("date", { ascending: false })
        .limit(50);

      if (card.eventId) {
        query.eq("crisis_event_id", card.eventId);
      } else if (card.alertId) {
        query.eq("crisis_alert_id", card.alertId);
      }

      const { data } = await query;
      if (!cancelled && data) {
        setJournalEntries(data.map((j: any) => ({
          id: j.id,
          date: j.date,
          dayNumber: j.day_number,
          karelAction: j.karel_action,
          karelNotes: j.karel_notes,
          sessionSummary: j.session_summary,
          whatWorked: j.what_worked,
          whatFailed: j.what_failed,
          crisisTrend: j.crisis_trend,
        })));
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [activeTab, card.eventId, card.alertId]);

  const handleAcknowledge = async () => {
    if (!card.alertId) return;
    setAckLoading(true);
    try {
      const data = await callFn("karel-crisis-closure-meeting", {
        action: "acknowledge_alert",
        alert_id: card.alertId,
      });
      if (data.success) {
        toast.success("Alert vzat na vědomí");
        onRefetch();
      } else {
        toast.error(data.error || "Chyba při potvrzení");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Chyba při potvrzení");
    } finally {
      setAckLoading(false);
    }
  };

  return (
    <div className="border-x border-b rounded-b-lg mx-2 mb-1 bg-background shadow-lg" style={{ borderColor: "#7C2D2D30" }}>
      {/* Tab bar + acknowledge action */}
      <div className="flex items-stretch border-b text-xs">
        {TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex-1 py-2 font-medium transition-colors ${activeTab === tab.key ? "bg-primary/10 text-primary border-b-2 border-primary" : "text-muted-foreground hover:text-foreground"}`}
          >
            {tab.label}
          </button>
        ))}
        {card.alertId && (
          <button
            onClick={handleAcknowledge}
            disabled={ackLoading}
            className="px-3 py-2 flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-primary transition-colors disabled:opacity-50 border-l"
            title="Vzít alert na vědomí"
          >
            {ackLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle className="w-3 h-3" />}
            Vzít na vědomí
          </button>
        )}
      </div>

      <div className="p-4 max-h-[60vh] overflow-y-auto">
        {activeTab === "management" && (
          <div className="space-y-4">
            <CrisisDailyManagement card={card} onRefetch={onRefetch} />
            <CrisisSessionQA card={card} onRefetch={onRefetch} />
          </div>
        )}
        {activeTab === "closure" && <CrisisClosureWorkflow card={card} onRefetch={onRefetch} />}
        {activeTab === "history" && <CrisisHistoryTimeline card={card} journalEntries={journalEntries} />}
      </div>
    </div>
  );
};

export default CrisisOperationalDetail;

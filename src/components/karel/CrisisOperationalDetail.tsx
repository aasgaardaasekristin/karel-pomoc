import React, { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { CrisisOperationalCard } from "@/hooks/useCrisisOperationalState";
import CrisisDailyManagement from "./CrisisDailyManagement";
import CrisisSessionQA from "./CrisisSessionQA";
import CrisisClosureWorkflow from "./CrisisClosureWorkflow";
import CrisisAuditPanel from "./CrisisAuditPanel";
import CrisisHistoryTimeline, { type JournalEntry } from "./CrisisHistoryTimeline";

interface Props {
  card: CrisisOperationalCard;
  onRefetch: () => void;
  initialTab?: TabKey;
}

type TabKey = "management" | "closure" | "history" | "audit";

const TABS: { key: TabKey; label: string }[] = [
  { key: "management", label: "Řízení" },
  { key: "closure", label: "Uzavření" },
  { key: "history", label: "Historie" },
  { key: "audit", label: "Audit" },
];

const CrisisOperationalDetail: React.FC<Props> = ({ card, onRefetch, initialTab }) => {
  const [activeTab, setActiveTab] = useState<TabKey>(initialTab || "management");
  const [journalEntries, setJournalEntries] = useState<JournalEntry[]>([]);

  useEffect(() => {
    if (initialTab) setActiveTab(initialTab);
  }, [initialTab]);

  // Lazy-load journal entries when history tab is activated
  useEffect(() => {
    if (activeTab !== "history") return;
    if (!card.eventId && !card.alertId) return;

    const load = async () => {
      const query = supabase
        .from("crisis_journal")
        .select("id, date, day_number, karel_action, session_summary, what_worked, what_failed, crisis_trend")
        .order("date", { ascending: false })
        .limit(50);

      if (card.eventId) {
        query.eq("crisis_event_id", card.eventId);
      } else if (card.alertId) {
        query.eq("crisis_alert_id", card.alertId);
      }

      const { data } = await query;
      if (data) {
        setJournalEntries(data.map((j: any) => ({
          id: j.id,
          date: j.date,
          dayNumber: j.day_number,
          karelAction: j.karel_action,
          sessionSummary: j.session_summary,
          whatWorked: j.what_worked,
          whatFailed: j.what_failed,
          crisisTrend: j.crisis_trend,
        })));
      }
    };
    load();
  }, [activeTab, card.eventId, card.alertId]);

  return (
    <div className="border-x border-b rounded-b-lg mx-2 mb-1 bg-background shadow-lg" style={{ borderColor: "#7C2D2D30" }}>
      {/* Tab bar */}
      <div className="flex border-b text-xs">
        {TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex-1 py-2 font-medium transition-colors ${activeTab === tab.key ? "bg-primary/10 text-primary border-b-2 border-primary" : "text-muted-foreground hover:text-foreground"}`}
          >
            {tab.label}
          </button>
        ))}
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
        {activeTab === "audit" && <CrisisAuditPanel card={card} onRefetch={onRefetch} />}
      </div>
    </div>
  );
};

export default CrisisOperationalDetail;

import React from "react";
import { Clock, Brain, FileText, Users, CheckCircle, ArrowRight } from "lucide-react";
import type { CrisisOperationalCard } from "@/hooks/useCrisisOperationalState";

/**
 * CrisisHistoryTimeline — renders only concrete history records that the UI really has.
 * Sources: interviews, answered post-session cycles, crisis_journal entries, closure meeting milestones.
 *
 * Historical operating-state transitions are not inferred or fabricated here,
 * because there is no dedicated transition log in the current data model.
 * Daily crisis_journal records are rendered explicitly as the documentary history layer.
 */

interface Props {
  card: CrisisOperationalCard;
  /** Optional journal entries loaded from crisis_journal table */
  journalEntries?: JournalEntry[];
}

export interface JournalEntry {
  id: string;
  date: string;
  dayNumber: number | null;
  karelAction: string | null;
  karelNotes?: string | null;
  sessionSummary: string | null;
  whatWorked: string | null;
  whatFailed: string | null;
  crisisTrend: string | null;
}

interface TimelineEvent {
  date: string;
  type: "interview" | "session_qa" | "journal" | "meeting" | "closure";
  title: string;
  detail: string | null;
  icon: React.ReactNode;
}

const TYPE_COLORS: Record<string, string> = {
  interview: "border-blue-300 dark:border-blue-700",
  session_qa: "border-purple-300 dark:border-purple-700",
  journal: "border-amber-300 dark:border-amber-700",
  meeting: "border-green-300 dark:border-green-700",
  closure: "border-green-500 dark:border-green-500",
};

const CrisisHistoryTimeline: React.FC<Props> = ({ card, journalEntries = [] }) => {
  const events: TimelineEvent[] = [];

  // Interviews
  for (const iv of card.interviews) {
    events.push({
      date: iv.startedAt || iv.completedAt || "",
      type: "interview",
      title: `Krizový rozhovor (${iv.interviewType})`,
      detail: iv.summaryForTeam || iv.karelDecision || null,
      icon: <Brain className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />,
    });
  }

  // Session Q/A entries (answered ones)
  const answeredQs = card.sessionQuestions.filter(q => q.answeredAt);
  if (answeredQs.length > 0) {
    const byDate = new Map<string, typeof answeredQs>();
    for (const q of answeredQs) {
      const d = (q.answeredAt || "").slice(0, 10);
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d)!.push(q);
    }
    for (const [date, qs] of byDate) {
      const withAnalysis = qs.find(q => q.karelAnalysis);
      events.push({
        date: date + "T12:00:00Z",
        type: "session_qa",
        title: `Post-session Q/A (${qs.length} odpovědí)`,
        detail: withAnalysis?.karelAnalysis?.slice(0, 200) || null,
        icon: <FileText className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400" />,
      });
    }
  }

  // Journal entries (concrete documentary history, not inferred transitions)
  for (const je of journalEntries) {
    const parts: string[] = [];
    if (je.karelAction) parts.push(je.karelAction);
    if (je.crisisTrend) parts.push(`trend: ${je.crisisTrend}`);
    if (je.whatWorked) parts.push(`✓ ${je.whatWorked}`);
    if (je.whatFailed) parts.push(`✗ ${je.whatFailed}`);
    if (je.karelNotes) parts.push(`pozn.: ${je.karelNotes}`);

    events.push({
      date: je.date ? je.date + "T12:00:00Z" : "",
      type: "journal",
      title: `Journal den ${je.dayNumber ?? "?"} — ${je.sessionSummary?.slice(0, 60) || "denní záznam"}`,
      detail: parts.join(" · ") || null,
      icon: <ArrowRight className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />,
    });
  }

  // Closure meeting
  if (card.closureMeeting) {
    events.push({
      date: card.closureMeeting.createdAt || "",
      type: "meeting",
      title: "Closure meeting založen",
      detail: card.closureMeeting.topic || null,
      icon: <Users className="w-3.5 h-3.5 text-green-600 dark:text-green-400" />,
    });
    if (card.closureMeeting.finalizedAt) {
      events.push({
        date: card.closureMeeting.finalizedAt,
        type: "closure",
        title: "Closure meeting finalizován",
        detail: card.closureMeeting.closureRecommendation || null,
        icon: <CheckCircle className="w-3.5 h-3.5 text-green-600 dark:text-green-400" />,
      });
    }
  }

  // Sort by date desc
  events.sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  if (events.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground text-xs">
        Zatím žádné záznamy v historii.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <h3 className="text-xs font-bold text-foreground flex items-center gap-1.5">
        <Clock className="w-3.5 h-3.5" />
        Historie krize a journal ({events.length} záznamů)
      </h3>

      <div className="space-y-1.5">
        {events.map((ev, i) => (
          <div key={i} className={`border-l-2 ${TYPE_COLORS[ev.type] || "border-muted"} pl-3 py-1.5`}>
            <div className="flex items-center gap-2 text-[11px]">
              {ev.icon}
              <span className="font-medium text-foreground">{ev.title}</span>
              {ev.date && (
                <span className="text-[10px] text-muted-foreground ml-auto">
                  {new Date(ev.date).toLocaleDateString("cs-CZ")}
                </span>
              )}
            </div>
            {ev.detail && (
              <p className="text-[10px] text-muted-foreground mt-0.5 max-h-16 overflow-y-auto whitespace-pre-wrap">
                {ev.detail}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default CrisisHistoryTimeline;

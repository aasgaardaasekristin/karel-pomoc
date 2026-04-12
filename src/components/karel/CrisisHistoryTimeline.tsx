import React from "react";
import { Clock, Brain, FileText, Users, CheckCircle } from "lucide-react";
import type { CrisisOperationalCard } from "@/hooks/useCrisisOperationalState";

/**
 * CrisisHistoryTimeline — Documentary layer, separated from operational detail.
 * Shows: interviews, post-session analyses, state transitions, meeting milestones, closure summary.
 */

interface Props {
  card: CrisisOperationalCard;
}

interface TimelineEvent {
  date: string;
  type: "interview" | "session_qa" | "state" | "meeting" | "closure";
  title: string;
  detail: string | null;
  icon: React.ReactNode;
}

const TYPE_COLORS: Record<string, string> = {
  interview: "border-blue-300 dark:border-blue-700",
  session_qa: "border-purple-300 dark:border-purple-700",
  state: "border-amber-300 dark:border-amber-700",
  meeting: "border-green-300 dark:border-green-700",
  closure: "border-green-500 dark:border-green-500",
};

const CrisisHistoryTimeline: React.FC<Props> = ({ card }) => {
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
    // Group by date
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
        Historie krizového vedení ({events.length} záznamů)
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

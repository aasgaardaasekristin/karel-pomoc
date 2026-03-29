import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import CrisisTherapistFeedback from "./CrisisTherapistFeedback";

interface CrisisTimelineProps {
  crisisAlertId: string;
  partName: string;
  onRunAssessment?: () => void;
  isAssessing?: boolean;
}

interface Assessment {
  id: string;
  day_number: number;
  assessment_date: string;
  part_interview_summary: string | null;
  part_emotional_state: number | null;
  part_cooperation_level: string | null;
  karel_risk_assessment: string | null;
  karel_reasoning: string | null;
  karel_decision: string | null;
  tests_administered: any[] | null;
  next_day_plan: any;
  therapist_hana_input: string | null;
  therapist_hana_risk_rating: number | null;
  therapist_kata_input: string | null;
  therapist_kata_risk_rating: number | null;
}

const RISK_COLORS: Record<string, string> = {
  critical: "bg-red-500 text-white",
  high: "bg-orange-500 text-white",
  moderate: "bg-amber-500 text-white",
  low: "bg-blue-500 text-white",
  minimal: "bg-green-500 text-white",
};

const DECISION_LABELS: Record<string, { emoji: string; label: string }> = {
  crisis_continues: { emoji: "🔴", label: "Trvá" },
  crisis_improving: { emoji: "📈", label: "Zlepšení" },
  crisis_resolved: { emoji: "✅", label: "Vyřešeno" },
  needs_more_data: { emoji: "❓", label: "Potřeba dat" },
};

const CrisisTimeline = ({ crisisAlertId, partName, onRunAssessment, isAssessing }: CrisisTimelineProps) => {
  const [assessments, setAssessments] = useState<Assessment[]>([]);
  const [loading, setLoading] = useState(true);
  const [showFeedback, setShowFeedback] = useState<string | null>(null);

  const reloadAssessments = () => {
    (supabase as any)
      .from("crisis_daily_assessments")
      .select("*")
      .eq("crisis_alert_id", crisisAlertId)
      .order("day_number", { ascending: true })
      .then(({ data }: any) => {
        setAssessments(data || []);
        setLoading(false);
      });
  };

  useEffect(() => {
    reloadAssessments();
  }, [crisisAlertId]);

  if (loading) {
    return <div className="p-2 text-[10px] text-muted-foreground animate-pulse">Načítám timeline...</div>;
  }

  if (assessments.length === 0 && !onRunAssessment) return null;

  return (
    <div className="mt-2 space-y-1">
      {assessments.length > 0 && (
        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Krizová timeline — {partName}</p>
      )}

      <div className="relative pl-4 border-l-2 border-muted space-y-2">
        {assessments.map((a) => {
          const dec = DECISION_LABELS[a.karel_decision || ""] || { emoji: "❔", label: a.karel_decision || "?" };
          const riskClass = RISK_COLORS[a.karel_risk_assessment || ""] || "bg-muted text-foreground";
          const tests = Array.isArray(a.tests_administered) ? a.tests_administered : [];

          return (
            <div key={a.id} className="relative">
              {/* Timeline dot */}
              <div className={cn(
                "absolute -left-[calc(0.5rem+5px)] top-1 w-2.5 h-2.5 rounded-full border-2 border-background",
                a.karel_decision === "crisis_resolved" ? "bg-green-500" : a.karel_decision === "crisis_improving" ? "bg-amber-400" : "bg-red-500"
              )} />

              <div className="rounded-md border p-2 text-xs space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-bold text-foreground">Den {a.day_number}</span>
                  <span className="text-[10px] text-muted-foreground">
                    {new Date(a.assessment_date + "T12:00:00").toLocaleDateString("cs")}
                  </span>
                  <Badge className={cn("text-[8px] h-4 px-1", riskClass)}>{a.karel_risk_assessment}</Badge>
                  <span className="text-[10px]">{dec.emoji} {dec.label}</span>
                </div>

                {a.part_interview_summary && (
                  <div className="max-h-32 overflow-y-auto text-[10px] text-muted-foreground whitespace-pre-wrap">
                    {a.part_interview_summary}
                  </div>
                )}

                <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                  {a.part_emotional_state != null && (
                    <span>
                      Emoce: {a.part_emotional_state}/10 {a.part_emotional_state >= 7 ? "😊" : a.part_emotional_state >= 4 ? "😐" : "😟"}
                    </span>
                  )}
                  {a.part_cooperation_level && <span>Spolupráce: {a.part_cooperation_level}</span>}
                </div>

                {tests.length > 0 && (
                  <p className="text-[10px] text-muted-foreground">
                    🧪 {tests.map((t: any) => t.test_name || t).join(", ")}
                  </p>
                )}

                {a.karel_reasoning && (
                  <div className="max-h-24 overflow-y-auto text-[10px] italic text-muted-foreground border-l-2 border-muted pl-2 whitespace-pre-wrap">
                    "{a.karel_reasoning}"
                  </div>
                )}

                {/* Therapist feedback buttons */}
                <div className="flex gap-2 mt-1">
                  {!a.therapist_hana_input ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-[10px] h-6"
                      onClick={() => setShowFeedback(showFeedback === `${a.id}-hana` ? null : `${a.id}-hana`)}
                    >
                      📝 Hanička
                    </Button>
                  ) : (
                    <span className="text-[10px] text-green-600 dark:text-green-400">
                      ✅ Hanička (risk: {a.therapist_hana_risk_rating}/10)
                    </span>
                  )}

                  {!a.therapist_kata_input ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-[10px] h-6"
                      onClick={() => setShowFeedback(showFeedback === `${a.id}-kata` ? null : `${a.id}-kata`)}
                    >
                      📝 Káťa
                    </Button>
                  ) : (
                    <span className="text-[10px] text-green-600 dark:text-green-400">
                      ✅ Káťa (risk: {a.therapist_kata_risk_rating}/10)
                    </span>
                  )}
                </div>

                {/* Expanded feedback form */}
                {showFeedback === `${a.id}-hana` && (
                  <CrisisTherapistFeedback
                    crisisAlertId={crisisAlertId}
                    partName={partName}
                    dayNumber={a.day_number}
                    assessmentId={a.id}
                    therapistName="hana"
                    onSubmitted={() => {
                      setShowFeedback(null);
                      reloadAssessments();
                    }}
                  />
                )}
                {showFeedback === `${a.id}-kata` && (
                  <CrisisTherapistFeedback
                    crisisAlertId={crisisAlertId}
                    partName={partName}
                    dayNumber={a.day_number}
                    assessmentId={a.id}
                    therapistName="kata"
                    onSubmitted={() => {
                      setShowFeedback(null);
                      reloadAssessments();
                    }}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>

      {onRunAssessment && (
        <Button
          size="sm"
          variant="outline"
          className="w-full text-[10px] h-7"
          onClick={onRunAssessment}
          disabled={isAssessing}
        >
          {isAssessing ? "Hodnotím..." : `Spustit hodnocení (den ${assessments.length + 1})`}
        </Button>
      )}
    </div>
  );
};

export default CrisisTimeline;

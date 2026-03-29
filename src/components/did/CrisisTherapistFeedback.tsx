import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface CrisisTherapistFeedbackProps {
  crisisAlertId: string;
  partName: string;
  dayNumber: number;
  assessmentId: string;
  therapistName: "hana" | "kata";
  onSubmitted?: () => void;
}

const CrisisTherapistFeedback = ({
  crisisAlertId,
  partName,
  dayNumber,
  assessmentId,
  therapistName,
  onSubmitted,
}: CrisisTherapistFeedbackProps) => {
  const [observation, setObservation] = useState("");
  const [riskRating, setRiskRating] = useState(5);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [questions, setQuestions] = useState<string[]>([]);
  const [tasks, setTasks] = useState<string[]>([]);

  useEffect(() => {
    (supabase as any)
      .from("crisis_daily_assessments")
      .select("*")
      .eq("id", assessmentId)
      .single()
      .then(({ data }: any) => {
        if (!data) return;
        const plan = data.next_day_plan || {};
        const tests = Array.isArray(data.tests_administered) ? data.tests_administered : [];

        const allQ: string[] = [];
        if (Array.isArray(plan.therapist_tasks)) {
          allQ.push(...plan.therapist_tasks);
        }
        setQuestions(allQ);
        setTasks(
          tests.map((t: any) => `Test: ${t.test_name || t} — ${t.description || ""}`)
        );
      });
  }, [assessmentId, therapistName]);

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      const fieldPrefix = therapistName === "hana" ? "therapist_hana" : "therapist_kata";

      const inputText = Object.entries(answers)
        .map(([i, a]) => `Otázka ${Number(i) + 1}: ${a}`)
        .join("\n");

      await (supabase as any)
        .from("crisis_daily_assessments")
        .update({
          [`${fieldPrefix}_input`]: inputText,
          [`${fieldPrefix}_observation`]: observation,
          [`${fieldPrefix}_risk_rating`]: riskRating,
        })
        .eq("id", assessmentId);

      setSubmitted(true);
      onSubmitted?.();
      toast.success(
        `Zpětná vazba od ${therapistName === "hana" ? "Haničky" : "Káti"} uložena`
      );
    } catch (e: any) {
      toast.error(`Chyba: ${e.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <div className="p-3 bg-green-500/10 border border-green-500/20 rounded-lg text-sm text-green-700 dark:text-green-300">
        ✅ Zpětná vazba uložena. Děkuji, {therapistName === "hana" ? "Haničko" : "Káťo"}!
      </div>
    );
  }

  return (
    <div className="space-y-3 p-3 border border-border/50 rounded-lg bg-muted/20">
      <p className="font-semibold text-sm">
        📋 Zpětná vazba — {therapistName === "hana" ? "Hanička" : "Káťa"} (den {dayNumber})
      </p>

      {questions.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">Otázky od Karla:</p>
          {questions.map((q, i) => (
            <div key={i} className="space-y-1">
              <p className="text-xs font-medium">{i + 1}. {q}</p>
              <textarea
                value={answers[i] || ""}
                onChange={(e) => setAnswers((prev) => ({ ...prev, [i]: e.target.value }))}
                className="w-full text-xs p-2 rounded border border-border bg-background min-h-[60px] resize-y"
                placeholder="Tvoje odpověď..."
              />
            </div>
          ))}
        </div>
      )}

      {tasks.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">📝 Úkoly k provedení:</p>
          {tasks.map((t, i) => (
            <p key={i} className="text-[11px] p-1.5 bg-muted/30 rounded">{t}</p>
          ))}
        </div>
      )}

      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">Tvoje pozorování:</p>
        <textarea
          value={observation}
          onChange={(e) => setObservation(e.target.value)}
          className="w-full text-xs p-2 rounded border border-border bg-background min-h-[80px] resize-y"
          placeholder={`Co jsi pozorovala u ${partName}? Změny v chování, náladě, komunikaci...`}
        />
      </div>

      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">
          Hodnocení rizika (1 = minimální, 10 = kritické): <strong>{riskRating}</strong>
        </p>
        <input
          type="range"
          min="1"
          max="10"
          value={riskRating}
          onChange={(e) => setRiskRating(Number(e.target.value))}
          className="w-full accent-primary"
        />
        <div className="flex justify-between text-[9px] text-muted-foreground">
          <span>1 — klidná</span>
          <span>5 — nejistá</span>
          <span>10 — kritická</span>
        </div>
      </div>

      <Button
        onClick={handleSubmit}
        disabled={submitting || !observation.trim()}
        size="sm"
        className="w-full"
      >
        {submitting ? "Ukládám..." : "Odeslat zpětnou vazbu"}
      </Button>
    </div>
  );
};

export default CrisisTherapistFeedback;

import { useCallback, useEffect, useState } from "react";
import { MessageCircleQuestion, Send, Clock, CheckCircle2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { KarelCard } from "@/components/ui/KarelCard";
import { KarelBadge } from "@/components/ui/KarelBadge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface PendingQuestion {
  id: string;
  question: string;
  subject_type: string | null;
  subject_id: string | null;
  directed_to: string | null;
  status: string | null;
  created_at: string;
  expires_at: string | null;
  context: string | null;
  answer: string | null;
  answered_at: string | null;
  answered_by: string | null;
  crisis_event_id: string | null;
}

interface Props {
  refreshTrigger?: number;
}

const PendingQuestionsPanel = ({ refreshTrigger }: Props) => {
  const [questions, setQuestions] = useState<PendingQuestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [answeringId, setAnsweringId] = useState<string | null>(null);
  const [answerText, setAnswerText] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const loadQuestions = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from("did_pending_questions")
        .select("*")
        .in("status", ["pending", "sent"])
        .order("created_at", { ascending: false })
        .limit(20);

      if (error) throw error;
      setQuestions((data as PendingQuestion[]) || []);
    } catch (e) {
      console.error("[PendingQuestions] Load error:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadQuestions();
  }, [loadQuestions, refreshTrigger]);

  const handleAnswer = async (questionId: string) => {
    if (!answerText.trim()) return;
    setSubmitting(true);
    try {
      const { error } = await supabase
        .from("did_pending_questions")
        .update({
          answer: answerText.trim(),
          answered_at: new Date().toISOString(),
          answered_by: "therapist",
          status: "answered",
        })
        .eq("id", questionId);

      if (error) throw error;
      toast.success("Odpověď uložena");
      setAnsweringId(null);
      setAnswerText("");
      loadQuestions();
    } catch (e) {
      console.error("[PendingQuestions] Answer error:", e);
      toast.error("Chyba při ukládání odpovědi");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return null;
  if (questions.length === 0) return null;

  const formatAge = (created: string) => {
    const hours = Math.floor((Date.now() - new Date(created).getTime()) / 3600000);
    if (hours < 1) return "právě teď";
    if (hours < 24) return `před ${hours}h`;
    return `před ${Math.floor(hours / 24)}d`;
  };

  const getDirectedLabel = (directed: string | null) => {
    if (directed === "hanka") return "Hanička";
    if (directed === "kata") return "Káťa";
    if (directed === "both") return "Obě";
    return directed || "—";
  };

  return (
    <KarelCard variant="default" padding="md">
      <div className="flex items-center gap-2 mb-3">
        <MessageCircleQuestion size={14} className="text-primary" />
        <span className="text-sm font-medium text-foreground">Karel se ptá</span>
        <KarelBadge variant="info" size="sm">
          {questions.length}
        </KarelBadge>
      </div>

      <div className="space-y-3">
        {questions.map((q) => {
          const isExpired = q.expires_at && new Date(q.expires_at) < new Date();
          const isAnswering = answeringId === q.id;

          return (
            <div
              key={q.id}
              className={cn(
                "rounded-lg border p-3 text-sm transition-colors",
                isExpired
                  ? "border-muted bg-muted/30 opacity-60"
                  : "border-border bg-card hover:bg-accent/5"
              )}
            >
              <div className="flex items-start justify-between gap-2 mb-1.5">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Clock size={10} />
                  <span>{formatAge(q.created_at)}</span>
                  <span>•</span>
                  <span>Pro: {getDirectedLabel(q.directed_to)}</span>
                  {q.subject_type && (
                    <>
                      <span>•</span>
                      <KarelBadge variant={q.subject_type === "crisis_closure" ? "warning" : "default"} size="sm">
                        {q.subject_type}
                      </KarelBadge>
                    </>
                  )}
                  {q.crisis_event_id && (
                    <>
                      <span>•</span>
                      <KarelBadge variant="warning" size="sm">krize</KarelBadge>
                    </>
                  )}
                </div>
                {isExpired && (
                  <KarelBadge variant="default" size="sm">Expirováno</KarelBadge>
                )}
              </div>

              <p className="text-foreground leading-relaxed whitespace-pre-line mb-2">
                {q.question}
              </p>

              {q.answer ? (
                <div className="flex items-start gap-1.5 text-xs text-primary bg-primary/10 rounded p-2">
                  <CheckCircle2 size={12} className="mt-0.5 shrink-0" />
                  <span>{q.answer}</span>
                </div>
              ) : !isExpired && (
                <>
                  {isAnswering ? (
                    <div className="space-y-2">
                      <Textarea
                        value={answerText}
                        onChange={(e) => setAnswerText(e.target.value)}
                        placeholder="Vaše odpověď..."
                        className="text-sm min-h-[60px]"
                        autoFocus
                      />
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          onClick={() => handleAnswer(q.id)}
                          disabled={submitting || !answerText.trim()}
                        >
                          <Send size={12} className="mr-1" />
                          Odeslat
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => { setAnsweringId(null); setAnswerText(""); }}
                        >
                          Zrušit
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setAnsweringId(q.id)}
                      className="text-xs"
                    >
                      Odpovědět
                    </Button>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
    </KarelCard>
  );
};

export default PendingQuestionsPanel;

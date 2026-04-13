import React, { useState, useMemo } from "react";
import { CheckCircle, AlertTriangle, HelpCircle, Send, Loader2, Brain, ChevronDown, ChevronRight } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { CrisisOperationalCard } from "@/hooks/useCrisisOperationalState";

interface Props {
  card: CrisisOperationalCard;
  onRefetch: () => void;
}

async function callFn(fnName: string, body: Record<string, any>) {
  const projectId = import.meta.env.VITE_SUPABASE_PROJECT_ID;
  const session = (await supabase.auth.getSession()).data.session;
  const res = await fetch(`https://${projectId}.supabase.co/functions/v1/${fnName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}) },
    body: JSON.stringify(body),
  });
  return res.json();
}

interface ParsedAnalysis {
  date: string;
  intervention_effectiveness?: string;
  stabilization_trend?: string;
  main_risk?: string;
  next_action?: string;
  karel_recommendation?: string;
  needs_follow_up_session?: boolean;
  needs_crisis_meeting?: boolean;
  prepare_closure?: boolean;
}

const CrisisSessionQA: React.FC<Props> = ({ card, onRefetch }) => {
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [answerInputs, setAnswerInputs] = useState<Record<string, string>>({});
  const [expandedAnalyses, setExpandedAnalyses] = useState<Record<string, boolean>>({});

  // Collect ALL analyses, grouped by date
  const allAnalyses = useMemo<ParsedAnalysis[]>(() => {
    const results: ParsedAnalysis[] = [];
    for (const q of card.sessionQuestions) {
      if (!q.karelAnalysis) continue;
      try {
        const parsed = JSON.parse(q.karelAnalysis);
        const date = q.karelAnalyzedAt?.slice(0, 10) || q.answeredAt?.slice(0, 10) || "unknown";
        results.push({ date, ...parsed });
      } catch {
        // skip unparseable
      }
    }
    // Deduplicate by date (keep latest per date)
    const byDate = new Map<string, ParsedAnalysis>();
    for (const a of results) {
      byDate.set(a.date, a); // later entry overwrites earlier
    }
    return Array.from(byDate.values()).sort((a, b) => b.date.localeCompare(a.date));
  }, [card.sessionQuestions]);

  if (card.sessionQuestions.length === 0) return null;

  const withLoading = async (key: string, fn: () => Promise<void>) => {
    setActionLoading(key);
    try { await fn(); } finally { setActionLoading(null); }
  };

  const handleSubmitQAAnswer = async (questionId: string) => {
    const answer = answerInputs[questionId];
    if (!answer?.trim()) return;
    await withLoading(`qa_${questionId}`, async () => {
      const data = await callFn("karel-crisis-session-loop", { action: "process_answer", question_id: questionId, answer_text: answer });
      if (data.success) {
        toast.success(data.analysis_triggered ? "Odpověď uložena + analýza spuštěna" : `Odpověď uložena (zbývá ${data.remaining})`);
        setAnswerInputs(prev => { const n = { ...prev }; delete n[questionId]; return n; });
        onRefetch();
      } else toast.error(data.error || "Chyba");
    });
  };

  return (
    <div className="bg-muted/30 rounded-lg p-3 space-y-2">
      <p className="text-xs font-bold text-foreground flex items-center gap-1.5">
        <HelpCircle className="w-3.5 h-3.5" />
        Otázky po sezení ({card.sessionQuestions.length - card.unansweredQuestionCount}/{card.sessionQuestions.length})
        {card.sessionQAComplete && <span className="text-[9px] bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300 px-1.5 rounded ml-1">kompletní</span>}
      </p>

      <div className="space-y-2 max-h-48 overflow-y-auto">
        {card.sessionQuestions.map(q => (
          <div key={q.id} className={`rounded-lg p-2 text-[11px] ${q.answeredAt ? "bg-green-50 dark:bg-green-950/20" : "bg-amber-50 dark:bg-amber-950/20"}`}>
            <div className="flex items-start gap-1.5">
              {q.answeredAt ? <CheckCircle className="w-3 h-3 text-green-600 shrink-0 mt-0.5" /> : <AlertTriangle className="w-3 h-3 text-amber-500 shrink-0 mt-0.5" />}
              <div className="flex-1">
                <p className="text-foreground font-medium">{q.questionText}</p>
                <p className="text-muted-foreground text-[10px]">{q.therapistName === "hanka" ? "Hanička" : "Káťa"}
                  {q.requiredBy && ` · deadline: ${new Date(q.requiredBy).toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" })}`}
                  {q.qualityScore != null && ` · kvalita: ${q.qualityScore}/10`}
                </p>
                {q.answeredAt && q.answerText && <p className="text-foreground mt-1 bg-background/50 rounded p-1.5">{q.answerText}</p>}
                {!q.answeredAt && (
                  <div className="flex gap-1 mt-1.5">
                    <input className="flex-1 text-[11px] px-2 py-1 rounded border bg-background text-foreground"
                      placeholder="Odpověď…" value={answerInputs[q.id] || ""}
                      onChange={e => setAnswerInputs(prev => ({ ...prev, [q.id]: e.target.value }))} />
                    <button onClick={() => handleSubmitQAAnswer(q.id)} disabled={actionLoading != null || !answerInputs[q.id]?.trim()}
                      className="text-[11px] px-2.5 py-1.5 rounded-md flex items-center gap-1.5 transition-colors disabled:opacity-50 bg-primary/10 text-primary hover:bg-primary/20">
                      {actionLoading === `qa_${q.id}` ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* All analyses – grouped by date, all shown */}
      {allAnalyses.length > 0 && (
        <div className="space-y-2">
          <p className="text-[11px] font-bold text-foreground flex items-center gap-1.5">
            <Brain className="w-3.5 h-3.5" />
            Karlovy analýzy ({allAnalyses.length})
          </p>
          {allAnalyses.map((analysis, idx) => {
            const key = `analysis_${analysis.date}_${idx}`;
            const isExpanded = expandedAnalyses[key] ?? (idx === 0); // first expanded by default
            return (
              <div key={key} className="bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 rounded p-2 space-y-1 text-[10px]">
                <button
                  onClick={() => setExpandedAnalyses(prev => ({ ...prev, [key]: !isExpanded }))}
                  className="flex items-center gap-1.5 w-full text-left"
                >
                  {isExpanded ? <ChevronDown className="w-3 h-3 text-muted-foreground" /> : <ChevronRight className="w-3 h-3 text-muted-foreground" />}
                  <span className="font-bold text-blue-800 dark:text-blue-300 text-[11px]">
                    Analýza {new Date(analysis.date).toLocaleDateString("cs-CZ")}
                  </span>
                </button>
                {isExpanded && (
                  <>
                    <div className="grid grid-cols-2 gap-1 mt-1">
                      {analysis.intervention_effectiveness && <p><strong>Efektivita:</strong> {analysis.intervention_effectiveness}</p>}
                      {analysis.stabilization_trend && <p><strong>Trend:</strong> {analysis.stabilization_trend}</p>}
                      {analysis.main_risk && <p className="col-span-2"><strong>Hlavní riziko:</strong> {analysis.main_risk}</p>}
                      {analysis.next_action && <p className="col-span-2"><strong>Další krok:</strong> {analysis.next_action}</p>}
                      {analysis.karel_recommendation && <p className="col-span-2"><strong>Doporučení:</strong> {analysis.karel_recommendation}</p>}
                    </div>
                    <div className="flex gap-2 text-[9px] text-muted-foreground mt-1">
                      {analysis.needs_follow_up_session && <span className="bg-amber-100 dark:bg-amber-900/30 text-amber-700 px-1 rounded">Potřeba follow-up</span>}
                      {analysis.needs_crisis_meeting && <span className="bg-destructive/10 text-destructive px-1 rounded">Potřeba porady</span>}
                      {analysis.prepare_closure && <span className="bg-green-100 dark:bg-green-900/30 text-green-700 px-1 rounded">Připravit uzavření</span>}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default CrisisSessionQA;

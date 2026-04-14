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
  intervention_effectiveness?: string;
  stabilization_trend?: string;
  main_risk?: string;
  next_action?: string;
  karel_recommendation?: string;
  needs_follow_up_session?: boolean;
  needs_crisis_meeting?: boolean;
  prepare_closure?: boolean;
}

interface AnalysisEntry {
  id: string;
  groupDate: string;
  timestamp: string | null;
  questionText: string;
  therapistName: string;
  answerText: string | null;
  parsed: ParsedAnalysis | null;
  rawAnalysis: string;
}

interface AnalysisGroup {
  dateKey: string;
  latestTimestamp: string | null;
  entries: AnalysisEntry[];
}

const CrisisSessionQA: React.FC<Props> = ({ card, onRefetch }) => {
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [answerInputs, setAnswerInputs] = useState<Record<string, string>>({});
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

  const analysisGroups = useMemo<AnalysisGroup[]>(() => {
    const entries: AnalysisEntry[] = card.sessionQuestions
      .filter((q) => !!q.karelAnalysis)
      .map((q) => {
        let parsed: ParsedAnalysis | null = null;

        try {
          parsed = JSON.parse(q.karelAnalysis || "") as ParsedAnalysis;
        } catch {
          parsed = null;
        }

        const timestamp = q.karelAnalyzedAt || q.answeredAt || null;

        return {
          id: q.id,
          groupDate: timestamp?.slice(0, 10) || "unknown",
          timestamp,
          questionText: q.questionText,
          therapistName: q.therapistName,
          answerText: q.answerText,
          parsed,
          rawAnalysis: q.karelAnalysis || "",
        };
      })
      .sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));

    const grouped = new Map<string, AnalysisGroup>();

    for (const entry of entries) {
      const existing = grouped.get(entry.groupDate);

      if (existing) {
        existing.entries.push(entry);
        if ((entry.timestamp || "") > (existing.latestTimestamp || "")) {
          existing.latestTimestamp = entry.timestamp;
        }
      } else {
        grouped.set(entry.groupDate, {
          dateKey: entry.groupDate,
          latestTimestamp: entry.timestamp,
          entries: [entry],
        });
      }
    }

    return Array.from(grouped.values()).sort((a, b) => {
      const left = a.latestTimestamp || a.dateKey;
      const right = b.latestTimestamp || b.dateKey;
      return right.localeCompare(left);
    });
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

      {/* All analyses – grouped by date, preserving every analysis entry */}
      {analysisGroups.length > 0 && (
        <div className="space-y-2">
          <p className="text-[11px] font-bold text-foreground flex items-center gap-1.5">
            <Brain className="w-3.5 h-3.5" />
            Karlovy analýzy ({analysisGroups.reduce((sum, group) => sum + group.entries.length, 0)})
          </p>

          {analysisGroups.map((group, idx) => {
            const key = `analysis_group_${group.dateKey}_${idx}`;
            const isExpanded = expandedGroups[key] ?? idx === 0;

            return (
              <div key={key} className="bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 rounded p-2 space-y-2 text-[10px]">
                <button
                  onClick={() => setExpandedGroups(prev => ({ ...prev, [key]: !isExpanded }))}
                  className="flex items-center gap-1.5 w-full text-left"
                >
                  {isExpanded ? <ChevronDown className="w-3 h-3 text-muted-foreground" /> : <ChevronRight className="w-3 h-3 text-muted-foreground" />}
                  <span className="font-bold text-blue-800 dark:text-blue-300 text-[11px]">
                    Analýzy {group.dateKey !== "unknown" ? new Date(group.dateKey).toLocaleDateString("cs-CZ") : "bez data"}
                  </span>
                  <span className="text-[9px] text-muted-foreground ml-auto">{group.entries.length}×</span>
                </button>

                {isExpanded && (
                  <div className="space-y-2">
                    {group.entries.map((entry, entryIdx) => (
                      <div
                        key={entry.id}
                        className={entryIdx > 0 ? "border-t border-blue-200/70 dark:border-blue-800/70 pt-2 space-y-1" : "space-y-1"}
                      >
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[9px] text-muted-foreground">
                          <span className="font-medium text-foreground">{entry.questionText}</span>
                          <span>{entry.therapistName === "hanka" ? "Hanička" : "Káťa"}</span>
                          {entry.timestamp && (
                            <span>
                              {new Date(entry.timestamp).toLocaleString("cs-CZ", {
                                day: "numeric",
                                month: "numeric",
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </span>
                          )}
                        </div>

                        {entry.answerText && (
                          <p className="text-muted-foreground bg-background/60 rounded p-1.5">
                            <strong>Odpověď:</strong> {entry.answerText}
                          </p>
                        )}

                        {entry.parsed ? (
                          <>
                            <div className="grid grid-cols-2 gap-1">
                              {entry.parsed.intervention_effectiveness && <p><strong>Efektivita:</strong> {entry.parsed.intervention_effectiveness}</p>}
                              {entry.parsed.stabilization_trend && <p><strong>Trend:</strong> {entry.parsed.stabilization_trend}</p>}
                              {entry.parsed.main_risk && <p className="col-span-2"><strong>Hlavní riziko:</strong> {entry.parsed.main_risk}</p>}
                              {entry.parsed.next_action && <p className="col-span-2"><strong>Další krok:</strong> {entry.parsed.next_action}</p>}
                              {entry.parsed.karel_recommendation && <p className="col-span-2"><strong>Doporučení:</strong> {entry.parsed.karel_recommendation}</p>}
                            </div>
                            <div className="flex flex-wrap gap-2 text-[9px] text-muted-foreground mt-1">
                              {entry.parsed.needs_follow_up_session && <span className="bg-amber-100 dark:bg-amber-900/30 text-amber-700 px-1 rounded">Potřeba follow-up</span>}
                              {entry.parsed.needs_crisis_meeting && <span className="bg-destructive/10 text-destructive px-1 rounded">Potřeba porady</span>}
                              {entry.parsed.prepare_closure && <span className="bg-green-100 dark:bg-green-900/30 text-green-700 px-1 rounded">Připravit uzavření</span>}
                            </div>
                          </>
                        ) : (
                          <p className="text-foreground whitespace-pre-wrap bg-background/60 rounded p-1.5">
                            <strong>Analýza:</strong> {entry.rawAnalysis}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
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

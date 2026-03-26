import { useState, useEffect } from "react";
import { HeartPulse, TrendingUp, TrendingDown, Minus, ChevronDown, ChevronUp, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

interface PulseRecord {
  id: string;
  respondent: string;
  week_start: string;
  team_feeling: number;
  priority_clarity: number;
  karel_feedback: string;
  created_at: string;
}

const QUESTIONS = [
  { key: "team_feeling" as const, label: "Jak se cítím v týmu", emoji: ["😟", "😕", "😐", "🙂", "😊"] },
  { key: "priority_clarity" as const, label: "Mám jasno v prioritách", emoji: ["❌", "🤔", "😐", "👍", "✅"] },
];

const RESPONDENTS = ["Hanka", "Káťa"] as const;

function getWeekStart(): string {
  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(now.setDate(diff));
  return monday.toISOString().split("T")[0];
}

function TrendIcon({ current, previous }: { current: number; previous: number | null }) {
  if (previous === null) return null;
  const diff = current - previous;
  if (diff > 0) return <TrendingUp className="w-3 h-3 text-green-500" />;
  if (diff < 0) return <TrendingDown className="w-3 h-3 text-red-500" />;
  return <Minus className="w-3 h-3 text-muted-foreground" />;
}

const DidPulseCheck = ({ refreshTrigger }: { refreshTrigger: number }) => {
  const [records, setRecords] = useState<PulseRecord[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [formData, setFormData] = useState<Record<string, { team_feeling: number; priority_clarity: number; karel_feedback: string }>>({});

  const weekStart = getWeekStart();

  useEffect(() => {
    loadRecords();
  }, [refreshTrigger]);

  const loadRecords = async () => {
    const { data } = await supabase
      .from("did_pulse_checks")
      .select("*")
      .order("week_start", { ascending: false })
      .limit(20);
    if (data) setRecords(data as PulseRecord[]);
  };

  const thisWeekRecords = records.filter(r => r.week_start === weekStart);
  const lastWeekRecords = records.filter(r => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() - 7);
    return r.week_start === d.toISOString().split("T")[0];
  });

  const getPrevious = (respondent: string, key: "team_feeling" | "priority_clarity") => {
    const prev = lastWeekRecords.find(r => r.respondent === respondent);
    return prev ? prev[key] : null;
  };

  const hasSubmitted = (respondent: string) => thisWeekRecords.some(r => r.respondent === respondent);

  const handleSubmit = async (respondent: string) => {
    const data = formData[respondent];
    if (!data || !data.team_feeling || !data.priority_clarity) {
      toast.error("Vyplň obě škály");
      return;
    }
    setSubmitting(respondent);
    try {
      const { error } = await supabase.from("did_pulse_checks").insert({
        respondent,
        week_start: weekStart,
        team_feeling: data.team_feeling,
        priority_clarity: data.priority_clarity,
        karel_feedback: data.karel_feedback || "",
      });
      if (error) {
        if (error.code === "23505") toast.error(`${respondent} už tento týden odpověděla`);
        else throw error;
      } else {
        toast.success(`Pulse check ${respondent} uložen ✓`);
        loadRecords();
        setFormData(prev => ({ ...prev, [respondent]: { team_feeling: 0, priority_clarity: 0, karel_feedback: "" } }));
      }
    } catch (e) {
      toast.error("Chyba při ukládání");
    } finally {
      setSubmitting(null);
    }
  };

  const setField = (respondent: string, key: string, value: number | string) => {
    setFormData(prev => ({
      ...prev,
      [respondent]: { ...prev[respondent], [key]: value },
    }));
  };

  // Compute average trends for header
  const avgThis = thisWeekRecords.length > 0
    ? (thisWeekRecords.reduce((s, r) => s + r.team_feeling + r.priority_clarity, 0) / (thisWeekRecords.length * 2)).toFixed(1)
    : null;

  return (
    <div className="rounded-lg border border-border bg-card/50 p-3 sm:p-4">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between w-full text-left"
      >
        <h4 className="text-xs font-medium text-foreground flex items-center gap-1.5">
          <HeartPulse className="w-3.5 h-3.5 text-primary" />
          Týdenní Pulse Check
          {thisWeekRecords.length > 0 && (
            <Badge variant="secondary" className="text-[0.5rem] h-4 px-1.5 ml-1">
              {thisWeekRecords.length}/2 ✓
            </Badge>
          )}
          {avgThis && (
            <span className="text-[0.625rem] text-muted-foreground ml-1">⌀ {avgThis}</span>
          )}
        </h4>
        {expanded ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}
      </button>

      {expanded && (
        <div className="mt-3 space-y-3">
          {RESPONDENTS.map(name => {
            const done = hasSubmitted(name);
            const thisWeek = thisWeekRecords.find(r => r.respondent === name);
            const fd = formData[name] || { team_feeling: 0, priority_clarity: 0, karel_feedback: "" };

            return (
              <div key={name} className="rounded-md border border-border/50 p-2.5 bg-background/50">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-medium text-foreground">{name}</span>
                  {done && <Badge variant="outline" className="text-[8px] h-4 px-1.5 text-green-600 border-green-300">vyplněno ✓</Badge>}
                </div>

                {done && thisWeek ? (
                  <div className="space-y-1">
                    {QUESTIONS.map(q => (
                      <div key={q.key} className="flex items-center gap-2 text-[0.6875rem]">
                        <span className="text-muted-foreground w-32 shrink-0">{q.label}</span>
                        <span className="font-medium">{q.emoji[thisWeek[q.key] - 1]} {thisWeek[q.key]}/5</span>
                        <TrendIcon current={thisWeek[q.key]} previous={getPrevious(name, q.key)} />
                      </div>
                    ))}
                    {thisWeek.karel_feedback && (
                      <p className="text-[0.625rem] text-muted-foreground mt-1 italic">
                        💬 „{thisWeek.karel_feedback}"
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {QUESTIONS.map(q => (
                      <div key={q.key}>
                        <span className="text-[0.625rem] text-muted-foreground block mb-1">{q.label}</span>
                        <div className="flex gap-1">
                          {[1, 2, 3, 4, 5].map(v => (
                            <button
                              key={v}
                              onClick={() => setField(name, q.key, v)}
                              className={`w-8 h-8 rounded-md text-sm transition-all ${
                                fd[q.key] === v
                                  ? "bg-primary text-primary-foreground scale-110 shadow-sm"
                                  : "bg-muted/50 hover:bg-muted text-muted-foreground"
                              }`}
                            >
                              {q.emoji[v - 1]}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                    <div>
                      <span className="text-[0.625rem] text-muted-foreground block mb-1">Vzkaz pro Karla (nepovinné)</span>
                      <input
                        type="text"
                        value={fd.karel_feedback}
                        onChange={e => setField(name, "karel_feedback", e.target.value)}
                        placeholder="Potřebuji od Karla..."
                        className="w-full text-xs bg-muted/30 border border-border/50 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/50"
                        maxLength={200}
                      />
                    </div>
                    <Button
                      size="sm"
                      onClick={() => handleSubmit(name)}
                      disabled={submitting === name || !fd.team_feeling || !fd.priority_clarity}
                      className="h-7 text-[0.6875rem] gap-1"
                    >
                      <Send className="w-3 h-3" />
                      Odeslat za {name}
                    </Button>
                  </div>
                )}
              </div>
            );
          })}

          {/* Trend history */}
          {records.length > 2 && (
            <div className="border-t border-border/50 pt-2 mt-2">
              <span className="text-[0.625rem] text-muted-foreground font-medium">Historie (posledních 4 týdnů)</span>
              <div className="mt-1 space-y-0.5">
                {Array.from(new Set(records.map(r => r.week_start))).slice(0, 4).map(week => {
                  const weekRecs = records.filter(r => r.week_start === week);
                  const avg = weekRecs.length > 0
                    ? (weekRecs.reduce((s, r) => s + r.team_feeling + r.priority_clarity, 0) / (weekRecs.length * 2)).toFixed(1)
                    : "–";
                  return (
                    <div key={week} className="flex items-center gap-2 text-[0.625rem]">
                      <span className="text-muted-foreground w-20">{new Date(week).toLocaleDateString("cs-CZ", { day: "numeric", month: "short" })}</span>
                      <span className="font-medium">⌀ {avg}</span>
                      <span className="text-muted-foreground">({weekRecs.map(r => r.respondent[0]).join(", ")})</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default DidPulseCheck;

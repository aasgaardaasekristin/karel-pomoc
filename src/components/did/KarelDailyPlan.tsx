import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Textarea } from "@/components/ui/textarea";
import {
  Send, MessageCircle, ClipboardList, HelpCircle,
  CalendarDays, ArrowRight, Users, Lightbulb, AlertTriangle, CheckCircle2
} from "lucide-react";
import { toast } from "sonner";

interface Props {
  refreshTrigger: number;
  hasCrisisBanner?: boolean;
}

/* ── Greeting by time of day ── */
function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 10) return "Dobré ráno";
  if (h < 14) return "Dobrý den";
  if (h < 18) return "Dobré odpoledne";
  return "Dobrý večer";
}

/* ── Relative time ── */
function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const h = Math.round(diff / 3600000);
  if (h < 1) return "před chvílí";
  if (h < 24) return `před ${h}h`;
  const d = Math.round(h / 24);
  return d === 1 ? "včera" : `před ${d} dny`;
}

function daysSince(iso: string | null): number {
  if (!iso) return 999;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

/* ── Detect therapist target from assigned_to ── */
function detectTarget(assignedTo: string): "hanka" | "kata" | "team" {
  const low = (assignedTo || "").toLowerCase();
  if (low.includes("han")) return "hanka";
  if (low.includes("kát") || low.includes("kata")) return "kata";
  return "team";
}

/* ── Deduplicate tasks by first 40 chars of task text ── */
function deduplicateByText<T extends { task?: string; question?: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter(item => {
    const text = (item.task || item.question || "").slice(0, 40).toLowerCase().trim();
    if (!text || seen.has(text)) return false;
    seen.add(text);
    return true;
  });
}

/* ── Inline link ── */
const ActionLink = ({ label, onClick, icon }: { label: string; onClick: () => void; icon?: React.ReactNode }) => (
  <button
    onClick={onClick}
    className="inline-flex items-center gap-1.5 text-primary/80 hover:text-primary hover:underline underline-offset-2 font-medium cursor-pointer transition-colors text-[12.5px]"
  >
    {icon || <ArrowRight className="w-3 h-3" />}
    {label}
  </button>
);

/* ── Divider ── */
const NarrativeDivider = () => <div className="jung-divider my-4" />;

/* ── Section header ── */
const SectionHead = ({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) => (
  <h4 className="flex items-center gap-2 text-[14px] font-['Crimson_Pro',serif] font-medium text-foreground/80 mb-2">
    {icon}
    {children}
  </h4>
);

/* ── Inline Question Field ── */
const InlineQuestionField = ({
  question,
  onSubmit,
}: {
  question: string;
  onSubmit: (answer: string) => void;
}) => {
  const [answer, setAnswer] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [sending, setSending] = useState(false);

  const handleSubmit = async () => {
    if (!answer.trim()) return;
    setSending(true);
    try {
      await onSubmit(answer.trim());
      setSubmitted(true);
      toast.success("Děkuji. Tuto informaci ihned zapracuji.");
    } catch {
      toast.error("Odeslání se nezdařilo, zkuste znovu.");
    } finally {
      setSending(false);
    }
  };

  if (submitted) {
    return (
      <div className="flex items-center gap-2 text-[12.5px] text-primary/70 py-1">
        <CheckCircle2 className="w-3.5 h-3.5" />
        <span className="italic">Odpověď přijata — zapracuji při příštím cyklu.</span>
      </div>
    );
  }

  return (
    <div className="mt-1.5 space-y-1.5">
      <Textarea
        value={answer}
        onChange={e => setAnswer(e.target.value)}
        placeholder="Napište odpověď…"
        className="min-h-[40px] max-h-[80px] text-[12.5px] bg-card/60 border-border/40 resize-none"
        rows={2}
      />
      <div className="flex items-center gap-2">
        <button
          onClick={handleSubmit}
          disabled={!answer.trim() || sending}
          className="inline-flex items-center gap-1.5 text-[12px] font-medium px-3 py-1 rounded-md bg-primary/10 hover:bg-primary/20 text-primary transition-colors disabled:opacity-40"
        >
          <Send className="w-3 h-3" />
          Odeslat
        </button>
        <span className="text-[11px] text-foreground/35">
          Pokud nevíte jak zjistit, napište — Karel poradí.
        </span>
      </div>
    </div>
  );
};

const KarelDailyPlan = ({ refreshTrigger, hasCrisisBanner = false }: Props) => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const hasLoadedOnce = useRef(false);
  const [therapistMessage, setTherapistMessage] = useState("");
  const [sendingMessage, setSendingMessage] = useState(false);

  // Data
  const [tasks, setTasks] = useState<{ id: string; task: string; assigned_to: string; status: string; priority: string; created_at?: string }[]>([]);
  const [sessions, setSessions] = useState<{ id: string; selected_part: string; therapist: string; plan_date: string }[]>([]);
  const [questions, setQuestions] = useState<{ id: string; question: string; directed_to: string | null }[]>([]);
  const [recentThreads, setRecentThreads] = useState<{ part_name: string; last_activity_at: string; sub_mode: string; thread_label: string | null }[]>([]);
  const [recentInterviews, setRecentInterviews] = useState<{
    part_name: string;
    summary_for_team: string | null;
    karel_decision_after_interview: string | null;
    started_at: string | null;
    what_shifted: string | null;
    what_remains_unclear: string | null;
  }[]>([]);
  const [crisisPartName, setCrisisPartName] = useState<string | null>(null);
  const [plan05ANarrative, setPlan05ANarrative] = useState<string>("");
  const [lastAnyActivity, setLastAnyActivity] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!hasLoadedOnce.current) setLoading(true);

    try {
      const today = new Date().toISOString().slice(0, 10);
      const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString();

      const [tasksRes, sessionsRes, questionsRes, threadsRes, interviewsRes, crisisRes, planRes] = await Promise.all([
        supabase
          .from("did_therapist_tasks")
          .select("id, task, assigned_to, status, priority, created_at")
          .in("status", ["pending", "active", "in_progress"])
          .gte("created_at", threeDaysAgo)
          .order("priority", { ascending: true })
          .limit(15),
        supabase
          .from("did_daily_session_plans")
          .select("id, selected_part, therapist, plan_date")
          .eq("plan_date", today)
          .in("status", ["planned", "in_progress", "generated"])
          .limit(3),
        (supabase as any)
          .from("did_pending_questions")
          .select("id, question, directed_to")
          .in("status", ["pending", "sent"])
          .limit(10),
        supabase
          .from("did_threads")
          .select("part_name, last_activity_at, sub_mode, thread_label")
          .gte("last_activity_at", threeDaysAgo)
          .order("last_activity_at", { ascending: false })
          .limit(8),
        supabase
          .from("crisis_karel_interviews")
          .select("part_name, summary_for_team, karel_decision_after_interview, started_at, what_shifted, what_remains_unclear")
          .gte("created_at", threeDaysAgo)
          .order("created_at", { ascending: false })
          .limit(5),
        supabase
          .from("crisis_events")
          .select("part_name")
          .neq("phase", "CLOSED")
          .limit(1),
        supabase.functions.invoke("karel-did-drive-read", {
          body: { documents: ["05A_OPERATIVNI_PLAN"], subFolder: "00_CENTRUM" },
        }).catch(() => ({ data: null, error: null })),
      ]);

      // Deduplicate tasks by text
      const rawTasks = tasksRes.data || [];
      setTasks(deduplicateByText(rawTasks).slice(0, 5));
      setSessions(sessionsRes.data || []);
      setQuestions(deduplicateByText(questionsRes.data || []).slice(0, 5) as any);
      setRecentThreads(threadsRes.data || []);
      setRecentInterviews(interviewsRes.data || []);
      setCrisisPartName(crisisRes.data?.[0]?.part_name || null);

      // Determine last any activity date
      const allDates = [
        ...(threadsRes.data || []).map((t: any) => t.last_activity_at),
        ...(interviewsRes.data || []).map((iv: any) => iv.started_at),
      ].filter(Boolean).sort().reverse();
      setLastAnyActivity(allDates[0] || null);

      // Extract narrative from 05A
      if (planRes.data?.documents?.["05A_OPERATIVNI_PLAN"]) {
        const raw = planRes.data.documents["05A_OPERATIVNI_PLAN"] as string;
        if (raw.length > 50 && !raw.startsWith("[Dokument")) {
          const overviewMatch = raw.match(/━━━\s*6\.\s*KARL[ŮU]V\s*P[ŘR]EHLED\s*━━━\n([\s\S]*?)(?=━━━|═══|$)/i);
          if (overviewMatch?.[1]) {
            const lines = overviewMatch[1].trim().split("\n").filter(l => l.trim()).slice(0, 8);
            setPlan05ANarrative(lines.join(" ").replace(/\s{2,}/g, " ").trim());
          }
        }
      }
    } catch (err) {
      console.error("[KarelDailyPlan] Load failed:", err);
    } finally {
      setLoading(false);
      hasLoadedOnce.current = true;
    }
  }, []);

  useEffect(() => { load(); }, [load, refreshTrigger]);

  // ── Send therapist message ──
  const handleSendMessage = async () => {
    if (!therapistMessage.trim()) return;
    setSendingMessage(true);
    try {
      const { error } = await supabase.from("did_threads").insert({
        part_name: "Karel",
        sub_mode: "mamka",
        thread_label: `Vzkaz z přehledu — ${new Date().toLocaleDateString("cs-CZ")}`,
        messages: [{ role: "user", content: therapistMessage.trim() }],
        last_activity_at: new Date().toISOString(),
      });
      if (error) throw error;
      toast.success("Vzkaz odeslán — Karel zpracuje při příštím cyklu");
      setTherapistMessage("");
    } catch (e: any) {
      toast.error(`Odeslání selhalo: ${e.message}`);
    } finally {
      setSendingMessage(false);
    }
  };

  // ── Save inline answer as did_threads entry ──
  const saveInlineAnswer = async (questionText: string, answer: string) => {
    const { error } = await supabase.from("did_threads").insert({
      part_name: "Karel",
      sub_mode: "mamka",
      thread_label: `Odpověď na Karlovu otázku: ${questionText.slice(0, 60)}`,
      messages: [
        { role: "assistant", content: questionText },
        { role: "user", content: answer },
      ],
      last_activity_at: new Date().toISOString(),
    });
    if (error) throw error;
  };

  // ── Navigation helpers ──
  const openTaskWorkspace = (task: typeof tasks[0]) => {
    const target = detectTarget(task.assigned_to);
    const submode = target === "kata" ? "kata" : "mamka";
    const params = new URLSearchParams();
    params.set("did_submode", submode);
    params.set("task_id", task.id);
    try { sessionStorage.setItem("karel_hub_section", "did"); } catch {}
    navigate(`/chat?${params.toString()}`);
  };

  const openQuestionWorkspace = (q: typeof questions[0]) => {
    const target = detectTarget(q.directed_to || "");
    const submode = target === "kata" ? "kata" : "mamka";
    const params = new URLSearchParams();
    params.set("did_submode", submode);
    params.set("question_id", q.id);
    try { sessionStorage.setItem("karel_hub_section", "did"); } catch {}
    navigate(`/chat?${params.toString()}`);
  };

  const openMeeting = (topic?: string) => {
    const params = new URLSearchParams();
    params.set("didFlowState", "meeting");
    if (topic) params.set("meeting_topic", topic);
    try { sessionStorage.setItem("karel_hub_section", "did"); } catch {}
    navigate(`/chat?${params.toString()}`);
  };

  const openSessionPlan = (partName: string) => {
    const params = new URLSearchParams();
    params.set("did_submode", "mamka");
    params.set("session_part", partName);
    try { sessionStorage.setItem("karel_hub_section", "did"); } catch {}
    navigate(`/chat?${params.toString()}`);
  };

  const openNewKarelThread = () => {
    try { sessionStorage.setItem("karel_hub_section", "did"); } catch {}
    navigate("/chat?did_submode=mamka");
  };

  // ── Loading skeleton ──
  if (loading && !hasLoadedOnce.current) {
    return (
      <div className="jung-card p-6">
        <div className="mb-3 h-5 w-48 animate-pulse rounded bg-muted" />
        <div className="space-y-2">
          <div className="h-4 w-full animate-pulse rounded bg-muted" />
          <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
          <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
        </div>
      </div>
    );
  }

  const todayFormatted = new Date().toLocaleDateString("cs-CZ", {
    day: "numeric", month: "long", year: "numeric",
  });
  const greeting = getGreeting();

  // ── Determine information deficit ──
  const daysWithoutData = daysSince(lastAnyActivity);
  const isInfoDeficit = daysWithoutData >= 3;

  // ── Build 72h retrospektiva ──
  const retroParts: string[] = [];
  if (plan05ANarrative) {
    retroParts.push(plan05ANarrative);
  }
  if (recentInterviews.length > 0) {
    for (const iv of recentInterviews.slice(0, 3)) {
      const when = relativeTime(iv.started_at);
      let line = `${when ? when.charAt(0).toUpperCase() + when.slice(1) : "Nedávno"} jsem vedl rozhovor s ${iv.part_name}.`;
      if (iv.summary_for_team) {
        line += ` ${iv.summary_for_team.slice(0, 200)}`;
      }
      if (iv.what_shifted) {
        line += ` Co se posunulo: ${iv.what_shifted.slice(0, 150)}`;
      }
      retroParts.push(line);
    }
  }
  if (recentThreads.length > 0 && retroParts.length < 3) {
    const uniqueParts = [...new Set(recentThreads.map(t => t.part_name))].slice(0, 4);
    retroParts.push(`V posledních dnech jsem komunikoval s: ${uniqueParts.join(", ")}. Jejich témata průběžně sleduji.`);
  }
  if (crisisPartName && !hasCrisisBanner) {
    retroParts.unshift(`⚠ ${crisisPartName} je v aktivní krizi — potřebuji vaši plnou pozornost a koordinaci.`);
  }

  // ── Karlova rozhodnutí ──
  const decisions = recentInterviews
    .filter(iv => iv.karel_decision_after_interview)
    .slice(0, 2);

  // ── Unclear items ──
  const unclearItems = recentInterviews
    .filter(iv => iv.what_remains_unclear)
    .slice(0, 2);

  // Task groups
  const hankaTasks = tasks.filter(t => detectTarget(t.assigned_to) === "hanka");
  const kataTasks = tasks.filter(t => detectTarget(t.assigned_to) === "kata");
  const teamTasks = tasks.filter(t => detectTarget(t.assigned_to) === "team");

  // Deduplicate sessions by part name
  const uniqueSessions = sessions.reduce((acc, s) => {
    if (!acc.find(x => x.selected_part === s.selected_part)) acc.push(s);
    return acc;
  }, [] as typeof sessions);

  // ── Information deficit questions ──
  const deficitQuestions: string[] = [];
  if (isInfoDeficit) {
    const uniqueParts = [...new Set(recentThreads.map(t => t.part_name))];
    if (uniqueParts.length > 0) {
      deficitQuestions.push(`Jak se ${uniqueParts[0]} chová od posledního kontaktu (${relativeTime(lastAnyActivity)})?`);
    }
    deficitQuestions.push(`Jaká je aktuální situace s dětmi? Co se děje?`);
    if (daysWithoutData > 5) {
      deficitQuestions.push(`Uplynulo ${daysWithoutData} dní bez aktualizace. Co vás zdrželo? Potřebujete s něčím pomoci?`);
    }
    if (crisisPartName) {
      deficitQuestions.push(`${crisisPartName} má aktivní krizi — jaký je aktuální stav?`);
    }
  }

  return (
    <div className="jung-card space-y-0 p-6">
      {/* ── Header ── */}
      <h2 className="jung-section-title text-[20px] mb-1">
        ☉ Karlův přehled — {todayFormatted}
      </h2>

      {/* ── A. Oslovení obou terapeutek ── */}
      <div className="pt-3 pb-1">
        <p className="text-[14.5px] leading-7 text-foreground/85 font-['Crimson_Pro',serif] italic">
          „{greeting}, Haničko a Káťo.
        </p>
      </div>

      {/* ── INFO DEFICIT MODE ── */}
      {isInfoDeficit ? (
        <>
          {/* What Karel knows last */}
          <div className="pb-1">
            <p className="text-[13.5px] leading-7 text-foreground/75 font-['DM_Sans',sans-serif] mt-1.5">
              Uplynulo <span className="font-semibold text-foreground/90">{daysWithoutData} dní</span> od poslední aktualizace.
              {lastAnyActivity && (
                <> Naposledy jsem měl informace {relativeTime(lastAnyActivity)}.</>
              )}
            </p>
            {retroParts.length > 0 && (
              <p className="text-[13px] leading-6 text-foreground/60 font-['DM_Sans',sans-serif] mt-1">
                Co vím naposledy: {retroParts[0]?.slice(0, 300)}
              </p>
            )}
            <p className="text-[13.5px] leading-7 text-foreground/75 font-['DM_Sans',sans-serif] mt-2">
              Potřebuji vědět, jak se situace vyvíjí. Bez aktuálních informací nemohu účinně koordinovat péči.
              Prosím, odpovězte na následující otázky — každá odpověď mi pomůže okamžitě přizpůsobit plán:
            </p>
          </div>

          {/* Inline question fields */}
          <NarrativeDivider />
          <div className="py-2">
            <SectionHead icon={<AlertTriangle className="w-4 h-4 text-amber-500/70" />}>
              Karlovy otázky — odpovězte přímo zde
            </SectionHead>
            <div className="space-y-4">
              {deficitQuestions.map((q, i) => (
                <div key={i} className="border-l-2 border-primary/20 pl-3">
                  <p className="text-[13px] text-foreground/75 font-medium mb-1">
                    {q}
                  </p>
                  <InlineQuestionField
                    question={q}
                    onSubmit={(answer) => saveInlineAnswer(q, answer)}
                  />
                </div>
              ))}
            </div>
          </div>
        </>
      ) : (
        <>
          {/* ── B. 72h retrospektiva (normal mode) ── */}
          <div className="pb-1">
            {retroParts.length > 0 ? retroParts.map((part, i) => (
              <p key={i} className="text-[13.5px] leading-7 text-foreground/75 font-['DM_Sans',sans-serif] mt-1.5">
                {part}
              </p>
            )) : (
              <p className="text-[13.5px] leading-7 text-foreground/60 font-['DM_Sans',sans-serif] mt-1.5 italic">
                Zatím nemám čerstvé operativní zprávy za poslední 3 dny. Čekám na data z denního cyklu.
              </p>
            )}
          </div>
        </>
      )}

      {/* ── C. Karlova rozhodnutí ── */}
      {decisions.length > 0 && (
        <>
          <NarrativeDivider />
          <div className="py-1">
            <SectionHead icon={<Lightbulb className="w-4 h-4 text-primary/60" />}>
              Mé rozhodnutí
            </SectionHead>
            {decisions.map((d, i) => (
              <p key={i} className="text-[13px] leading-6 text-foreground/70 mb-1.5">
                <span className="font-medium text-foreground/80">{d.part_name}:</span>{" "}
                {d.karel_decision_after_interview?.slice(0, 250)}
              </p>
            ))}
          </div>
        </>
      )}

      {/* ── Unclear / questions for team ── */}
      {unclearItems.length > 0 && (
        <div className="py-1">
          <p className="text-[13px] leading-6 text-foreground/60 italic">
            Co zůstává nejasné: {unclearItems.map(u => `${u.part_name} — ${u.what_remains_unclear?.slice(0, 120)}`).join("; ")}
          </p>
        </div>
      )}

      {/* ── D. Návrh sezení na dnes ── */}
      {uniqueSessions.length > 0 && (
        <>
          <NarrativeDivider />
          <div className="py-2">
            <SectionHead icon={<CalendarDays className="w-4 h-4 text-primary/60" />}>
              Návrh sezení na dnes
            </SectionHead>
            <p className="text-[13px] text-foreground/65 mb-2">
              Navrhuji dnes pracovat s {uniqueSessions.map(s => s.selected_part).join(" a ")}. Kliknutím otevřete podrobný plán sezení:
            </p>
            <div className="space-y-2">
              {uniqueSessions.map(s => (
                <div key={s.id} className="flex items-start gap-2 text-[13px] text-foreground/70">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/40" />
                  <div className="flex-1">
                    <span className="font-medium text-foreground/80">{s.selected_part}</span>
                    <span className="text-foreground/50"> — {s.therapist || "terapeutka dle domluvy"}</span>
                    <div className="mt-0.5">
                      <ActionLink label="Otevřít plán sezení" onClick={() => openSessionPlan(s.selected_part)} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* ── E. Úkoly — pro Haničku ── */}
      {hankaTasks.length > 0 && (
        <>
          <NarrativeDivider />
          <div className="py-2">
            <SectionHead icon={<ClipboardList className="w-4 h-4 text-primary/60" />}>
              Haničko, potřebuji od tebe
            </SectionHead>
            <ul className="space-y-2">
              {hankaTasks.slice(0, 5).map(t => (
                <li key={t.id} className="text-[13px] text-foreground/70 flex items-start gap-2">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/30" />
                  <div className="flex-1">
                    <span>{t.task}</span>
                    <div className="mt-0.5">
                      <ActionLink label="Odpovědět / řešit" onClick={() => openTaskWorkspace(t)} />
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      {/* ── E. Úkoly — pro Káťu ── */}
      {kataTasks.length > 0 && (
        <>
          <NarrativeDivider />
          <div className="py-2">
            <SectionHead icon={<ClipboardList className="w-4 h-4 text-primary/60" />}>
              Káťo, potřebuji od tebe
            </SectionHead>
            <ul className="space-y-2">
              {kataTasks.slice(0, 5).map(t => (
                <li key={t.id} className="text-[13px] text-foreground/70 flex items-start gap-2">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/30" />
                  <div className="flex-1">
                    <span>{t.task}</span>
                    <div className="mt-0.5">
                      <ActionLink label="Odpovědět / řešit" onClick={() => openTaskWorkspace(t)} />
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      {/* ── E. Úkoly — pro celý tým / poradní ── */}
      {teamTasks.length > 0 && (
        <>
          <NarrativeDivider />
          <div className="py-2">
            <SectionHead icon={<Users className="w-4 h-4 text-primary/60" />}>
              Společná porada — řešíme spolu
            </SectionHead>
            <p className="text-[13px] text-foreground/60 mb-2">
              Následující body potřebuji prodiskutovat s oběma. Kliknutím otevřete poradní prostor:
            </p>
            <ul className="space-y-2">
              {teamTasks.slice(0, 4).map(t => (
                <li key={t.id} className="text-[13px] text-foreground/70 flex items-start gap-2">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent/30" />
                  <div className="flex-1">
                    <span>{t.task}</span>
                    <div className="mt-0.5">
                      <ActionLink
                        label="Otevřít poradu"
                        onClick={() => openMeeting(t.task.slice(0, 60))}
                        icon={<Users className="w-3 h-3" />}
                      />
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      {/* ── F. Nezodpovězené otázky ── */}
      {questions.length > 0 && (
        <>
          <NarrativeDivider />
          <div className="py-2">
            <SectionHead icon={<HelpCircle className="w-4 h-4 text-accent/60" />}>
              Čekám na vaše odpovědi
            </SectionHead>
            <ul className="space-y-2">
              {questions.slice(0, 5).map(q => (
                <li key={q.id} className="text-[13px] text-foreground/70 flex items-start gap-2">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent/30" />
                  <div className="flex-1">
                    <span>{q.question}</span>
                    {q.directed_to && (
                      <span className="text-foreground/40 ml-1">→ {q.directed_to}</span>
                    )}
                    <div className="mt-0.5">
                      <ActionLink
                        label={`Odpovědět${q.directed_to ? ` (${q.directed_to})` : ""}`}
                        onClick={() => openQuestionWorkspace(q)}
                      />
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      {/* ── G. Hodnocení + motivace ── */}
      <NarrativeDivider />
      <div className="py-2">
        <p className="text-[13px] leading-6 text-foreground/65 font-['DM_Sans',sans-serif]">
          {isInfoDeficit
            ? "Vaše odpovědi jsou pro mě klíčové. Jakmile je obdržím, okamžitě přizpůsobím plán a připravím aktualizovaný přehled."
            : tasks.length > 3
            ? "Vím, že toho je hodně. Nezapomínejte — nejdůležitější je začít tím, co je nejurgentnější. Zbytek zvládneme společně."
            : questions.length > 2
            ? "Mám na vás několik otázek — vaše odpovědi mi pomohou lépe plánovat další kroky. Děkuji za spolupráci."
            : "Jsem tu pro vás obě. Kdykoli potřebujete poradit, konzultovat nebo se jen ujistit, otevřete rozhovor se mnou."
          }"
        </p>
      </div>

      {/* ── H. Nabídka pomoci ── */}
      <div className="py-1">
        <button
          onClick={openNewKarelThread}
          className="inline-flex items-center gap-2 text-[13px] font-medium text-primary/80 hover:text-primary hover:underline underline-offset-2 cursor-pointer transition-colors"
        >
          <MessageCircle className="w-4 h-4" />
          Potřebuji Karlovu pomoc
        </button>
      </div>

      {/* ── I. Vstupní pole pro terapeutky ── */}
      <NarrativeDivider />
      <div className="pt-2 pb-1">
        <p className="text-[12px] text-foreground/45 mb-2 font-['DM_Sans',sans-serif]">
          Napište Karlovi vzkaz — zpracuji to v příštím cyklu:
        </p>
        <div className="flex gap-2">
          <Textarea
            value={therapistMessage}
            onChange={e => setTherapistMessage(e.target.value)}
            placeholder={'Např. „Dnes nemůžu přijít…" nebo „Všimla jsem si, že Tundrupek…"'}
            className="min-h-[48px] max-h-[100px] text-[13px] bg-card/60 border-border/40 resize-none"
            rows={2}
          />
          <button
            onClick={handleSendMessage}
            disabled={!therapistMessage.trim() || sendingMessage}
            className="shrink-0 self-end p-2 rounded-lg bg-primary/10 hover:bg-primary/20 text-primary transition-colors disabled:opacity-40"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};

export default KarelDailyPlan;

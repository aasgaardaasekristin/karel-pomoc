import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Textarea } from "@/components/ui/textarea";
import { Send, MessageCircle, ClipboardList, HelpCircle, CalendarDays, ArrowRight } from "lucide-react";
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

/* ── Short relative time label ── */
function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const h = Math.round(diff / 3600000);
  if (h < 1) return "před chvílí";
  if (h < 24) return `před ${h}h`;
  const d = Math.round(h / 24);
  return `před ${d} dny`;
}

/* ── Inline link component ── */
const InlineLink = ({ label, onClick }: { label: string; onClick: () => void }) => (
  <button
    onClick={onClick}
    className="inline-flex items-center gap-1 text-primary hover:underline underline-offset-2 font-medium cursor-pointer transition-colors"
  >
    <ArrowRight className="w-3 h-3" />
    {label}
  </button>
);

/* ── Section divider ── */
const NarrativeDivider = () => (
  <div className="jung-divider my-4" />
);

const KarelDailyPlan = ({ refreshTrigger, hasCrisisBanner = false }: Props) => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const hasLoadedOnce = useRef(false);
  const [therapistMessage, setTherapistMessage] = useState("");
  const [sendingMessage, setSendingMessage] = useState(false);

  // Data
  const [tasks, setTasks] = useState<{ id: string; task: string; assigned_to: string; status: string; priority: string }[]>([]);
  const [sessions, setSessions] = useState<{ id: string; selected_part: string; therapist: string; session_plan: string | null }[]>([]);
  const [questions, setQuestions] = useState<{ id: string; question: string; directed_to: string | null }[]>([]);
  const [recentThreads, setRecentThreads] = useState<{ part_name: string; last_activity_at: string; sub_mode: string }[]>([]);
  const [recentInterviews, setRecentInterviews] = useState<{ part_name: string; summary_for_team: string | null; karel_decision: string | null; started_at: string | null }[]>([]);
  const [crisisPartName, setCrisisPartName] = useState<string | null>(null);
  const [plan05ANarrative, setPlan05ANarrative] = useState<string>("");

  const load = useCallback(async () => {
    if (!hasLoadedOnce.current) setLoading(true);

    try {
      const today = new Date().toISOString().slice(0, 10);
      const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString();

      const [tasksRes, sessionsRes, questionsRes, threadsRes, interviewsRes, crisisRes, planRes] = await Promise.all([
        supabase
          .from("did_therapist_tasks")
          .select("id, task, assigned_to, status, priority")
          .in("status", ["pending", "active", "in_progress"])
          .order("priority", { ascending: true })
          .limit(12),
        supabase
          .from("did_daily_session_plans")
          .select("id, selected_part, therapist, session_plan")
          .in("status", ["planned", "in_progress"])
          .gte("plan_date", today)
          .limit(5),
        (supabase as any)
          .from("did_pending_questions")
          .select("id, question, directed_to")
          .in("status", ["pending", "sent"])
          .limit(10),
        supabase
          .from("did_threads")
          .select("part_name, last_activity_at, sub_mode")
          .gte("last_activity_at", threeDaysAgo)
          .order("last_activity_at", { ascending: false })
          .limit(8),
        supabase
          .from("crisis_karel_interviews")
          .select("part_name, summary_for_team, karel_decision, started_at")
          .gte("created_at", threeDaysAgo)
          .order("created_at", { ascending: false })
          .limit(5),
        supabase
          .from("crisis_events")
          .select("part_name")
          .neq("phase", "CLOSED")
          .limit(1),
        // Try 05A document for narrative
        supabase.functions.invoke("karel-did-drive-read", {
          body: { documents: ["05A_OPERATIVNI_PLAN"], subFolder: "00_CENTRUM" },
        }).catch(() => ({ data: null, error: null })),
      ]);

      setTasks(tasksRes.data || []);
      setSessions(sessionsRes.data || []);
      setQuestions(questionsRes.data || []);
      setRecentThreads(threadsRes.data || []);
      setRecentInterviews(interviewsRes.data || []);
      setCrisisPartName(crisisRes.data?.[0]?.part_name || null);

      // Extract Karel overview prose from 05A
      if (planRes.data?.documents?.["05A_OPERATIVNI_PLAN"]) {
        const raw = planRes.data.documents["05A_OPERATIVNI_PLAN"] as string;
        if (raw.length > 50 && !raw.startsWith("[Dokument")) {
          const overviewMatch = raw.match(/━━━\s*6\.\s*KARL[ŮU]V\s*P[ŘR]EHLED\s*━━━\n([\s\S]*?)(?=━━━|═══|$)/i);
          if (overviewMatch?.[1]) {
            const lines = overviewMatch[1].trim().split("\n").filter(l => l.trim()).slice(0, 5);
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

  // ── Send therapist message to Karel ──
  const handleSendMessage = async () => {
    if (!therapistMessage.trim()) return;
    setSendingMessage(true);
    try {
      // Create a new therapist thread with the message
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

  // ── Navigation helpers ──
  const openThread = (partName: string) => {
    const params = new URLSearchParams();
    params.set("crisis_action", "interview");
    params.set("part_name", partName);
    try { sessionStorage.setItem("karel_hub_section", "did"); } catch {}
    navigate(`/chat?${params.toString()}`);
  };

  const openFeedback = () => {
    const params = new URLSearchParams();
    params.set("crisis_action", "feedback");
    try { sessionStorage.setItem("karel_hub_section", "did"); } catch {}
    navigate(`/chat?${params.toString()}`);
  };

  const openNewKarelThread = () => {
    // Navigate to Hanička's thread list — Karel will greet her
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
  const hankaTasks = tasks.filter(t => (t.assigned_to || "").toLowerCase().includes("han"));
  const kataTasks = tasks.filter(t => (t.assigned_to || "").toLowerCase().includes("kát") || (t.assigned_to || "").toLowerCase().includes("kata"));
  const sharedTasks = tasks.filter(t => !hankaTasks.includes(t) && !kataTasks.includes(t));

  // Build narrative parts
  const narrativeParts: string[] = [];
  if (plan05ANarrative) {
    narrativeParts.push(plan05ANarrative);
  } else {
    // Fallback narrative from data
    if (crisisPartName && !hasCrisisBanner) {
      narrativeParts.push(`Dnes je nejdůležitější ${crisisPartName} — potřebuji vaši plnou pozornost.`);
    }
    if (recentInterviews.length > 0) {
      const latest = recentInterviews[0];
      narrativeParts.push(`V posledních dnech jsem mluvil s ${latest.part_name}${latest.summary_for_team ? ` — ${latest.summary_for_team.slice(0, 120)}` : ""}.`);
    }
    if (recentThreads.length > 0) {
      const uniqueParts = [...new Set(recentThreads.map(t => t.part_name))].slice(0, 3);
      narrativeParts.push(`Komunikoval jsem s: ${uniqueParts.join(", ")}.`);
    }
  }

  if (narrativeParts.length === 0) {
    narrativeParts.push("Dnes zatím nemám čerstvé operativní zprávy. Čekám na data z denního cyklu.");
  }

  return (
    <div className="jung-card space-y-0 p-6">
      {/* ── Header ── */}
      <h2 className="jung-section-title text-[20px] mb-1">
        ☉ Karlův přehled — {todayFormatted}
      </h2>

      {/* ── Personal greeting + narrative ── */}
      <div className="pt-3 pb-1">
        <p className="text-[14.5px] leading-7 text-foreground/85 font-['Crimson_Pro',serif] italic">
          „{greeting}, Haničko.
        </p>
        <p className="text-[13.5px] leading-7 text-foreground/75 font-['DM_Sans',sans-serif] mt-2">
          {narrativeParts.join(" ")}
        </p>
        {recentInterviews.length > 0 && recentInterviews[0].karel_decision && (
          <p className="text-[13px] leading-6 text-foreground/65 mt-1">
            <span className="font-medium text-foreground/75">Mé rozhodnutí:</span>{" "}
            {recentInterviews[0].karel_decision.slice(0, 200)}
          </p>
        )}
      </div>

      <NarrativeDivider />

      {/* ── Sessions today ── */}
      {sessions.length > 0 && (
        <div className="py-2">
          <h4 className="flex items-center gap-2 text-[14px] font-['Crimson_Pro',serif] font-medium text-foreground/80 mb-2">
            <CalendarDays className="w-4 h-4 text-primary/70" />
            Sezení na dnes
          </h4>
          <div className="space-y-2">
            {sessions.map(s => (
              <div key={s.id} className="flex items-start gap-2 text-[13px] text-foreground/70">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/40" />
                <div className="flex-1">
                  <span className="font-medium text-foreground/80">{s.selected_part}</span>
                  <span className="text-foreground/50"> — {s.therapist || "?"}</span>
                  {s.session_plan && (
                    <div className="mt-0.5">
                      <InlineLink label="Otevřít plán sezení" onClick={() => openThread(s.selected_part)} />
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Tasks ── */}
      {tasks.length > 0 && (
        <>
          {sessions.length > 0 && <NarrativeDivider />}
          <div className="py-2">
            <h4 className="flex items-center gap-2 text-[14px] font-['Crimson_Pro',serif] font-medium text-foreground/80 mb-2">
              <ClipboardList className="w-4 h-4 text-primary/70" />
              Úkoly na dnes
            </h4>
            {hankaTasks.length > 0 && (
              <div className="mb-2">
                <span className="text-[11px] font-medium uppercase tracking-wider text-foreground/45">Hanka</span>
                <ul className="mt-0.5 space-y-1">
                  {hankaTasks.slice(0, 5).map(t => (
                    <li key={t.id} className="text-[13px] text-foreground/70 flex items-start gap-2">
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/30" />
                      <span className="flex-1">{t.task}</span>
                      <InlineLink label="Splnit" onClick={() => openNewKarelThread()} />
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {kataTasks.length > 0 && (
              <div className="mb-2">
                <span className="text-[11px] font-medium uppercase tracking-wider text-foreground/45">Káťa</span>
                <ul className="mt-0.5 space-y-1">
                  {kataTasks.slice(0, 5).map(t => (
                    <li key={t.id} className="text-[13px] text-foreground/70 flex items-start gap-2">
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/30" />
                      <span className="flex-1">{t.task}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {sharedTasks.length > 0 && (
              <ul className="space-y-1">
                {sharedTasks.slice(0, 3).map(t => (
                  <li key={t.id} className="text-[13px] text-foreground/70 flex items-start gap-2">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/30" />
                    {t.task}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      {/* ── Unanswered questions ── */}
      {questions.length > 0 && (
        <>
          <NarrativeDivider />
          <div className="py-2">
            <h4 className="flex items-center gap-2 text-[14px] font-['Crimson_Pro',serif] font-medium text-foreground/80 mb-2">
              <HelpCircle className="w-4 h-4 text-accent/70" />
              Čekám na vaše odpovědi
            </h4>
            <ul className="space-y-2">
              {questions.slice(0, 5).map(q => (
                <li key={q.id} className="text-[13px] text-foreground/70 flex items-start gap-2">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent/30" />
                  <div className="flex-1">
                    <span>{q.question}</span>
                    {q.directed_to && <span className="text-foreground/40 ml-1">→ {q.directed_to}</span>}
                    <div className="mt-0.5">
                      <InlineLink label="Odpovědět" onClick={openFeedback} />
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      {/* ── Closing encouragement + help offer ── */}
      <NarrativeDivider />
      <div className="py-2 space-y-3">
        <p className="text-[13px] leading-6 text-foreground/65 font-['DM_Sans',sans-serif]">
          {tasks.length > 3
            ? "Vím, že toho je hodně. Nechci vás zahlcovat — začněte tím nejdůležitějším a já vám pomohu s čímkoli dalším."
            : "Jsem tu pro vás. Kdykoli potřebujete poradit nebo se zasekáte, otevřete rozhovor se mnou."
          }"
        </p>
        <button
          onClick={openNewKarelThread}
          className="inline-flex items-center gap-2 text-[13px] font-medium text-primary hover:underline underline-offset-2 cursor-pointer transition-colors"
        >
          <MessageCircle className="w-4 h-4" />
          Potřebuji Karlovu pomoc
        </button>
      </div>

      {/* ── Therapist input ── */}
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

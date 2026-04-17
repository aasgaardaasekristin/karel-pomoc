import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Textarea } from "@/components/ui/textarea";
import {
  Send, MessageCircle, ClipboardList, HelpCircle,
  CalendarDays, ArrowRight, Users, Lightbulb, AlertTriangle, CheckCircle2, ThumbsUp, Edit3,
  Sparkles, TrendingDown, HelpCircle as HelpCircle2, Zap,
} from "lucide-react";
import { toast } from "sonner";
import { pragueTodayISO } from "@/lib/dateOnlyTaskHelpers";

interface SnapshotItem {
  entity: string;
  owner: string;
  reason: string;
  lastUpdate: string | null;
  deadline?: string | null;
  ctaPath: string;
}

interface DashboardSnapshot {
  todayNew?: SnapshotItem[];
  todayWorse?: SnapshotItem[];
  todayUnconfirmed?: SnapshotItem[];
  todayActionRequired?: SnapshotItem[];
}

interface Props {
  refreshTrigger: number;
  hasCrisisBanner?: boolean;
  snapshot?: DashboardSnapshot | null;
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

/* ── Prohibited task patterns (Karel's work, not therapist's) ── */
const PROHIBITED_TASK_PATTERNS = [
  /p[řr]iprav/i, /sestav/i, /vymysli/i, /zpracuj/i, /vytvo[řr]/i,
  /projdi.*kartu/i, /zaktualizuj/i, /dopl[ňn].*kartu/i, /napl[áa]nuj/i,
  /analyzuj/i, /navrhni.*sc[ée]n/i, /navrhni.*techniku/i,
  /p[řr]iprav.*v[ěe]ty/i, /p[řr]iprav.*sc[ée]n/i, /projdi si/i,
  /p[řr]iprav.*pro\s+(han|k[áa]t)/i, /p[řr]iprav.*krizov/i,
  /udělej/i, /vypracuj/i, /zformuluj/i,
];
function isProhibitedTask(text: string): boolean {
  return PROHIBITED_TASK_PATTERNS.some(p => p.test(text));
}

/* ── Structured deficit question ── */
interface DeficitQuestion {
  question: string;
  intro: string;
  karelProposal: string;
  ifUnknownHelp: string;
  partName?: string;
}

/* ── Meeting seed for structured handoff ── */
interface MeetingSeed {
  topic: string;
  reason: string;
  karelProposal: string;
  questionsHanka: string;
  questionsKata: string;
}

/* ── Inline Question Field (structured) ── */
const InlineQuestionField = ({
  item,
  onSubmit,
}: {
  item: DeficitQuestion;
  onSubmit: (answer: string, question: string) => void;
}) => {
  const [answer, setAnswer] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [sending, setSending] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  const handleSubmit = async () => {
    if (!answer.trim()) return;
    setSending(true);
    try {
      await onSubmit(answer.trim(), item.question);
      setSubmitted(true);
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
        <span className="italic">Děkuji — tuto informaci ihned zapracuji do plánu.</span>
      </div>
    );
  }

  return (
    <div className="border-l-2 border-primary/20 pl-3 space-y-1.5">
      {/* Karel's intro / what he knows */}
      <p className="text-[12.5px] text-foreground/55 italic leading-5">
        {item.intro}
      </p>
      {/* Karel's proposal / suggestion */}
      <p className="text-[13px] text-foreground/70 leading-5">
        💡 <span className="font-medium">{item.karelProposal}</span>
      </p>
      {/* The question itself */}
      <p className="text-[13px] text-foreground/80 font-medium leading-5">
        {item.question}
      </p>
      {/* Answer textarea */}
      <Textarea
        value={answer}
        onChange={e => setAnswer(e.target.value)}
        placeholder="Napište odpověď…"
        className="min-h-[40px] max-h-[80px] text-[12.5px] bg-card/60 border-border/40 resize-none"
        rows={2}
      />
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={handleSubmit}
          disabled={!answer.trim() || sending}
          className="inline-flex items-center gap-1.5 text-[12px] font-medium px-3 py-1 rounded-md bg-primary/10 hover:bg-primary/20 text-primary transition-colors disabled:opacity-40"
        >
          <Send className="w-3 h-3" />
          Odeslat
        </button>
        <button
          onClick={() => setShowHelp(!showHelp)}
          className="text-[11px] text-foreground/40 hover:text-foreground/60 underline underline-offset-2 transition-colors"
        >
          Nevím jak zjistit…
        </button>
      </div>
      {showHelp && (
        <p className="text-[12px] text-primary/60 bg-primary/5 rounded p-2 leading-5">
          {item.ifUnknownHelp}
        </p>
      )}
    </div>
  );
};

const KarelDailyPlan = ({ refreshTrigger, hasCrisisBanner = false, snapshot: snapshotFromProps = null }: Props) => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const hasLoadedOnce = useRef(false);
  const [hankaMessage, setHankaMessage] = useState("");
  const [kataMessage, setKataMessage] = useState("");
  const [sendingHanka, setSendingHanka] = useState(false);
  const [sendingKata, setSendingKata] = useState(false);
  const [sessionConfirmed, setSessionConfirmed] = useState<Record<string, boolean>>({});
  const [sessionFeedback, setSessionFeedback] = useState<Record<string, string>>({});
  const [showSessionFeedback, setShowSessionFeedback] = useState<Record<string, boolean>>({});

  // Data
  const [tasks, setTasks] = useState<{ id: string; task: string; assigned_to: string; status: string; priority: string; created_at?: string; detail_instruction?: any }[]>([]);
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

  // ── Snapshot (4-section command data) — uses prop if provided, else local cache + fetch
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(snapshotFromProps);

  useEffect(() => {
    if (snapshotFromProps) { setSnapshot(snapshotFromProps); return; }
    let alive = true;
    (async () => {
      try {
        const { data: u } = await supabase.auth.getUser();
        const userId = u?.user?.id || "anon";
        const today = new Date().toISOString().slice(0, 10);
        const cacheKey = `karel-command:${userId}:${today}`;
        // Read cache first
        try {
          const cached = localStorage.getItem(cacheKey);
          if (cached && alive) {
            const parsed = JSON.parse(cached);
            if (parsed?.snapshot) setSnapshot(parsed.snapshot);
          }
        } catch { /* ignore */ }

        // Refetch
        const { data: { session } } = await supabase.auth.getSession();
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
        const resp = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-daily-dashboard`,
          { method: "POST", headers, body: JSON.stringify({ mode: "snapshot", date: today }) },
        );
        if (resp.ok) {
          const json = await resp.json();
          if (json?.snapshot && alive) {
            setSnapshot(json.snapshot);
            try { localStorage.setItem(cacheKey, JSON.stringify({ snapshot: json.snapshot, cachedAt: Date.now() })); } catch { /* ignore */ }
          }
        }
      } catch (e) {
        console.warn("[KarelDailyPlan] snapshot fetch failed, keeping cache", e);
      }
    })();
    return () => { alive = false; };
  }, [refreshTrigger, snapshotFromProps]);

  const load = useCallback(async () => {
    if (!hasLoadedOnce.current) setLoading(true);

    try {
      const today = new Date().toISOString().slice(0, 10);
      const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString();

      const [tasksRes, sessionsRes, questionsRes, threadsRes, interviewsRes, crisisRes, planRes] = await Promise.all([
        supabase
          .from("did_therapist_tasks")
          .select("id, task, assigned_to, status, priority, created_at, detail_instruction")
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
      setTasks(deduplicateByText(rawTasks).slice(0, 8));
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
  const handleSendTherapistMessage = async (sender: "hanka" | "kata") => {
    const msg = sender === "hanka" ? hankaMessage : kataMessage;
    if (!msg.trim()) return;
    const setMsg = sender === "hanka" ? setHankaMessage : setKataMessage;
    const setSending = sender === "hanka" ? setSendingHanka : setSendingKata;
    const label = sender === "hanka"
      ? `Vzkaz od Haničky z přehledu — ${new Date().toLocaleDateString("cs-CZ")}`
      : `Vzkaz od Káti z přehledu — ${new Date().toLocaleDateString("cs-CZ")}`;
    setSending(true);
    try {
      const { error } = await supabase.from("did_threads").insert({
        part_name: "system",
        sub_mode: "mamka",
        thread_label: label,
        messages: [{ role: "user", content: msg.trim() }],
        last_activity_at: new Date().toISOString(),
      });
      if (error) throw error;
      toast.success("Vzkaz odeslán — Karel zpracuje při příštím cyklu");
      setMsg("");
    } catch (e: any) {
      toast.error(`Odeslání selhalo: ${e.message}`);
    } finally {
      setSending(false);
    }
  };

  // ── Save inline answer to did_pending_questions (canonical) ──
  const saveInlineAnswer = async (questionText: string, answer: string) => {
    const { error } = await (supabase as any).from("did_pending_questions").insert({
      question: questionText,
      directed_to: "both",
      status: "answered",
      answer: answer,
      answered_at: new Date().toISOString(),
      answered_by: "therapist_inline",
      source: "daily_plan_inline",
      part_name: "system",
      expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
    });
    if (error) {
      console.warn("[KarelDailyPlan] pending_questions insert failed, fallback to did_threads:", error);
      const { error: threadErr } = await supabase.from("did_threads").insert({
        part_name: "Karel",
        sub_mode: "mamka",
        thread_label: `Odpověď: ${questionText.slice(0, 60)}`,
        messages: [
          { role: "assistant", content: questionText },
          { role: "user", content: answer },
        ],
        last_activity_at: new Date().toISOString(),
      });
      if (threadErr) throw threadErr;
    }
    toast.success("Děkuji — tuto informaci ihned zapracuji do plánu.");
  };

  // ── Session plan confirmation ──
  const confirmSession = async (sessionId: string, partName: string) => {
    setSessionConfirmed(prev => ({ ...prev, [sessionId]: true }));
    toast.success(`Plán sezení s ${partName} potvrzen.`);
  };

  const submitSessionFeedback = async (sessionId: string, partName: string) => {
    const fb = sessionFeedback[sessionId]?.trim();
    if (!fb) return;
    await (supabase as any).from("did_pending_questions").insert({
      question: `Zpětná vazba k plánu sezení s ${partName}: ${fb}`,
      directed_to: "karel",
      status: "answered",
      answer: fb,
      answered_at: new Date().toISOString(),
      answered_by: "therapist_inline",
      source: "session_plan_feedback",
      part_name: partName,
      expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
    });
    setSessionConfirmed(prev => ({ ...prev, [sessionId]: true }));
    setShowSessionFeedback(prev => ({ ...prev, [sessionId]: false }));
    toast.success("Zpětná vazba odeslána — Karel upraví plán.");
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

  const openMeeting = (seed: MeetingSeed) => {
    const params = new URLSearchParams();
    params.set("didFlowState", "meeting");
    params.set("meeting_topic", seed.topic.slice(0, 80));
    try {
      sessionStorage.setItem("karel_hub_section", "did");
      sessionStorage.setItem("karel_meeting_seed", JSON.stringify(seed));
    } catch {}
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

  // Deduplicate sessions by part name
  const uniqueSessions = sessions.reduce((acc, s) => {
    if (!acc.find(x => x.selected_part === s.selected_part)) acc.push(s);
    return acc;
  }, [] as typeof sessions);

  // ══════════════════════════════════════════════════
  // ── BUILD KAREL'S LIVE NARRATIVE (unified for both modes) ──
  // ══════════════════════════════════════════════════

  const buildNarrativeParagraphs = (): string[] => {
    const paragraphs: string[] = [];

    // ═══ 1. CRISIS — always first ═══
    if (crisisPartName && !hasCrisisBanner) {
      paragraphs.push(`⚠ ${crisisPartName} je v aktivní krizi — potřebuji vaši plnou pozornost a koordinaci. Toto je nyní absolutní priorita.`);
    }

    if (isInfoDeficit) {
      // ═══ DEFICIT MODE — MANDATORY 5 SECTIONS SAME AS NORMAL ═══
      const lastKnownSnippet = plan05ANarrative?.slice(0, 250) || "";
      const uniqueParts = [...new Set(recentThreads.map(t => t.part_name))];

      // ── SECTION A: "Co vím" ──
      const deficitCoVim: string[] = [];
      if (lastKnownSnippet) {
        deficitCoVim.push(`Poslední data mám z doby před ${daysWithoutData} dny. ${lastKnownSnippet}`);
      } else if (uniqueParts.length > 0) {
        deficitCoVim.push(`Poslední kontakt s ${uniqueParts[0]} proběhl ${relativeTime(lastAnyActivity)}. Od té doby nemám nové zprávy.`);
      } else {
        deficitCoVim.push(`Uplynulo ${daysWithoutData} dní od poslední aktualizace. Nemám žádné čerstvé operativní zprávy.`);
      }
      paragraphs.push(deficitCoVim.join(" "));

      // ── SECTION B: "Co z toho plyne" ──
      const deficitImplications: string[] = [];
      if (crisisPartName) {
        deficitImplications.push(`Krizová situace u ${crisisPartName} trvá i bez aktuálních dat — to zvyšuje riziko.`);
      }
      if (daysWithoutData > 7) {
        deficitImplications.push("Bez informací déle než týden nemohu zodpovědně koordinovat péči ani vyhodnotit dynamiku systému.");
      } else {
        deficitImplications.push("Bez aktuálních pozorování pracuji se zastaralými daty — moje doporučení mohou být nepřesná.");
      }
      paragraphs.push(deficitImplications.join(" "));

      // ── SECTION C: "Co navrhuji" ──
      const deficitProposals: string[] = [];
      const urgentDeficitTasks = tasks.filter(t => t.priority === "critical" || t.priority === "high");
      if (urgentDeficitTasks.length > 0) {
        deficitProposals.push(`Prioritou dnes je: ${urgentDeficitTasks[0].task.slice(0, 100)}.`);
      }
      deficitProposals.push("Navrhuji dnes obnovit komunikaci — potřebuji alespoň stručné pozorování o aktuálním fungování systému.");
      paragraphs.push(deficitProposals.join(" "));

      // ── SECTION D: "Co od Haničky" ──
      const hDeficitTasks = tasks.filter(t => detectTarget(t.assigned_to) === "hanka" && !isProhibitedTask(t.task));
      if (hDeficitTasks.length > 0) {
        paragraphs.push(`Haničko, čekám na tebe v ${hDeficitTasks.length} bod${hDeficitTasks.length === 1 ? "u" : "ech"}: ${hDeficitTasks.slice(0, 2).map(t => t.task.slice(0, 60)).join("; ")}. A především — potřebuji tvé aktuální pozorování.`);
      } else {
        paragraphs.push("Haničko, potřebuji od tebe alespoň krátkou zprávu o aktuálním stavu systému — co pozoruješ, jak části fungují v každodenním životě.");
      }

      // ── SECTION E: "Co od Káti" ──
      const kDeficitTasks = tasks.filter(t => detectTarget(t.assigned_to) === "kata" && !isProhibitedTask(t.task));
      if (kDeficitTasks.length > 0) {
        paragraphs.push(`Káťo, čekám na tebe v ${kDeficitTasks.length} bod${kDeficitTasks.length === 1 ? "u" : "ech"}: ${kDeficitTasks.slice(0, 2).map(t => t.task.slice(0, 60)).join("; ")}. A především — potřebuji tvé aktuální pozorování.`);
      } else {
        paragraphs.push("Káťo, potřebuji od tebe alespoň krátkou zprávu o aktuálním stavu — co pozoruješ ze své pozice, jak části reagují.");
      }
    } else {
      // ═══ NORMAL MODE — MANDATORY 5-SECTION NARRATIVE ═══

      // ── SECTION A: "Co vím" ──
      const coVimParts: string[] = [];
      if (plan05ANarrative) {
        coVimParts.push(plan05ANarrative);
      }
      if (recentInterviews.length > 0) {
        for (const iv of recentInterviews.slice(0, 2)) {
          const when = relativeTime(iv.started_at);
          let sentence = `${when ? when.charAt(0).toUpperCase() + when.slice(1) : "Nedávno"} jsem vedl rozhovor s ${iv.part_name}`;
          if (iv.summary_for_team) sentence += ` — ${iv.summary_for_team.slice(0, 200)}`;
          if (iv.what_shifted) sentence += ` Posun: ${iv.what_shifted.slice(0, 150)}.`;
          coVimParts.push(sentence);
        }
      }
      if (recentThreads.length > 0 && coVimParts.length === 0) {
        // synthesize from threads — NEVER use "X byl/a naposledy aktivní" format
        const threadSummary = recentThreads.slice(0, 3).map(t => {
          const topic = t.thread_label ? `téma „${t.thread_label.slice(0, 50)}"` : "bez konkrétního tématu";
          return `s ${t.part_name} (${topic}, ${relativeTime(t.last_activity_at)})`;
        }).join(", ");
        coVimParts.push(`V posledních dnech jsem pracoval ${threadSummary}.`);
      }
      if (coVimParts.length === 0) {
        coVimParts.push("Zatím nemám čerstvé operativní zprávy za poslední 3 dny. Čekám na data z denního cyklu.");
      }
      paragraphs.push(coVimParts.join(" "));

      // ── SECTION B: "Co z toho plyne" ──
      const implications: string[] = [];
      if (crisisPartName) {
        implications.push(`Krizová situace u ${crisisPartName} vyžaduje denní monitoring a koordinovaný přístup.`);
      }
      const urgentTasks = tasks.filter(t => t.priority === "critical" || t.priority === "high");
      if (urgentTasks.length > 0) {
        implications.push(`Eviduji ${urgentTasks.length} naléhav${urgentTasks.length === 1 ? "ý úkol" : urgentTasks.length < 5 ? "é úkoly" : "ých úkolů"}, které vyžadují pozornost dnes.`);
      }
      const staleThreads = recentThreads.filter(t => daysSince(t.last_activity_at) >= 2);
      if (staleThreads.length > 0) {
        implications.push(`U ${staleThreads.map(t => t.part_name).join(", ")} jsem nezaznamenal aktivitu déle než 2 dny — potřebuji ověřit, zda je vše v pořádku.`);
      }
      if (implications.length === 0) {
        implications.push("Celková situace je stabilní. Můžeme se soustředit na plánované aktivity a terapeutický postup.");
      }
      paragraphs.push(implications.join(" "));

      // ── SECTION C: "Co navrhuji na dnes" ──
      const proposals: string[] = [];
      if (uniqueSessions.length > 0) {
        proposals.push(`Navrhuji dnes pracovat s ${uniqueSessions.map(s => s.selected_part).join(" a ")} — plán sezení je připraven níže.`);
      }
      if (urgentTasks.length > 0) {
        const topTask = urgentTasks[0];
        proposals.push(`Prioritou číslo jedna je: ${topTask.task.slice(0, 100)}.`);
      }
      if (questions.length > 0) {
        proposals.push(`Potřebuji od vás odpovědi na ${questions.length} otáz${questions.length === 1 ? "ku" : questions.length < 5 ? "ky" : "ek"} — najdete je níže.`);
      }
      if (proposals.length === 0) {
        proposals.push("Dnes doporučuji zaměřit se na reflexi posledních dní a přípravu na další sezení. Pokud máte vlastní postřehy, napište mi.");
      }
      paragraphs.push(proposals.join(" "));

      // ── SECTION D: "Co potřebuji od Haničky" ──
      const hankaNeeds: string[] = [];
      const hTasksFiltered = tasks.filter(t => detectTarget(t.assigned_to) === "hanka" && !isProhibitedTask(t.task));
      if (hTasksFiltered.length > 0) {
        hankaNeeds.push(`Haničko, čekám na tebe v ${hTasksFiltered.length} bod${hTasksFiltered.length === 1 ? "u" : hTasksFiltered.length < 5 ? "ech" : "ech"}: ${hTasksFiltered.slice(0, 2).map(t => t.task.slice(0, 60)).join("; ")}.`);
      }
      const hankaQuestions = questions.filter(q => detectTarget(q.directed_to || "") === "hanka");
      if (hankaQuestions.length > 0) {
        hankaNeeds.push(`Mám pro tebe ${hankaQuestions.length} otáz${hankaQuestions.length === 1 ? "ku" : "ky"} k zodpovězení.`);
      }
      if (hankaNeeds.length === 0) {
        hankaNeeds.push("Haničko, aktuálně od tebe nepotřebuji nic konkrétního — pokud máš vlastní postřehy nebo pozorování, budu rád, když se podělíš.");
      }
      paragraphs.push(hankaNeeds.join(" "));

      // ── SECTION E: "Co potřebuji od Káti" ──
      const kataNeeds: string[] = [];
      const kTasksFiltered = tasks.filter(t => detectTarget(t.assigned_to) === "kata" && !isProhibitedTask(t.task));
      if (kTasksFiltered.length > 0) {
        kataNeeds.push(`Káťo, čekám na tebe v ${kTasksFiltered.length} bod${kTasksFiltered.length === 1 ? "u" : kTasksFiltered.length < 5 ? "ech" : "ech"}: ${kTasksFiltered.slice(0, 2).map(t => t.task.slice(0, 60)).join("; ")}.`);
      }
      const kataQuestions = questions.filter(q => detectTarget(q.directed_to || "") === "kata");
      if (kataQuestions.length > 0) {
        kataNeeds.push(`Mám pro tebe ${kataQuestions.length} otáz${kataQuestions.length === 1 ? "ku" : "ky"} k zodpovězení.`);
      }
      if (kataNeeds.length === 0) {
        kataNeeds.push("Káťo, aktuálně od tebe nepotřebuji nic konkrétního — pokud máš vlastní postřehy nebo pozorování, budu rád, když se podělíš.");
      }
      paragraphs.push(kataNeeds.join(" "));
    }

    return paragraphs;
  };

  const narrativeParagraphs = buildNarrativeParagraphs();

  // ── Karlova rozhodnutí ──
  const decisions = recentInterviews
    .filter(iv => iv.karel_decision_after_interview)
    .slice(0, 2);

  // ── Unclear items ──
  const unclearItems = recentInterviews
    .filter(iv => iv.what_remains_unclear)
    .slice(0, 2);

  // Task groups — with role guard filter
  const filterTasks = (list: typeof tasks) => list.filter(t => !isProhibitedTask(t.task));
  const hankaTasks = filterTasks(tasks.filter(t => detectTarget(t.assigned_to) === "hanka"));
  const kataTasks = filterTasks(tasks.filter(t => detectTarget(t.assigned_to) === "kata"));
  const teamTasks = filterTasks(tasks.filter(t => detectTarget(t.assigned_to) === "team"));

  // ── Structured information deficit questions ──
  const deficitItems: DeficitQuestion[] = [];
  if (isInfoDeficit) {
    const uniqueParts = [...new Set(recentThreads.map(t => t.part_name))];
    const lastKnown = plan05ANarrative?.slice(0, 200) || "Nemám žádné záznamy z poslední doby";

    if (uniqueParts.length > 0) {
      deficitItems.push({
        question: `Jak se ${uniqueParts[0]} chová od posledního kontaktu?`,
        intro: `Poslední kontakt s ${uniqueParts[0]} proběhl ${relativeTime(lastAnyActivity)}. ${lastKnown.slice(0, 150)}`,
        karelProposal: `Zkuste si všimnout: mluví ${uniqueParts[0]} spontánně? Reaguje na oslovení? Jaká je nálada?`,
        ifUnknownHelp: `Stačí krátký popis — i jedna věta pomůže. Napište třeba "nic nového" nebo "komunikuje méně" a já se zeptám přesněji.`,
        partName: uniqueParts[0],
      });
    }

    deficitItems.push({
      question: "Jaký je aktuální stav systému? Co se změnilo v denním fungování?",
      intro: `Od mé poslední aktualizace uplynulo ${daysWithoutData} dní. Potřebuji vědět, co se změnilo v denním fungování.`,
      karelProposal: "Zajímá mě: škola, nálady, konflikty, spánek, jídlo — cokoli, co pozorujete.",
      ifUnknownHelp: "Napište 'beze změn' pokud je vše stabilní, nebo popište konkrétní změnu. Každá informace je cenná.",
    });

    if (daysWithoutData > 5) {
      deficitItems.push({
        question: `Uplynulo ${daysWithoutData} dní bez aktualizace. Co vás zdrželo?`,
        intro: `${daysWithoutData > 7 ? "Toto je neobvykle dlouhá prodleva." : "Zaznamenal jsem delší pauzu."} Chci se ujistit, že je vše v pořádku.`,
        karelProposal: "Pokud jste měly náročné období, řekněte — přizpůsobím plán. Pokud jen nebylo co hlásit, stačí to napsat.",
        ifUnknownHelp: "Můžete napsat třeba 'bylo hodně práce' nebo 'nestíhám' — Karel pomůže s prioritizací.",
      });
    }

    if (crisisPartName) {
      deficitItems.push({
        question: `${crisisPartName} má aktivní krizi — jaký je aktuální stav?`,
        intro: `Krize ${crisisPartName} vyžaduje průběžný monitoring. Bez vašeho pozorování nemohu správně vyhodnotit riziko.`,
        karelProposal: `Všímejte si: je ${crisisPartName} v kontaktu? Reaguje na grounding? Jsou přítomny rizikové signály?`,
        ifUnknownHelp: `Pokud nevíte jak zjistit stav ${crisisPartName}, otevřete se mnou rozhovor — připravím pro vás postup.`,
        partName: crisisPartName,
      });
    }
  }

  // ── Build meeting seed from team task ──
  const buildMeetingSeed = (t: typeof tasks[0]): MeetingSeed => {
    const raw = t.detail_instruction;

    // Try to parse as JSON object first
    let parsed: any = null;
    if (raw && typeof raw === "string") {
      try { parsed = JSON.parse(raw); } catch { parsed = null; }
    } else if (raw && typeof raw === "object") {
      parsed = raw;
    }

    const taskText = t.task || "";
    const detailStr = (typeof raw === "string" ? raw : "") || taskText;

    // If parsed is a structured object, use it
    if (parsed && typeof parsed === "object" && (parsed.reason || parsed.proposal)) {
      return {
        topic: taskText,
        reason: parsed.reason || parsed.why || detailStr,
        karelProposal: parsed.proposal || parsed.karel_proposal || `Na základě aktuální situace navrhuji: ${taskText}`,
        questionsHanka: parsed.for_hanka || parsed.questions_hanka || `Haničko, jaký je tvůj pohled na: ${taskText.slice(0, 80)}?`,
        questionsKata: parsed.for_kata || parsed.questions_kata || `Káťo, jaký je tvůj pohled na: ${taskText.slice(0, 80)}?`,
      };
    }

    // Plain string — build deterministic briefing
    return {
      topic: taskText,
      reason: detailStr,
      karelProposal: `Situaci jsem vyhodnotil a navrhuji tento postup: zaměřit se na „${taskText.slice(0, 80)}" s konkrétním plánem kroků. ${detailStr !== taskText ? detailStr.slice(0, 200) : "Detaily prodiskutujeme na poradě."}`,
      questionsHanka: `Haničko, potřebuji tvé konkrétní pozorování k tématu „${taskText.slice(0, 60)}". Co jsi zaznamenala v chování části? Jaké změny pozoruješ?`,
      questionsKata: `Káťo, potřebuji tvůj pohled z tvé pozice k tématu „${taskText.slice(0, 60)}". Co jsi zaznamenala? Jak to koresponduje s tím, co vidí Hanička?`,
    };
  };

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

      {/* ── B. Unified narrative — live prose, never a list ── */}
      <div className="pb-1">
        {narrativeParagraphs.map((para, i) => (
          <p key={i} className="text-[13.5px] leading-7 text-foreground/75 font-['DM_Sans',sans-serif] mt-1.5">
            {para}
          </p>
        ))}
      </div>

      {/* ── B2. 4 sekce dneška — velitelský pohled ze snapshotu ── */}
      <CommandFourSections snapshot={snapshot} navigate={navigate} />

      {/* ── INFO DEFICIT: inline structured questions ── */}
      {isInfoDeficit && deficitItems.length > 0 && (
        <>
          <NarrativeDivider />
          <div className="py-2">
            <SectionHead icon={<AlertTriangle className="w-4 h-4 text-accent/70" />}>
              Karlovy otázky — odpovězte přímo zde
            </SectionHead>
            <div className="space-y-5">
              {deficitItems.map((item, i) => (
                <InlineQuestionField
                  key={i}
                  item={item}
                  onSubmit={(answer, question) => saveInlineAnswer(question, answer)}
                />
              ))}
            </div>
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

      {/* ── D. Návrh sezení na dnes s potvrzovacím workflow ── */}
      {uniqueSessions.length > 0 && (
        <>
          <NarrativeDivider />
          <div className="py-2">
            <SectionHead icon={<CalendarDays className="w-4 h-4 text-primary/60" />}>
              Návrh sezení na dnes
            </SectionHead>
            <p className="text-[13px] text-foreground/65 mb-2">
              Na základě aktuálního stavu a terapeutického plánu navrhuji dnes pracovat s {uniqueSessions.map(s => s.selected_part).join(" a ")}:
            </p>
            <div className="space-y-3">
              {uniqueSessions.map(s => (
                <div key={s.id} className="border-l-2 border-primary/20 pl-3">
                  <div className="flex items-start gap-2 text-[13px] text-foreground/70">
                    <div className="flex-1">
                      <span className="font-medium text-foreground/80">{s.selected_part}</span>
                      <span className="text-foreground/50"> — {s.therapist || "terapeutka dle domluvy"}</span>
                      <div className="mt-1">
                        <ActionLink label="Otevřít plán sezení" onClick={() => openSessionPlan(s.selected_part)} />
                      </div>
                    </div>
                  </div>
                  {/* Confirmation workflow */}
                  {!sessionConfirmed[s.id] ? (
                    <div className="mt-2 flex items-center gap-2">
                      <button
                        onClick={() => confirmSession(s.id, s.selected_part)}
                        className="inline-flex items-center gap-1.5 text-[12px] font-medium px-3 py-1 rounded-md bg-primary/10 hover:bg-primary/20 text-primary transition-colors"
                      >
                        <ThumbsUp className="w-3 h-3" />
                        Souhlasím
                      </button>
                      <button
                        onClick={() => setShowSessionFeedback(prev => ({ ...prev, [s.id]: true }))}
                        className="inline-flex items-center gap-1.5 text-[12px] font-medium px-3 py-1 rounded-md bg-accent/10 hover:bg-accent/20 text-accent-foreground transition-colors"
                      >
                        <Edit3 className="w-3 h-3" />
                        Změnit
                      </button>
                    </div>
                  ) : (
                    <div className="mt-1 flex items-center gap-1.5 text-[12px] text-primary/70">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span className="italic">Potvrzeno — připravuji podklady.</span>
                    </div>
                  )}
                  {showSessionFeedback[s.id] && !sessionConfirmed[s.id] && (
                    <div className="mt-2 space-y-1.5">
                      <Textarea
                        value={sessionFeedback[s.id] || ""}
                        onChange={e => setSessionFeedback(prev => ({ ...prev, [s.id]: e.target.value }))}
                        placeholder="Co byste chtěly změnit v plánu sezení?"
                        className="min-h-[40px] max-h-[80px] text-[12.5px] bg-card/60 border-border/40 resize-none"
                        rows={2}
                      />
                      <button
                        onClick={() => submitSessionFeedback(s.id, s.selected_part)}
                        disabled={!sessionFeedback[s.id]?.trim()}
                        className="inline-flex items-center gap-1.5 text-[12px] font-medium px-3 py-1 rounded-md bg-primary/10 hover:bg-primary/20 text-primary transition-colors disabled:opacity-40"
                      >
                        <Send className="w-3 h-3" />
                        Odeslat změnu
                      </button>
                    </div>
                  )}
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
              Následující body potřebuji prodiskutovat s oběma. Kliknutím otevřete poradní prostor s mým konkrétním briefingem:
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
                        onClick={() => openMeeting(buildMeetingSeed(t))}
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
      <div className="pt-2 pb-1 space-y-3">
        <p className="text-[12px] text-foreground/45 mb-1 font-['DM_Sans',sans-serif]">
          Napište Karlovi vzkaz — zpracuji to v příštím cyklu:
        </p>
        {/* Hanička */}
        <div className="flex gap-2 items-end">
          <div className="flex-1">
            <label className="text-[11px] text-foreground/50 font-medium mb-1 block">📝 Haničko, tvůj vzkaz pro Karla:</label>
            <Textarea
              value={hankaMessage}
              onChange={e => setHankaMessage(e.target.value)}
              placeholder={'Např. „Dnes nemůžu přijít…" nebo „Všimla jsem si, že Tundrupek…"'}
              className="min-h-[42px] max-h-[80px] text-[13px] bg-card/60 border-border/40 resize-none"
              rows={1}
            />
          </div>
          <button
            onClick={() => handleSendTherapistMessage("hanka")}
            disabled={!hankaMessage.trim() || sendingHanka}
            className="shrink-0 p-2 rounded-lg bg-primary/10 hover:bg-primary/20 text-primary transition-colors disabled:opacity-40"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
        {/* Káťa */}
        <div className="flex gap-2 items-end">
          <div className="flex-1">
            <label className="text-[11px] text-foreground/50 font-medium mb-1 block">📝 Káťo, tvůj vzkaz pro Karla:</label>
            <Textarea
              value={kataMessage}
              onChange={e => setKataMessage(e.target.value)}
              placeholder={'Např. „Mám nový postřeh k…" nebo „Potřebuji poradit s…"'}
              className="min-h-[42px] max-h-[80px] text-[13px] bg-card/60 border-border/40 resize-none"
              rows={1}
            />
          </div>
          <button
            onClick={() => handleSendTherapistMessage("kata")}
            disabled={!kataMessage.trim() || sendingKata}
            className="shrink-0 p-2 rounded-lg bg-primary/10 hover:bg-primary/20 text-primary transition-colors disabled:opacity-40"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};

/* ── 4-section command snapshot block ── */
function CommandFourSections({
  snapshot,
  navigate,
}: {
  snapshot: DashboardSnapshot | null;
  navigate: (path: string) => void;
}) {
  if (!snapshot) return null;
  const sections: Array<{
    key: string;
    title: string;
    icon: React.ReactNode;
    items: SnapshotItem[];
  }> = [
    { key: "new", title: "Dnes nově", icon: <Sparkles className="w-3.5 h-3.5 text-primary/70" />, items: snapshot.todayNew || [] },
    { key: "worse", title: "Dnes horší", icon: <TrendingDown className="w-3.5 h-3.5 text-destructive/80" />, items: snapshot.todayWorse || [] },
    { key: "unconfirmed", title: "Dnes nepotvrzené", icon: <HelpCircle2 className="w-3.5 h-3.5 text-accent/70" />, items: snapshot.todayUnconfirmed || [] },
    { key: "action", title: "Dnes vyžaduje zásah", icon: <Zap className="w-3.5 h-3.5 text-destructive/80" />, items: snapshot.todayActionRequired || [] },
  ];
  const total = sections.reduce((n, s) => n + s.items.length, 0);
  if (total === 0) return null;

  const fmtRel = (iso: string | null | undefined) => {
    if (!iso) return "—";
    const ms = Date.now() - new Date(iso).getTime();
    const h = Math.round(ms / 3_600_000);
    if (h < 1) return "před chvílí";
    if (h < 24) return `před ${h}h`;
    const d = Math.round(h / 24);
    return d === 1 ? "včera" : `před ${d}d`;
  };
  const fmtDeadline = (iso: string | null | undefined) => {
    if (!iso) return null;
    try { return new Date(iso).toLocaleDateString("cs", { day: "2-digit", month: "2-digit" }); } catch { return null; }
  };

  const goTo = (path: string) => {
    try { sessionStorage.setItem("karel_hub_section", "did"); } catch { /* ignore */ }
    navigate(path);
  };

  return (
    <>
      <div className="jung-divider my-4" />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {sections.map((sec) => (
          sec.items.length === 0 ? null : (
            <div key={sec.key} className="rounded-lg border border-border/40 bg-card/30 p-3">
              <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {sec.icon}
                {sec.title}
                <span className="ml-auto text-[10.5px] text-muted-foreground/70">{sec.items.length}</span>
              </div>
              <ul className="space-y-1.5">
                {sec.items.slice(0, 5).map((it, i) => {
                  const dl = fmtDeadline(it.deadline);
                  return (
                    <li key={i} className="text-[12px] leading-5 text-foreground/85">
                      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                        <span className="font-medium text-foreground">{it.entity}</span>
                        {it.owner && (
                          <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-foreground/80">
                            {it.owner}
                          </span>
                        )}
                        <span className="text-[10.5px] text-muted-foreground">· {fmtRel(it.lastUpdate)}</span>
                        {dl && (
                          <span className="text-[10.5px] uppercase tracking-wide text-muted-foreground">
                            · deadline {dl}
                          </span>
                        )}
                      </div>
                      <div className="text-[11.5px] text-foreground/70 leading-5">{it.reason}</div>
                      {it.ctaPath && (
                        <button
                          onClick={() => goTo(it.ctaPath)}
                          className="mt-0.5 inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
                        >
                          Otevřít <ArrowRight className="w-3 h-3" />
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )
        ))}
      </div>
    </>
  );
}

export default KarelDailyPlan;

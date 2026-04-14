import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";

interface Props {
  refreshTrigger: number;
}

interface CrisisJournalEntry {
  crisis_trend: string | null;
  karel_action: string | null;
  session_summary: string | null;
  part_id: string | null;
  date: string | null;
}

interface PendingTask {
  id: string;
  task: string;
  assigned_to: string;
  priority: string | null;
}

interface PendingQuestion {
  id: string;
  question: string;
  directed_to: string;
}

interface SessionPlan {
  id: string;
  selected_part: string;
  therapist: string;
  session_format: string;
  status: string;
}

interface Commitment {
  id: string;
  commitment_text: string;
  due_date: string;
  committed_by: string;
}

interface Parsed05A {
  crisisContext: string;
  sessions: string;
  tasks: string;
  questions: string;
  urgentFollowUp: string;
  karelOverview: string;
  partsOverview: string;
  recoveryMode: string;
  raw: string;
  cycleInfo: string;
}

function parse05A(text: string): Parsed05A {
  const clean = text.replace(/\r\n/g, "\n");

  const extractSection = (label: string): string => {
    const re = new RegExp(`━━━\\s*${label}\\s*━━━\\n([\\s\\S]*?)(?=━━━|═══|$)`, "i");
    const m = clean.match(re);
    return m?.[1]?.trim() || "";
  };

  const headerMatch = clean.match(/Datum:\s*([^\n]+)/);
  const cycleInfo = headerMatch?.[1]?.trim() || "";

  return {
    crisisContext: extractSection("1\\.\\s*KRIZOVÝ KONTEXT"),
    sessions: extractSection("2\\.\\s*PLÁNOVANÁ SEZENÍ"),
    tasks: extractSection("3\\.\\s*ÚKOLY"),
    questions: extractSection("4\\.\\s*OTEVŘENÉ OTÁZKY"),
    urgentFollowUp: extractSection("5\\.\\s*URGENTNÍ FOLLOW-UP"),
    karelOverview: extractSection("6\\.\\s*KARLŮV PŘEHLED"),
    partsOverview: extractSection("7\\.\\s*PŘEHLED ČÁSTÍ"),
    recoveryMode: extractSection("8\\.\\s*REŽIM OBNOVY ŘÍZENÍ"),
    raw: clean,
    cycleInfo,
  };
}

/** Turn raw section text into clean prose sentences. */
const extractProse = (text: string): string => {
  if (!text) return "";
  return text
    .split("\n")
    .map((l) => l.replace(/^[\s•\-–—*0-9.()]+/, "").trim())
    .filter(Boolean)
    .filter((l) => !/^\(?žádné|n\/a|bez změny\)?$/i.test(l))
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .trim();
};

const KarelDailyPlan = ({ refreshTrigger }: Props) => {
  const [plan05A, setPlan05A] = useState<Parsed05A | null>(null);
  const [source, setSource] = useState<"05A" | "db" | "loading">("loading");

  const prevRawRef = useRef<string>("");
  const hasLoadedOnce = useRef(false);

  const [crisisPartName, setCrisisPartName] = useState<string | null>(null);
  const [crisisDays, setCrisisDays] = useState<number | null>(null);
  const [crisisJournal, setCrisisJournal] = useState<CrisisJournalEntry | null>(null);
  const [tasks, setTasks] = useState<PendingTask[]>([]);
  const [questions, setQuestions] = useState<PendingQuestion[]>([]);
  const [sessions, setSessions] = useState<SessionPlan[]>([]);
  const [commitments, setCommitments] = useState<Commitment[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!hasLoadedOnce.current) {
      setLoading(true);
    }

    try {
      try {
        const { data: fnData, error: fnError } = await supabase.functions.invoke("karel-did-drive-read", {
          body: {
            documents: ["05A_OPERATIVNI_PLAN"],
            subFolder: "00_CENTRUM",
          },
        });

        if (!fnError && fnData?.documents?.["05A_OPERATIVNI_PLAN"]) {
          const raw = fnData.documents["05A_OPERATIVNI_PLAN"] as string;
          if (raw.length > 50 && !raw.startsWith("[Dokument")) {
            if (raw === prevRawRef.current && hasLoadedOnce.current) {
              setLoading(false);
              return;
            }
            prevRawRef.current = raw;
            const parsed = parse05A(raw);
            setPlan05A(parsed);
            setSource("05A");
            setLoading(false);
            hasLoadedOnce.current = true;
            return;
          }
        }
      } catch (driveErr) {
        console.warn("[KarelDailyPlan] 05A Drive read failed, falling back to DB:", driveErr);
      }

      setSource("db");
      const today = new Date().toISOString().slice(0, 10);

      const [tasksRes, questionsRes, sessionsRes, commitmentsRes, crisisRes] = await Promise.all([
        supabase
          .from("did_therapist_tasks")
          .select("id, task, assigned_to, priority")
          .in("status", ["pending", "active", "in_progress"])
          .order("priority", { ascending: true })
          .limit(10),
        (supabase as any)
          .from("did_pending_questions")
          .select("id, question, directed_to")
          .in("status", ["pending", "sent"])
          .order("created_at", { ascending: false })
          .limit(10),
        supabase
          .from("did_daily_session_plans")
          .select("id, selected_part, therapist, session_format, status")
          .in("status", ["planned", "in_progress"])
          .gte("plan_date", today)
          .order("urgency_score", { ascending: false })
          .limit(5),
        (supabase as any)
          .from("karel_commitments")
          .select("id, commitment_text, due_date, committed_by")
          .eq("status", "open")
          .lte("due_date", today)
          .order("due_date", { ascending: true })
          .limit(10),
        supabase
          .from("crisis_events")
          .select("id, part_name, days_active")
          .neq("phase", "CLOSED")
          .order("created_at", { ascending: false })
          .limit(1),
      ]);

      setTasks(tasksRes.data || []);
      setQuestions(questionsRes.data || []);
      setSessions(sessionsRes.data || []);
      setCommitments(commitmentsRes.data || []);

      const activeCrisis = crisisRes.data?.[0];
      if (activeCrisis) {
        setCrisisPartName(activeCrisis.part_name);
        setCrisisDays(activeCrisis.days_active);
        const { data: journal } = await (supabase as any)
          .from("crisis_journal")
          .select("crisis_trend, karel_action, session_summary, part_id, date")
          .eq("crisis_event_id", activeCrisis.id)
          .order("date", { ascending: false })
          .limit(1);
        setCrisisJournal(journal?.[0] || null);
      } else {
        setCrisisPartName(null);
        setCrisisDays(null);
        setCrisisJournal(null);
      }
    } catch (err) {
      console.error("[KarelDailyPlan] Load failed:", err);
    } finally {
      setLoading(false);
      hasLoadedOnce.current = true;
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshTrigger]);

  if (loading && !hasLoadedOnce.current) {
    return (
      <div className="jung-card p-5">
        <div className="mb-3 h-5 w-48 animate-pulse rounded bg-muted" />
        <div className="h-4 w-full animate-pulse rounded bg-muted" />
      </div>
    );
  }

  const todayFormatted = new Date().toLocaleDateString("cs-CZ", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  if (source === "05A" && plan05A) {
    const overviewProse = extractProse(plan05A.karelOverview);
    const crisisProse = extractProse(plan05A.crisisContext);
    const followUpProse = extractProse(plan05A.urgentFollowUp);
    const recoveryProse = extractProse(plan05A.recoveryMode);

    // Build a coherent narrative from available sections
    const narrativeParts: string[] = [];
    if (overviewProse) narrativeParts.push(overviewProse);
    if (crisisProse && !overviewProse.toLowerCase().includes(crisisProse.slice(0, 20).toLowerCase())) {
      narrativeParts.push(crisisProse);
    }
    if (followUpProse) narrativeParts.push(followUpProse);
    if (recoveryProse) narrativeParts.push(recoveryProse);

    const fullNarrative = narrativeParts.join(" ").slice(0, 800) || "Karel čeká na dnešní operativní doplnění.";

    return (
      <div className="jung-card space-y-4 p-6">
        <h2 className="jung-section-title text-[20px]">☉ Karlův přehled — {todayFormatted}</h2>

        <div className="rounded-2xl border border-border/70 bg-background/30 p-5">
          <p className="text-[14px] leading-7 text-foreground">{fullNarrative}</p>
        </div>
      </div>
    );
  }

  // DB fallback
  const hasAnything =
    crisisPartName || questions.length > 0 || tasks.length > 0 || sessions.length > 0 || commitments.length > 0;

  if (!hasAnything) {
    return (
      <div className="jung-card p-6">
        <h2 className="jung-section-title mb-2 text-[20px]">☉ Karlův přehled — {todayFormatted}</h2>
        <p className="text-[14px] leading-7 text-muted-foreground">
          Žádné aktivní operativní položky. Karel čeká na nová data.
        </p>
      </div>
    );
  }

  // Build narrative from DB data
  const parts: string[] = [];
  if (crisisPartName) {
    let s = `Nejvyšší priorita dne je ${crisisPartName}`;
    if (crisisDays != null) s += ` (den ${crisisDays})`;
    if (crisisJournal?.crisis_trend) s += `, trend: ${crisisJournal.crisis_trend}`;
    s += ".";
    parts.push(s);
    if (crisisJournal?.karel_action) parts.push(`Karel: ${crisisJournal.karel_action}.`);
  }
  if (sessions.length > 0) parts.push(`Dnes ${sessions.length === 1 ? "je plánované 1 sezení" : `je plánováno ${sessions.length} sezení`}.`);
  if (tasks.length > 0) parts.push(`${tasks.length} otevřených úkolů čeká na zpracování.`);
  if (questions.length > 0) parts.push(`${questions.length} otázek čeká na odpověď od terapeutek.`);

  const overdueCount = commitments.filter((c) => Date.now() > new Date(c.due_date).getTime()).length;
  if (overdueCount > 0) parts.push(`${overdueCount} závazků je po termínu.`);

  const fallbackNarrative = parts.join(" ") || "Karel drží denní orientaci z otevřených úkolů a sezení.";

  return (
    <div className="jung-card space-y-4 p-6">
      <h2 className="jung-section-title text-[20px]">☉ Karlův přehled — {todayFormatted}</h2>
      <div className="rounded-2xl border border-border/70 bg-background/30 p-5">
        <p className="text-[14px] leading-7 text-foreground">{fallbackNarrative}</p>
      </div>
    </div>
  );
};

export default KarelDailyPlan;

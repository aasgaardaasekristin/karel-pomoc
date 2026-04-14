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

interface OverviewCallout {
  label: string;
  text: string;
  tone: "default" | "crisis" | "warning";
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

const normalizeLine = (line: string) =>
  line
    .replace(/^[\s•\-–—*0-9.()]+/, "")
    .replace(/\s+/g, " ")
    .trim();

const uniqueMeaningfulLines = (text: string, limit = 4): string[] => {
  const seen = new Set<string>();

  return text
    .split("\n")
    .map(normalizeLine)
    .filter(Boolean)
    .filter((line) => !/^\(?žádné|n\/a|bez změny\)?$/i.test(line))
    .filter((line) => {
      const key = line.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
};

const buildPlanCallouts = (plan: Parsed05A): OverviewCallout[] => {
  const rawCallouts: OverviewCallout[] = [
    {
      label: "Krizový kontext",
      text: uniqueMeaningfulLines(plan.crisisContext, 1)[0] || "",
      tone: "crisis",
    },
    {
      label: "Urgentní follow-up",
      text: uniqueMeaningfulLines(plan.urgentFollowUp, 1)[0] || "",
      tone: "warning",
    },
    {
      label: "Obnova řízení",
      text: uniqueMeaningfulLines(plan.recoveryMode, 1)[0] || "",
      tone: "default",
    },
  ].filter((item) => item.text);

  const seen = new Set<string>();
  return rawCallouts.filter((item) => {
    const key = `${item.label}|${item.text.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
    const overviewLines = uniqueMeaningfulLines(plan05A.karelOverview, 4);
    const overviewLead = overviewLines[0] || "Karel čeká na krátké dnešní operativní doplnění.";
    const overviewDetails = overviewLines.slice(1);
    const callouts = buildPlanCallouts(plan05A);

    return (
      <div className="jung-card space-y-5 p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="jung-section-title text-[20px]">☉ Karlův přehled — {todayFormatted}</h2>
            {plan05A.cycleInfo ? (
              <p className="mt-1 text-[12px] text-muted-foreground">{plan05A.cycleInfo}</p>
            ) : null}
          </div>
          <span className="rounded-full bg-primary/12 px-2 py-0.5 text-[10px] font-medium text-primary">
            z 05A
          </span>
        </div>

        <div className="rounded-2xl border border-border/70 bg-background/20 p-4 sm:p-5">
          <p className="text-[16px] font-medium leading-8 text-foreground sm:text-[18px]">{overviewLead}</p>
          {overviewDetails.length > 0 ? (
            <div className="mt-4 space-y-2">
              {overviewDetails.map((line) => (
                <div key={line} className="flex items-start gap-2 text-[13px] leading-6 text-muted-foreground">
                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/70" />
                  <span>{line}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        {callouts.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-3">
            {callouts.map((callout) => (
              <div
                key={`${callout.label}-${callout.text}`}
                className={
                  callout.tone === "crisis"
                    ? "rounded-2xl border border-destructive/25 bg-destructive/10 p-3"
                    : callout.tone === "warning"
                      ? "rounded-2xl border border-primary/25 bg-primary/10 p-3"
                      : "rounded-2xl border border-border/70 bg-muted/25 p-3"
                }
              >
                <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  {callout.label}
                </p>
                <p className="mt-1 text-[13px] leading-6 text-foreground">{callout.text}</p>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

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

  const overdueCommitments = commitments.filter((commitment) => {
    const daysOverdue = Math.floor((Date.now() - new Date(commitment.due_date).getTime()) / 86400000);
    return daysOverdue > 0;
  });

  const fallbackCards = [
    crisisPartName
      ? {
          label: "Krize",
          value: `${crisisPartName}${crisisDays != null ? ` — den ${crisisDays}` : ""}`,
        }
      : null,
    sessions.length > 0 ? { label: "Sezení dnes", value: `${sessions.length} aktivních položek` } : null,
    tasks.length > 0 ? { label: "Aktivní úkoly", value: `${tasks.length} otevřených bodů` } : null,
    questions.length > 0 ? { label: "Čeká na odpověď", value: `${questions.length} otázek` } : null,
    overdueCommitments.length > 0
      ? { label: "Po termínu", value: `${overdueCommitments.length} závazků` }
      : null,
  ].filter(Boolean) as { label: string; value: string }[];

  const fallbackLead = crisisPartName
    ? `Nejvyšší priorita dne je ${crisisPartName}${crisisJournal?.crisis_trend ? ` — trend: ${crisisJournal.crisis_trend}` : ""}.`
    : "Karel drží denní orientaci z otevřených úkolů, sezení a čekajících odpovědí.";

  return (
    <div className="jung-card space-y-5 p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="jung-section-title text-[20px]">☉ Karlův přehled — {todayFormatted}</h2>
          <p className="mt-1 text-[12px] text-muted-foreground">Pracovní fallback bez 05A dokumentu</p>
        </div>
        <span className="rounded-full bg-accent/20 px-2 py-0.5 text-[10px] font-medium text-foreground">
          z provozu
        </span>
      </div>

      <div className="rounded-2xl border border-border/70 bg-background/20 p-4 sm:p-5">
        <p className="text-[16px] font-medium leading-8 text-foreground sm:text-[18px]">{fallbackLead}</p>
        {crisisJournal && (crisisJournal.karel_action || crisisJournal.session_summary) ? (
          <p className="mt-3 text-[13px] leading-6 text-muted-foreground">
            {crisisJournal.karel_action ? `Karel: ${crisisJournal.karel_action}` : ""}
            {crisisJournal.karel_action && crisisJournal.session_summary ? " • " : ""}
            {crisisJournal.session_summary ? `Sezení: ${crisisJournal.session_summary}` : ""}
          </p>
        ) : null}
      </div>

      {fallbackCards.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {fallbackCards.map((card) => (
            <div key={`${card.label}-${card.value}`} className="rounded-2xl border border-border/70 bg-muted/25 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                {card.label}
              </p>
              <p className="mt-1 text-[14px] text-foreground">{card.value}</p>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
};

export default KarelDailyPlan;

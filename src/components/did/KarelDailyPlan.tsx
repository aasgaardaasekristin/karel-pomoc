import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { AlertTriangle, CalendarDays, CheckSquare, HelpCircle } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  refreshTrigger: number;
  hasCrisisBanner?: boolean;
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
  cycleInfo: string;
}

/* ── Parse 05A document into structured sections ── */
function parse05A(text: string): Parsed05A {
  const clean = text.replace(/\r\n/g, "\n");

  const extractSection = (label: string): string => {
    const re = new RegExp(`━━━\\s*${label}\\s*━━━\\n([\\s\\S]*?)(?=━━━|═══|$)`, "i");
    const m = clean.match(re);
    return m?.[1]?.trim() || "";
  };

  const headerMatch = clean.match(/Datum:\s*([^\n]+)/);

  return {
    crisisContext: extractSection("1\\.\\s*KRIZOVÝ KONTEXT"),
    sessions: extractSection("2\\.\\s*PLÁNOVANÁ SEZENÍ"),
    tasks: extractSection("3\\.\\s*ÚKOLY"),
    questions: extractSection("4\\.\\s*OTEVŘENÉ OTÁZKY"),
    urgentFollowUp: extractSection("5\\.\\s*URGENTNÍ FOLLOW-UP"),
    karelOverview: extractSection("6\\.\\s*KARLŮV PŘEHLED"),
    partsOverview: extractSection("7\\.\\s*PŘEHLED ČÁSTÍ"),
    recoveryMode: extractSection("8\\.\\s*REŽIM OBNOVY ŘÍZENÍ"),
    cycleInfo: headerMatch?.[1]?.trim() || "",
  };
}

/* ── Extract clean lines from a section ── */
const extractLines = (text: string): string[] => {
  if (!text) return [];
  return text
    .split("\n")
    .map((l) => l.replace(/^[\s•\-–—*]+/, "").trim())
    .filter(Boolean)
    .filter((l) => !/^\(?žádné|n\/a|bez změny|---\)?$/i.test(l));
};

/* ── Extract narrative prose (max N sentences) ── */
const extractProse = (text: string, maxSentences = 3): string => {
  if (!text) return "";
  const lines = extractLines(text);
  const joined = lines.join(". ").replace(/\.\./g, ".").replace(/\s{2,}/g, " ").trim();
  // Limit to N sentences
  const sentences = joined.match(/[^.!?]+[.!?]+/g) || [joined];
  return sentences.slice(0, maxSentences).join(" ").trim();
};

/* ── Split tasks by therapist ── */
const splitByTherapist = (text: string): { hanka: string[]; kata: string[]; both: string[] } => {
  const lines = extractLines(text);
  const hanka: string[] = [];
  const kata: string[] = [];
  const both: string[] = [];

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.includes("hani") || lower.includes("hank") || lower.includes("hanič")) {
      hanka.push(line);
    } else if (lower.includes("kát") || lower.includes("kata") || lower.includes("káťa")) {
      kata.push(line);
    } else {
      both.push(line);
    }
  }
  return { hanka, kata, both };
};

/* ── Section block component ── */
const PlanBlock = ({
  icon,
  title,
  accent,
  children,
  isEmpty,
}: {
  icon: React.ReactNode;
  title: string;
  accent?: "urgent" | "gold" | "muted";
  children: React.ReactNode;
  isEmpty?: boolean;
}) => {
  if (isEmpty) return null;

  const borderClass =
    accent === "urgent"
      ? "border-l-[3px] border-l-destructive"
      : accent === "gold"
        ? "border-l-[3px] border-l-primary"
        : "border-l-[3px] border-l-muted-foreground/20";

  return (
    <div className={cn("rounded-xl bg-card/60 p-4", borderClass)}>
      <h4 className="mb-2 flex items-center gap-2 font-['Crimson_Pro',serif] text-[15px] font-medium text-foreground/80">
        {icon}
        {title}
      </h4>
      <div className="text-[13.5px] leading-relaxed text-foreground/70">{children}</div>
    </div>
  );
};

const KarelDailyPlan = ({ refreshTrigger, hasCrisisBanner = false }: Props) => {
  const [plan05A, setPlan05A] = useState<Parsed05A | null>(null);
  const [source, setSource] = useState<"05A" | "db" | "loading">("loading");
  const prevRawRef = useRef<string>("");
  const hasLoadedOnce = useRef(false);
  const [loading, setLoading] = useState(true);

  // DB fallback state
  const [dbTasks, setDbTasks] = useState<{ task: string; assigned_to: string }[]>([]);
  const [dbSessions, setDbSessions] = useState<{ selected_part: string; therapist: string }[]>([]);
  const [dbQuestions, setDbQuestions] = useState<{ question: string; directed_to: string }[]>([]);
  const [crisisPartName, setCrisisPartName] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!hasLoadedOnce.current) setLoading(true);

    try {
      // Try 05A from Drive first
      try {
        const { data: fnData, error: fnError } = await supabase.functions.invoke("karel-did-drive-read", {
          body: { documents: ["05A_OPERATIVNI_PLAN"], subFolder: "00_CENTRUM" },
        });

        if (!fnError && fnData?.documents?.["05A_OPERATIVNI_PLAN"]) {
          const raw = fnData.documents["05A_OPERATIVNI_PLAN"] as string;
          if (raw.length > 50 && !raw.startsWith("[Dokument")) {
            if (raw === prevRawRef.current && hasLoadedOnce.current) {
              setLoading(false);
              return;
            }
            prevRawRef.current = raw;
            setPlan05A(parse05A(raw));
            setSource("05A");
            setLoading(false);
            hasLoadedOnce.current = true;
            return;
          }
        }
      } catch (driveErr) {
        console.warn("[KarelDailyPlan] 05A Drive read failed, falling back to DB:", driveErr);
      }

      // DB fallback
      setSource("db");
      const today = new Date().toISOString().slice(0, 10);

      const [tasksRes, sessionsRes, questionsRes, crisisRes] = await Promise.all([
        supabase
          .from("did_therapist_tasks")
          .select("task, assigned_to")
          .in("status", ["pending", "active", "in_progress"])
          .order("priority", { ascending: true })
          .limit(10),
        supabase
          .from("did_daily_session_plans")
          .select("selected_part, therapist")
          .in("status", ["planned", "in_progress"])
          .gte("plan_date", today)
          .limit(5),
        (supabase as any)
          .from("did_pending_questions")
          .select("question, directed_to")
          .in("status", ["pending", "sent"])
          .limit(10),
        supabase
          .from("crisis_events")
          .select("part_name")
          .neq("phase", "CLOSED")
          .limit(1),
      ]);

      setDbTasks(tasksRes.data || []);
      setDbSessions(sessionsRes.data || []);
      setDbQuestions(questionsRes.data || []);
      setCrisisPartName(crisisRes.data?.[0]?.part_name || null);
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

  // ── Loading skeleton ──
  if (loading && !hasLoadedOnce.current) {
    return (
      <div className="jung-card p-5">
        <div className="mb-3 h-5 w-48 animate-pulse rounded bg-muted" />
        <div className="space-y-2">
          <div className="h-4 w-full animate-pulse rounded bg-muted" />
          <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
        </div>
      </div>
    );
  }

  const todayFormatted = new Date().toLocaleDateString("cs-CZ", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  // ═══════════════════════════════════════════
  // 05A SOURCE — structured 4-block layout
  // ═══════════════════════════════════════════
  if (source === "05A" && plan05A) {
    const overviewProse = extractProse(plan05A.karelOverview, 3);
    const recoveryProse = extractProse(plan05A.recoveryMode, 2);

    // Urgentní items (skip if crisis banner already covers it)
    const urgentLines = [
      ...(hasCrisisBanner ? [] : extractLines(plan05A.crisisContext)),
      ...extractLines(plan05A.urgentFollowUp),
    ].slice(0, 3);

    const sessionLines = extractLines(plan05A.sessions).slice(0, 5);
    const taskSplit = splitByTherapist(plan05A.tasks);
    const questionLines = extractLines(plan05A.questions).slice(0, 5);

    const narrative = [overviewProse, recoveryProse].filter(Boolean).join(" ") ||
      "Karel čeká na dnešní operativní data.";

    return (
      <div className="jung-card space-y-4 p-6">
        {/* ── Header ── */}
        <h2 className="jung-section-title text-[20px]">
          ☉ Karlův přehled — {todayFormatted}
        </h2>

        {/* ── Narrative overview (max 3 sentences) ── */}
        <p className="text-[14px] leading-7 text-foreground/80 font-['DM_Sans',sans-serif]">
          {narrative}
        </p>

        {/* ── Structured blocks ── */}
        <div className="space-y-3">
          <PlanBlock
            icon={<AlertTriangle className="h-4 w-4 text-destructive" />}
            title="Urgentní"
            accent="urgent"
            isEmpty={urgentLines.length === 0}
          >
            <ul className="space-y-1">
              {urgentLines.map((line, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-destructive/60" />
                  {line}
                </li>
              ))}
            </ul>
          </PlanBlock>

          <PlanBlock
            icon={<CalendarDays className="h-4 w-4 text-primary" />}
            title="Sezení dnes"
            accent="gold"
            isEmpty={sessionLines.length === 0}
          >
            <ul className="space-y-1">
              {sessionLines.map((line, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/50" />
                  {line}
                </li>
              ))}
            </ul>
          </PlanBlock>

          <PlanBlock
            icon={<CheckSquare className="h-4 w-4 text-primary" />}
            title="Úkoly na dnes"
            accent="gold"
            isEmpty={taskSplit.hanka.length + taskSplit.kata.length + taskSplit.both.length === 0}
          >
            <div className="space-y-2">
              {taskSplit.hanka.length > 0 && (
                <div>
                  <span className="text-[12px] font-medium uppercase tracking-wide text-foreground/50">Hanka</span>
                  <ul className="mt-0.5 space-y-0.5">
                    {taskSplit.hanka.slice(0, 5).map((t, i) => (
                      <li key={i}>• {t}</li>
                    ))}
                  </ul>
                </div>
              )}
              {taskSplit.kata.length > 0 && (
                <div>
                  <span className="text-[12px] font-medium uppercase tracking-wide text-foreground/50">Káťa</span>
                  <ul className="mt-0.5 space-y-0.5">
                    {taskSplit.kata.slice(0, 5).map((t, i) => (
                      <li key={i}>• {t}</li>
                    ))}
                  </ul>
                </div>
              )}
              {taskSplit.both.length > 0 && (
                <ul className="space-y-0.5">
                  {taskSplit.both.slice(0, 3).map((t, i) => (
                    <li key={i}>• {t}</li>
                  ))}
                </ul>
              )}
            </div>
          </PlanBlock>

          <PlanBlock
            icon={<HelpCircle className="h-4 w-4 text-accent" />}
            title="Otevřené otázky"
            accent="muted"
            isEmpty={questionLines.length === 0}
          >
            <ul className="space-y-1">
              {questionLines.map((line, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent/40" />
                  {line}
                </li>
              ))}
            </ul>
          </PlanBlock>
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════
  // DB FALLBACK — same 4-block structure
  // ═══════════════════════════════════════════
  const hasAnything = crisisPartName || dbTasks.length > 0 || dbSessions.length > 0 || dbQuestions.length > 0;

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

  // Build narrative from DB
  const narrativeParts: string[] = [];
  if (crisisPartName && !hasCrisisBanner) {
    narrativeParts.push(`Nejvyšší priorita dne: ${crisisPartName}.`);
  }
  if (dbSessions.length > 0) {
    narrativeParts.push(`${dbSessions.length === 1 ? "Jedno plánované sezení" : `${dbSessions.length} plánovaných sezení`} na dnešek.`);
  }
  if (dbTasks.length > 0) {
    narrativeParts.push(`${dbTasks.length} otevřených úkolů.`);
  }
  const narrative = narrativeParts.join(" ") || "Karel drží denní orientaci.";

  const dbHanka = dbTasks.filter((t) => t.assigned_to?.toLowerCase().includes("han"));
  const dbKata = dbTasks.filter((t) => t.assigned_to?.toLowerCase().includes("kát") || t.assigned_to?.toLowerCase().includes("kata"));
  const dbBoth = dbTasks.filter((t) => !dbHanka.includes(t) && !dbKata.includes(t));

  return (
    <div className="jung-card space-y-4 p-6">
      <h2 className="jung-section-title text-[20px]">☉ Karlův přehled — {todayFormatted}</h2>
      <p className="text-[14px] leading-7 text-foreground/80 font-['DM_Sans',sans-serif]">{narrative}</p>

      <div className="space-y-3">
        {crisisPartName && !hasCrisisBanner && (
          <PlanBlock
            icon={<AlertTriangle className="h-4 w-4 text-destructive" />}
            title="Urgentní"
            accent="urgent"
          >
            <p>Aktivní krize: {crisisPartName}</p>
          </PlanBlock>
        )}

        <PlanBlock
          icon={<CalendarDays className="h-4 w-4 text-primary" />}
          title="Sezení dnes"
          accent="gold"
          isEmpty={dbSessions.length === 0}
        >
          <ul className="space-y-1">
            {dbSessions.map((s, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/50" />
                {s.selected_part} — {s.therapist || "?"}
              </li>
            ))}
          </ul>
        </PlanBlock>

        <PlanBlock
          icon={<CheckSquare className="h-4 w-4 text-primary" />}
          title="Úkoly"
          accent="gold"
          isEmpty={dbTasks.length === 0}
        >
          <div className="space-y-2">
            {dbHanka.length > 0 && (
              <div>
                <span className="text-[12px] font-medium uppercase tracking-wide text-foreground/50">Hanka</span>
                <ul className="mt-0.5 space-y-0.5">
                  {dbHanka.slice(0, 5).map((t, i) => <li key={i}>• {t.task}</li>)}
                </ul>
              </div>
            )}
            {dbKata.length > 0 && (
              <div>
                <span className="text-[12px] font-medium uppercase tracking-wide text-foreground/50">Káťa</span>
                <ul className="mt-0.5 space-y-0.5">
                  {dbKata.slice(0, 5).map((t, i) => <li key={i}>• {t.task}</li>)}
                </ul>
              </div>
            )}
            {dbBoth.length > 0 && (
              <ul className="space-y-0.5">
                {dbBoth.slice(0, 3).map((t, i) => <li key={i}>• {t.task}</li>)}
              </ul>
            )}
          </div>
        </PlanBlock>

        <PlanBlock
          icon={<HelpCircle className="h-4 w-4 text-accent" />}
          title="Otevřené otázky"
          accent="muted"
          isEmpty={dbQuestions.length === 0}
        >
          <ul className="space-y-1">
            {dbQuestions.map((q, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent/40" />
                {q.question} <span className="text-muted-foreground">→ {q.directed_to}</span>
              </li>
            ))}
          </ul>
        </PlanBlock>
      </div>
    </div>
  );
};

export default KarelDailyPlan;

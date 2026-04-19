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
import { isTherapistName, normalizeTherapist } from "@/lib/therapistIdentity";
import { voiceGreeting, auditVoiceGuide } from "@/lib/karelVoiceGuide";
// Shared pure-text render pipeline (UI ↔ edge mirror).
// Source of truth: src/lib/karelRender + supabase/functions/_shared/karelRender.
import {
  humanizeText,
  describeUrgentLoad,
  addressTaskTo2ndPerson,
  guardPartName,
  renderTherapistAsk,
} from "@/lib/karelRender";

interface SnapshotItem {
  entity: string;
  owner: string;
  reason: string;
  lastUpdate: string | null;
  deadline?: string | null;
  ctaPath: string;
}

interface CommandCrisisItem {
  crisisEventId?: string | null;
  partName: string;
  severity?: string;
  state?: string;
}

interface DashboardSnapshot {
  todayNew?: SnapshotItem[];
  todayWorse?: SnapshotItem[];
  todayUnconfirmed?: SnapshotItem[];
  todayActionRequired?: SnapshotItem[];
  command?: { crises?: CommandCrisisItem[] };
}

interface Props {
  refreshTrigger: number;
  snapshot?: DashboardSnapshot | null;
  /**
   * 2026-04-19 — VERTICAL SLICE 1:
   * Když je `true`, panel skryje vlastní narativní hlavičku (greeting +
   * 5 odstavců „co vím / co z toho plyne / co navrhuji / Haničko / Káťo")
   * a sekce, které jsou nyní v `DidDailyBriefingPanel`:
   *   - Návrh sezení na dnes (duplicita s proposed_session)
   *   - Haničko / Káťo, potřebuji od tebe (duplicita s ask_hanka / ask_kata)
   *   - Čekám na vaše odpovědi (duplicita s waiting_for + decisions)
   *
   * Zachová ale operativní backlog (CommandFourSections, decisions,
   * unclear, vstupní pole pro vzkazy) — to briefing zatím neumí.
   */
  hideDuplicateBlocks?: boolean;
}

/* ── Greeting by time of day ── (delegated to central voice guide) */
function getGreeting(): string {
  // Strip trailing punctuation/audience for legacy call sites that append ", Haničko..."
  return voiceGreeting("team").replace(/,.*$/, "");
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

/* ──────────────────────────────────────────────────────────────
   HUMANIZATION LAYER — guards user-facing briefing prose against
   internal artefacts leaking from raw DB rows. NEVER bypass these
   helpers when composing narrative sentences.

   Concrete leaks observed in production data this strips:
   - thread_label / task.task starting with "Úkol:", "Otázka:",
     "Sezení:", "Dotaz:", "Téma:" (raw ticket prefixes)
   - "[RECOVERY]" / "[Auto]" / "[AUTO]" / "[SYSTEM]" tags inserted
     by background jobs
   - "🔴 KRIZOVÁ INTERVENCE – PARTNAME – DATE" headlines that are
     valid card titles but read as debug output inside prose
   - empty / whitespace-only / pseudo-name labels (system, karel)
   - duplicated trailing punctuation, double spaces, stray colons
   ────────────────────────────────────────────────────────────── */

/* ──────────────────────────────────────────────────────────────
   HUMANIZATION + IDENTITY + VOICE
   ────────────────────────────────────────────────────────────── 

   All narrative-text helpers used below are imported from the shared
   pure-text pipeline `karelRender` (src/lib/karelRender) which is
   mirrored 1:1 to `supabase/functions/_shared/karelRender` so UI and
   edge prompts speak with the same voice.

   Layers consumed here:
     - identity.ts  → guardPartName(), normalizeTherapist()
     - humanize.ts  → humanizeText(), describeUrgentLoad(),
                      addressTaskTo2ndPerson(), czechTaskWord()
     - template.ts  → renderTherapistAsk()

   DO NOT redefine these helpers locally — that is exactly the drift
   that produced "Eviduji 3 úkoly" / "Káťo, zapojit Káťu" regressions.
*/

/** Thin alias kept for backwards compatibility with existing callsites. */
const isUsableLabel = (raw: string | null | undefined): boolean =>
  guardPartName(raw) !== null;

/* ── Detect therapist target from assigned_to ──
   Uses central normalizeTherapist() — no local substring guessing.
   Returns "team" only when the value resolves to neither therapist. */
function detectTarget(assignedTo: string): "hanka" | "kata" | "team" {
  return normalizeTherapist(assignedTo) ?? "team";
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

/* ── Task framing badge — explicit overdue / stale / archive label.
   Calmer than red urgency: stale tasks get a subtle muted chip instead of
   silently inflating the urgent counter.

   NOTE on `blocked`: the `did_therapist_tasks` table only ever uses
   `pending` / `expired` / `archived` in production. There is no `blocked`
   status anywhere in the write path, so we deliberately do NOT render a
   `blokováno` label here — it would be a dead branch that promises a
   surface state the data layer never produces. If a real "blocked" status
   is ever introduced, re-add the branch here AND extend the visible-task
   query in `load()` to include it; until then keep the framing honest. ── */
const TaskFrameBadge = ({ createdAt, dueDate }: { createdAt?: string; dueDate?: string | null; status?: string }) => {
  const now = Date.now();
  const ageDays = createdAt ? Math.floor((now - new Date(createdAt).getTime()) / 86400000) : 0;
  const isOverdue = !!dueDate && new Date(dueDate).getTime() < now;
  const isArchiveCandidate = ageDays >= 14;
  const isStale = ageDays >= 7 && !isOverdue && !isArchiveCandidate;

  if (!isOverdue && !isStale && !isArchiveCandidate) return null;

  const label = isArchiveCandidate
    ? "k archivaci"
    : isOverdue
    ? "po termínu"
    : "starší úkol";
  const tone = isOverdue
    ? "bg-destructive/10 text-destructive/80 border-destructive/20"
    : "bg-muted/40 text-muted-foreground border-border/40";
  return (
    <span className={`ml-2 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium border ${tone}`}>
      {label}
      {ageDays > 0 ? ` · ${ageDays}d` : ""}
    </span>
  );
};

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
  /** FÁZE 3C: canonical did_daily_session_plans.id when meeting is rooted in today's session. */
  dailyPlanId?: string | null;
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

const KarelDailyPlan = ({ refreshTrigger, snapshot: snapshotFromProps = null, hideDuplicateBlocks = false }: Props) => {
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
  const [tasks, setTasks] = useState<{ id: string; task: string; assigned_to: string; status: string; priority: string; created_at?: string; due_date?: string | null; detail_instruction?: any }[]>([]);
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
  const [plan05ANarrative, setPlan05ANarrative] = useState<string>("");
  const [lastAnyActivity, setLastAnyActivity] = useState<string | null>(null);
  // Fallback only — used when the snapshot has no command crisis.
  // Loaded inside `load()` from crisis_events with the same open-phase filter
  // as the badge / snapshot / detail panel.
  const [fallbackCrisisPart, setFallbackCrisisPart] = useState<string | null>(null);

  // ── Snapshot (4-section command data) — uses prop if provided, else local cache + fetch
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(snapshotFromProps);

  // SINGLE source of truth for crisis priority across ALL narrative / implications /
  // deficit questions. Primary: snapshot.command.crises[0]. Fallback only if snapshot
  // has no crisis but DB does (e.g. snapshot still warming up).
  const snapshotCrisis = (snapshot?.command?.crises && snapshot.command.crises.length > 0)
    ? snapshot.command.crises[0]
    : null;
  const effectiveCrisisPart: string | null = snapshotCrisis?.partName || fallbackCrisisPart || null;

  useEffect(() => {
    if (snapshotFromProps) { setSnapshot(snapshotFromProps); return; }
    let alive = true;
    (async () => {
      try {
        const { data: u } = await supabase.auth.getUser();
        const userId = u?.user?.id || "anon";
        const today = pragueTodayISO();
        const cacheKey = `karel-command:${userId}:${today}`;
        // Read cache first — only accept if cached pragueDate matches today's Prague day.
        try {
          const cached = localStorage.getItem(cacheKey);
          if (cached && alive) {
            const parsed = JSON.parse(cached);
            if (parsed?.snapshot && (!parsed.pragueDate || parsed.pragueDate === today)) {
              setSnapshot(parsed.snapshot);
            }
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
            try {
              localStorage.setItem(cacheKey, JSON.stringify({
                snapshot: json.snapshot,
                pragueDate: today,
                cachedAt: Date.now(),
              }));
            } catch { /* ignore */ }
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
      const today = pragueTodayISO();
      const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString();
      // BUGFIX (stale framing alignment): the dashboard's OpsSnapshotBar
      // surfaces stale tasks (>7d) under a separate "k archivaci" counter,
      // so the briefing MUST also be able to display them — otherwise the
      // counter points at items that have no surface anywhere. We expand
      // the manual-task window to 14 days here and rely on TaskFrameBadge
      // to label each row (po termínu / blokováno / starší úkol / k archivaci).
      const fourteenDaysAgo = new Date(Date.now() - 14 * 86400000).toISOString();

      // BUGFIX (FÁZE 3 dormant leak): every part-derived surface (threads,
      // sessions, interviews, tasks) MUST be filtered against the canonical
      // active registry before it can drive Karel's narrative or
      // recommendations. A dormant/sleeping part with an old thread or stale
      // session record must NOT re-emerge in "co z toho plyne" or "co
      // navrhuji na dnes" without an explicit active reason (open crisis or
      // explicit reactivation in the registry).
      const [planItemsRes, manualTasksRes, sessionsRes, questionsRes, threadsRes, interviewsRes, planRes, registryRes] = await Promise.all([
        // CANONICAL primary queue
        supabase
          .from("did_plan_items")
          .select("id, action_required, priority, status, section, plan_type, created_at")
          .eq("status", "active")
          .order("priority", { ascending: false })
          .order("created_at", { ascending: false })
          .limit(20),
        // Adjunct: only manual tasks NOT linked to a canonical plan item.
        // Window expanded to 14d so stale/archive-candidate tasks counted in
        // OpsSnapshotBar are actually displayable here with a framing badge.
        // STATUS FILTER NOTE (audited against production DB): the table only
        // ever uses `pending` / `expired` / `archived`. `active` and
        // `in_progress` were aspirational values that never materialized in
        // the write path, so listing them here promised a surface state that
        // does not exist. Open work === `pending`. Mirrors useOperationalInboxCounts.
        (supabase as any)
          .from("did_therapist_tasks")
          .select("id, task, assigned_to, status, priority, created_at, due_date, detail_instruction, plan_item_id")
          .eq("status", "pending")
          .is("plan_item_id", null)
          .gte("created_at", fourteenDaysAgo)
          .order("priority", { ascending: true })
          .limit(40),
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
          .limit(20),
        supabase
          .from("crisis_karel_interviews")
          .select("part_name, summary_for_team, karel_decision_after_interview, started_at, what_shifted, what_remains_unclear")
          .gte("created_at", threeDaysAgo)
          .order("created_at", { ascending: false })
          .limit(10),
        supabase.functions.invoke("karel-did-drive-read", {
          body: { documents: ["05A_OPERATIVNI_PLAN"], subFolder: "00_CENTRUM" },
        }).catch(() => ({ data: null, error: null })),
        // Active registry — single source of truth for "is this part allowed
        // on today's surface?". Includes 'crisis' and 'stabilizing' so a part
        // in active crisis still surfaces, but pure 'sleeping' / 'dormant'
        // parts are excluded.
        (supabase as any)
          .from("did_part_registry")
          .select("part_name, display_name, status")
          .in("status", ["active", "crisis", "stabilizing"]),
      ]);

      // Build active part name set (case-insensitive). The crisis snapshot
      // overrides this when present (effectiveCrisisPart wins regardless),
      // but every other surface is gated through this set.
      const activePartSet = new Set<string>();
      for (const r of (registryRes.data || []) as any[]) {
        for (const n of [r.part_name, r.display_name]) {
          if (n && typeof n === "string") activePartSet.add(n.trim().toLowerCase());
        }
      }
      const isActivePart = (name: string | null | undefined): boolean => {
        if (!name) return false;
        return activePartSet.has(String(name).trim().toLowerCase());
      };
      const allowsActiveOrCrisis = (name: string | null | undefined): boolean => {
        // The snapshot crisis is loaded asynchronously; we accept the part if
        // it's currently in the registry's active pool OR if it matches the
        // effective crisis (computed below from snapshot.command.crises).
        if (isActivePart(name)) return true;
        const crisisName = snapshotCrisis?.partName || fallbackCrisisPart;
        return !!(name && crisisName && String(name).trim().toLowerCase() === String(crisisName).trim().toLowerCase());
      };

      // ── Canonical queue: primary plan items (mapped to UI task shape), then adjunct manual tasks ──
      const planItemsAsTasks = (planItemsRes.data || []).map((p: any) => ({
        id: `plan:${p.id}`,
        task: p.action_required || `${p.plan_type ?? ""}/${p.section ?? ""}`.trim(),
        assigned_to: "team",
        status: p.status,
        priority: typeof p.priority === "number"
          ? (p.priority >= 4 ? "critical" : p.priority >= 3 ? "high" : "normal")
          : (p.priority || "normal"),
        created_at: p.created_at,
        detail_instruction: null,
      }));
      const adjunctTasks = (manualTasksRes.data || []).map((t: any) => ({
        id: t.id,
        task: t.task,
        assigned_to: t.assigned_to,
        status: t.status,
        priority: t.priority,
        created_at: t.created_at,
        due_date: t.due_date ?? null,
        detail_instruction: t.detail_instruction,
      }));
      // Tasks: keep only those that don't reference a non-active part by name.
      // Tasks without a part reference (team / Karel-generated plan items)
      // pass through. We intentionally do NOT scan task text for part names
      // here — that would be a fragile heuristic. The dormant guard runs at
      // the SESSION/THREAD/INTERVIEW level where the part is structured.
      // VISIBLE-SURFACE GUARANTEE: do NOT slice() here. Counter sanity in
      // useOperationalInboxCounts is built around the assumption that every
      // pending task within the 14-day window is reachable in the briefing.
      // Slicing to 8 would silently drop stale/archive candidates and cause
      // the dashboard "K archivaci: N" badge to refer to invisible items.
      const merged = [...planItemsAsTasks, ...adjunctTasks];
      setTasks(deduplicateByText(merged));

      // Sessions: drop any planned session whose selected_part is not active
      // (or is the active crisis part).
      const sessionsAll = (sessionsRes.data || []) as any[];
      setSessions(sessionsAll.filter(s => allowsActiveOrCrisis(s.selected_part)));

      setQuestions(deduplicateByText(questionsRes.data || []).slice(0, 5) as any);

      // Threads: only show recent threads that belong to active parts.
      // System / Karel / virtual rows pass through (they aren't real parts).
      const threadsAll = (threadsRes.data || []) as any[];
      const SYSTEM_PART_NAMES = new Set(["karel", "system", ""]);
      const filteredThreads = threadsAll.filter(t => {
        const name = String(t.part_name || "").trim().toLowerCase();
        if (SYSTEM_PART_NAMES.has(name)) return true;
        return allowsActiveOrCrisis(t.part_name);
      }).slice(0, 8);
      setRecentThreads(filteredThreads);

      // Interviews: drop interviews that name a dormant part. A historical
      // crisis interview for a now-sleeping part should NOT re-trigger
      // narrative without an explicit reactivation.
      const interviewsAll = (interviewsRes.data || []) as any[];
      setRecentInterviews(interviewsAll.filter(iv => allowsActiveOrCrisis(iv.part_name)).slice(0, 5));

      // FÁZE 3C: NO raw crisis_events query here. Crisis truth = snapshot.command.crises only.
      setFallbackCrisisPart(null);

      // Determine last any activity date — also gated.
      const allDates = [
        ...filteredThreads.map((t: any) => t.last_activity_at),
        ...interviewsAll
          .filter(iv => allowsActiveOrCrisis(iv.part_name))
          .map((iv: any) => iv.started_at),
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
  }, [snapshotCrisis?.partName, fallbackCrisisPart]);

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
    // FÁZE 3C: canonical linkage in URL — wins over seed for resolver.
    if (seed.dailyPlanId) params.set("daily_plan_id", seed.dailyPlanId);
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

  /* ──────────────────────────────────────────────────────────────
     NARRATIVE BUILDER

     Output rules (enforced via humanizeText / isUsableLabel /
     describeUrgentLoad):

     1. NEVER paste raw thread_label or task.task into prose. They
        carry ticket prefixes ("Úkol:", "Otázka:", "Sezení:"),
        background-job tags ("[RECOVERY]", "[Auto]"), or full crisis
        headlines that read as debug output. Always pass them through
        humanizeText() first.
     2. NEVER write admin-counter sentences like "Eviduji X úkolů".
        Translate the count into a human meaning via
        describeUrgentLoad() — lead with the most important task.
     3. NEVER mention pseudo-parts ("system", "Karel", empty) in any
        narrative sentence. Filter via isUsableLabel().
     4. NEVER use bare "pracoval ${X}" without a preposition — the
        readable form is "pracoval jsem na" + listed topics.
     5. Address Hanička / Káťa personally with ONE leading sentence;
        avoid mechanical "čekám na tebe v N bodech: A; B" syntax.
        Lead with the concrete top item, mention the rest plainly.
     6. Skip empty thread topics rather than emitting
        'téma „"' or 'bez konkrétního tématu' bullet noise.
     ────────────────────────────────────────────────────────────── */
  /* Helper: pick the most concrete crisis check-in target for a therapist.
     In active crisis Karel MUST always have a concrete ask — never
     "nepotřebuji nic". Returns a single short instruction. */
  const crisisCheckInForHanka = (partName: string): string =>
    `Haničko, prosím dej mi dnes vědět, jak ${partName} vypadá v každodenním kontaktu — jestli reaguje, jestli se drží v přítomnosti a co mu pomáhá.`;
  const crisisCheckInForKata = (partName: string): string =>
    `Káťo, potřebuji tvůj pohled zvenčí — jak ${partName} působí v komunikaci s tebou a jestli vidíš něco, co Hanička z bezprostřední blízkosti vidět nemůže.`;

  /* Compose a natural Czech sentence about pending questions.
     Avoids "Mám pro tebe X otázky k zodpovězení". */
  const phraseQuestions = (n: number, name: "Haničko" | "Káťo"): string => {
    if (n <= 0) return "";
    if (n === 1) return `${name}, níže najdeš jednu otázku, na kterou potřebuji tvou odpověď.`;
    if (n <= 4) return `${name}, níže pro tebe mám ${n} otázky, ke kterým potřebuji tvůj pohled.`;
    return `${name}, níže pro tebe mám ${n} otázek, ke kterým potřebuji tvůj pohled.`;
  };

  const buildNarrativeParagraphs = (): string[] => {
    const paragraphs: string[] = [];

    // ═══ 1. CRISIS — always first (driven only by snapshot.command.crises) ═══
    if (effectiveCrisisPart) {
      paragraphs.push(`⚠ ${effectiveCrisisPart} je v aktivní krizi — potřebuji vaši plnou pozornost a koordinaci. Toto je nyní absolutní priorita.`);
    }

    // Pre-compute humanized urgent task list (shared by both branches).
    const urgentTasksRaw = tasks.filter(t => t.priority === "critical" || t.priority === "high");
    const urgentHumanized = urgentTasksRaw
      .map(t => humanizeText(t.task))
      .filter(Boolean);
    const topUrgent = urgentHumanized[0] || "";

    if (isInfoDeficit) {
      // ═══ DEFICIT MODE — MANDATORY 5 SECTIONS SAME AS NORMAL ═══
      const lastKnownSnippet = humanizeText(plan05ANarrative).slice(0, 250);
      const uniqueParts = [...new Set(recentThreads.map(t => t.part_name).filter(isUsableLabel))];

      // ── SECTION A: "Co vím" ──
      const deficitCoVim: string[] = [];
      if (lastKnownSnippet) {
        deficitCoVim.push(`Poslední data mám z doby před ${daysWithoutData} dny. ${lastKnownSnippet}.`);
      } else if (uniqueParts.length > 0) {
        deficitCoVim.push(`Poslední kontakt s ${uniqueParts[0]} proběhl ${relativeTime(lastAnyActivity)}. Od té doby nemám nové zprávy.`);
      } else {
        deficitCoVim.push(`Uplynulo ${daysWithoutData} dní od poslední aktualizace. Nemám žádné čerstvé operativní zprávy.`);
      }
      paragraphs.push(deficitCoVim.join(" "));

      // ── SECTION B: "Co z toho plyne" ──
      const deficitImplications: string[] = [];
      if (effectiveCrisisPart) {
        deficitImplications.push(`Krizová situace u ${effectiveCrisisPart} trvá i bez aktuálních dat — to zvyšuje riziko.`);
      }
      if (daysWithoutData > 7) {
        deficitImplications.push("Bez informací déle než týden nemohu zodpovědně koordinovat péči ani vyhodnotit dynamiku u dětí.");
      } else {
        deficitImplications.push("Bez aktuálních pozorování pracuji se zastaralými daty — moje doporučení mohou být nepřesná.");
      }
      paragraphs.push(deficitImplications.join(" "));

      // ── SECTION C: "Co navrhuji" ──
      const deficitProposals: string[] = [];
      if (topUrgent) {
        deficitProposals.push(`Prioritou dnes je toto: ${topUrgent}.`);
      }
      deficitProposals.push("Navrhuji dnes obnovit komunikaci — potřebuji alespoň stručné pozorování o tom, jak kluci aktuálně fungují.");
      paragraphs.push(deficitProposals.join(" "));

      // ── SECTION D: "Co od Haničky" — krize MUSÍ mít konkrétní check-in ──
      const hDeficitTasksRaw = tasks
        .filter(t => detectTarget(t.assigned_to) === "hanka" && !isProhibitedTask(t.task))
        .map(t => t.task)
        .filter(Boolean);
      if (hDeficitTasksRaw.length > 0) {
        const lead = renderTherapistAsk({ audience: "hanka", topTaskRaw: hDeficitTasksRaw[0] });
        paragraphs.push(`${lead} A především — potřebuji tvé aktuální pozorování, jak kluci v tichu fungují.`);
      } else if (effectiveCrisisPart) {
        paragraphs.push(crisisCheckInForHanka(effectiveCrisisPart));
      } else {
        paragraphs.push("Haničko, potřebuji od tebe alespoň krátkou zprávu o tom, jak kluci aktuálně fungují v každodenním životě.");
      }

      // ── SECTION E: "Co od Káti" — krize MUSÍ mít konkrétní check-in ──
      const kDeficitTasksRaw = tasks
        .filter(t => detectTarget(t.assigned_to) === "kata" && !isProhibitedTask(t.task))
        .map(t => t.task)
        .filter(Boolean);
      if (kDeficitTasksRaw.length > 0) {
        const lead = renderTherapistAsk({ audience: "kata", topTaskRaw: kDeficitTasksRaw[0] });
        paragraphs.push(`${lead} A především — potřebuji tvůj pohled zvenčí, jak kluci aktuálně působí.`);
      } else if (effectiveCrisisPart) {
        paragraphs.push(crisisCheckInForKata(effectiveCrisisPart));
      } else {
        paragraphs.push("Káťo, potřebuji od tebe alespoň krátkou zprávu — co pozoruješ ze své pozice, jak kluci reagují.");
      }
    } else {
      // ═══ NORMAL MODE — MANDATORY 5-SECTION NARRATIVE ═══

      // ── SECTION A: "Co vím" ──
      const coVimParts: string[] = [];
      const cleanedPlan = humanizeText(plan05ANarrative);
      if (cleanedPlan) {
        coVimParts.push(cleanedPlan + ".");
      }
      if (recentInterviews.length > 0) {
        for (const iv of recentInterviews.slice(0, 2)) {
          if (!isUsableLabel(iv.part_name)) continue;
          const when = relativeTime(iv.started_at);
          let sentence = `${when ? when.charAt(0).toUpperCase() + when.slice(1) : "Nedávno"} jsem vedl rozhovor s ${iv.part_name}`;
          const summary = humanizeText(iv.summary_for_team).slice(0, 200);
          if (summary) sentence += ` — ${summary}`;
          const shifted = humanizeText(iv.what_shifted).slice(0, 150);
          if (shifted) sentence += `. Posun: ${shifted}`;
          coVimParts.push(sentence + ".");
        }
      }
      if (recentThreads.length > 0 && coVimParts.length === 0) {
        // Synthesize from threads INTO MEANING — never as a tuple list.
        // No "(téma „...", před 8h)" syntax. No comma-separated contact log.
        // Just translate which children Karel was working with into one
        // calm sentence about WHO got the focus.
        const usableNames = [...new Set(
          recentThreads
            .filter(t => isUsableLabel(t.part_name))
            .map(t => t.part_name),
        )].slice(0, 3);
        if (usableNames.length === 1) {
          coVimParts.push(`V posledních dnech jsem se soustředil hlavně na ${usableNames[0]}.`);
        } else if (usableNames.length === 2) {
          coVimParts.push(`V posledních dnech jsem se soustředil hlavně na ${usableNames[0]} a ${usableNames[1]}.`);
        } else if (usableNames.length >= 3) {
          coVimParts.push(`V posledních dnech jsem se soustředil hlavně na ${usableNames[0]}, ${usableNames[1]} a ${usableNames[2]}.`);
        }
      }
      if (coVimParts.length === 0) {
        coVimParts.push("Zatím nemám čerstvé operativní zprávy za poslední 3 dny. Čekám na data z denního cyklu.");
      }
      paragraphs.push(coVimParts.join(" "));

      // ── SECTION B: "Co z toho plyne" ──
      const implications: string[] = [];
      if (effectiveCrisisPart) {
        implications.push(`Krizová situace u ${effectiveCrisisPart} vyžaduje denní monitoring a koordinovaný přístup.`);
      }
      // Replace admin counter with humanized lead-with-top-item phrasing.
      const urgentLine = describeUrgentLoad(urgentTasksRaw.length, topUrgent);
      if (urgentLine) implications.push(urgentLine);

      // Exclude pseudo-parts from "není aktivita" sweep — those rows
      // would otherwise leak as "U system, Karel jsem nezaznamenal
      // aktivitu" inside Karel's deductive briefing.
      const staleThreads = recentThreads.filter(
        t =>
          daysSince(t.last_activity_at) >= 2 &&
          isUsableLabel(t.part_name),
      );
      if (staleThreads.length > 0) {
        const uniqStaleNames = [...new Set(staleThreads.map(t => t.part_name))];
        implications.push(`U ${uniqStaleNames.join(", ")} jsem nezaznamenal aktivitu déle než 2 dny — potřebuji ověřit, zda je vše v pořádku.`);
      }
      if (implications.length === 0) {
        implications.push("Celková situace je stabilní. Můžeme se soustředit na plánované aktivity a terapeutický postup.");
      }
      paragraphs.push(implications.join(" "));

      // ── SECTION C: "Co navrhuji na dnes" ──
      const proposals: string[] = [];
      const usableSessions = uniqueSessions.filter(s => isUsableLabel(s.selected_part));
      if (usableSessions.length > 0) {
        proposals.push(`Navrhuji dnes pracovat s ${usableSessions.map(s => s.selected_part).join(" a ")} — plán sezení je připraven níže.`);
      }
      if (topUrgent && !urgentLine.includes(topUrgent)) {
        // Fallback only — usually urgentLine already surfaces it
        proposals.push(`Prioritou číslo jedna je toto: ${topUrgent}.`);
      }
      if (questions.length > 0) {
        if (questions.length === 1) {
          proposals.push("Níže najdete jednu otázku, na kterou potřebuji vaši odpověď.");
        } else if (questions.length <= 4) {
          proposals.push(`Níže pro vás mám ${questions.length} otázky, ke kterým si potřebuji upřesnit pohled.`);
        } else {
          proposals.push(`Níže pro vás mám ${questions.length} otázek, ke kterým si potřebuji upřesnit pohled.`);
        }
      }
      if (proposals.length === 0) {
        proposals.push("Dnes doporučuji zaměřit se na reflexi posledních dní a přípravu na další sezení. Pokud máte vlastní postřehy, napište mi.");
      }
      paragraphs.push(proposals.join(" "));

      // ── SECTION D: "Co potřebuji od Haničky" ──
      const hankaTasksRaw = tasks
        .filter(t => detectTarget(t.assigned_to) === "hanka" && !isProhibitedTask(t.task))
        .map(t => t.task)
        .filter(Boolean);
      const hankaQuestions = questions.filter(q => detectTarget(q.directed_to || "") === "hanka");
      const hankaSentences: string[] = [];
      if (hankaTasksRaw.length > 0) {
        const lead = renderTherapistAsk({ audience: "hanka", topTaskRaw: hankaTasksRaw[0] });
        const rest = hankaTasksRaw.length - 1;
        const restTail = rest > 0
          ? ` Kromě toho je tu ještě ${rest} dalš${rest === 1 ? "í věc" : rest <= 4 ? "í věci" : "ích věcí"}, ke kterým se ještě dostaneme.`
          : "";
        hankaSentences.push(`${lead}${restTail}`);
      }
      const hQ = phraseQuestions(hankaQuestions.length, "Haničko");
      if (hQ) hankaSentences.push(hQ);
      if (hankaSentences.length === 0) {
        // V krizi MUSÍ být konkrétní check-in — nikdy "nepotřebuji nic".
        if (effectiveCrisisPart) {
          hankaSentences.push(crisisCheckInForHanka(effectiveCrisisPart));
        } else {
          hankaSentences.push("Haničko, dnes od tebe nemám žádný konkrétní úkol. Pokud něco z denního kontaktu s kluky stojí za zmínku, dej mi vědět.");
        }
      }
      paragraphs.push(hankaSentences.join(" "));

      // ── SECTION E: "Co potřebuji od Káti" ──
      const kataTasksRaw = tasks
        .filter(t => detectTarget(t.assigned_to) === "kata" && !isProhibitedTask(t.task))
        .map(t => t.task)
        .filter(Boolean);
      const kataQuestions = questions.filter(q => detectTarget(q.directed_to || "") === "kata");
      const kataSentences: string[] = [];
      if (kataTasksRaw.length > 0) {
        const lead = renderTherapistAsk({ audience: "kata", topTaskRaw: kataTasksRaw[0] });
        const rest = kataTasksRaw.length - 1;
        const restTail = rest > 0
          ? ` Kromě toho je tu ještě ${rest} dalš${rest === 1 ? "í věc" : rest <= 4 ? "í věci" : "ích věcí"}, ke kterým se ještě dostaneme.`
          : "";
        kataSentences.push(`${lead}${restTail}`);
      }
      const kQ = phraseQuestions(kataQuestions.length, "Káťo");
      if (kQ) kataSentences.push(kQ);
      if (kataSentences.length === 0) {
        if (effectiveCrisisPart) {
          kataSentences.push(crisisCheckInForKata(effectiveCrisisPart));
        } else {
          kataSentences.push("Káťo, dnes od tebe nemám žádný konkrétní úkol. Pokud něco z tvojí strany stojí za zmínku, dej mi vědět.");
        }
      }
      paragraphs.push(kataSentences.join(" "));
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

    if (effectiveCrisisPart) {
      deficitItems.push({
        question: `${effectiveCrisisPart} má aktivní krizi — jaký je aktuální stav?`,
        intro: `Krize ${effectiveCrisisPart} vyžaduje průběžný monitoring. Bez vašeho pozorování nemohu správně vyhodnotit riziko.`,
        karelProposal: `Všímejte si: je ${effectiveCrisisPart} v kontaktu? Reaguje na grounding? Jsou přítomny rizikové signály?`,
        ifUnknownHelp: `Pokud nevíte jak zjistit stav ${effectiveCrisisPart}, otevřete se mnou rozhovor — připravím pro vás postup.`,
        partName: effectiveCrisisPart,
      });
    }
  }

  // ── FÁZE 3E: Resolve canonical did_daily_session_plans.id for a task ──
  // Priority:
  //   1) Exactly one today's session → use its id
  //   2) Today's session whose selected_part appears in task text / detail → its id
  //   3) Canonical today_session from snapshot (fallback) → its id
  //   4) null
  const resolveDailyPlanIdForTask = (t: typeof tasks[0]): string | null => {
    const todays = uniqueSessions; // already deduped sessions for today
    if (todays.length === 1) return todays[0].id;

    const haystack = `${t.task || ""} ${typeof t.detail_instruction === "string" ? t.detail_instruction : ""}`.toLowerCase();
    if (todays.length > 1) {
      const matched = todays.find(s => s.selected_part && haystack.includes(s.selected_part.toLowerCase()));
      if (matched) return matched.id;
    }

    const canonicalToday = (snapshot as any)?.canonical_today_session;
    if (canonicalToday?.id) return canonicalToday.id as string;

    return null;
  };

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
    const dailyPlanId = resolveDailyPlanIdForTask(t);

    // If parsed is a structured object, use it
    if (parsed && typeof parsed === "object" && (parsed.reason || parsed.proposal)) {
      return {
        topic: taskText,
        reason: parsed.reason || parsed.why || detailStr,
        karelProposal: parsed.proposal || parsed.karel_proposal || `Na základě aktuální situace navrhuji: ${taskText}`,
        questionsHanka: parsed.for_hanka || parsed.questions_hanka || `Haničko, jaký je tvůj pohled na: ${taskText.slice(0, 80)}?`,
        questionsKata: parsed.for_kata || parsed.questions_kata || `Káťo, jaký je tvůj pohled na: ${taskText.slice(0, 80)}?`,
        dailyPlanId,
      };
    }

    // Plain string — build deterministic briefing
    return {
      topic: taskText,
      reason: detailStr,
      karelProposal: `Situaci jsem vyhodnotil a navrhuji tento postup: zaměřit se na „${taskText.slice(0, 80)}" s konkrétním plánem kroků. ${detailStr !== taskText ? detailStr.slice(0, 200) : "Detaily prodiskutujeme na poradě."}`,
      questionsHanka: `Haničko, potřebuji tvé konkrétní pozorování k tématu „${taskText.slice(0, 60)}". Co jsi zaznamenala v chování části? Jaké změny pozoruješ?`,
      questionsKata: `Káťo, potřebuji tvůj pohled z tvé pozice k tématu „${taskText.slice(0, 60)}". Co jsi zaznamenala? Jak to koresponduje s tím, co vidí Hanička?`,
      dailyPlanId,
    };
  };

  // ── Editorial date frontispiece ──
  const dayNum = new Date().getDate();
  const monthNames = ["ledna","února","března","dubna","května","června","července","srpna","září","října","listopadu","prosince"];
  const monthName = monthNames[new Date().getMonth()];
  const yearNum = new Date().getFullYear();

  return (
    <article className="karel-briefing jung-card relative px-6 py-8 sm:px-10 sm:py-10 max-w-3xl mx-auto">
      {/* ── Editorial frontispiece — SKRYTO když existuje DidDailyBriefingPanel,
              aby v dashboardu nebyly DVA „Karlovy přehledy". ── */}
      {!hideDuplicateBlocks && (
        <header className="mb-7">
          <div className="flex items-center justify-between mb-3">
            <span className="karel-briefing-eyebrow">Karlův přehled</span>
            <span className="karel-briefing-eyebrow" aria-label="Datum">
              {dayNum}. {monthName} {yearNum}
            </span>
          </div>
          <h1 className="karel-briefing-headline">
            {greeting}, Haničko a Káťo.
          </h1>
          {effectiveCrisisPart ? (
            <p className="mt-3 karel-briefing-callout karel-briefing-callout-crisis">
              Dnes je v aktivní krizi <strong className="font-medium">{effectiveCrisisPart}</strong>. To má přednost před vším ostatním.
            </p>
          ) : (
            <p className="mt-3 karel-briefing-deck">
              {isInfoDeficit
                ? `Uplynulo ${daysWithoutData} dní bez aktualizace — potřebuji od vás krátkou zprávu.`
                : "Tady je dnešní situace, jak ji čtu."}
            </p>
          )}
        </header>
      )}

      {/* ── B. Unified narrative — SKRYTO když existuje briefing (duplicita prose). ── */}
      {!hideDuplicateBlocks && (
        <section className="karel-briefing-prose">
          {narrativeParagraphs.map((para, i) => (
            <p key={i}>{para}</p>
          ))}
        </section>
      )}

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

      {/* ── D. Návrh sezení na dnes — SKRYTO když existuje briefing.proposed_session ── */}
      {!hideDuplicateBlocks && uniqueSessions.length > 0 && (
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

      {/* ── E. Úkoly — pro Haničku — SKRYTO když existuje briefing.ask_hanka ── */}
      {!hideDuplicateBlocks && hankaTasks.length > 0 && (
        <>
          <NarrativeDivider />
          <div className="py-2">
            <SectionHead icon={<ClipboardList className="w-4 h-4 text-primary/60" />}>
              Haničko, potřebuji od tebe
            </SectionHead>
            <ul className="space-y-2">
              {hankaTasks.map(t => (
                <li key={t.id} className="text-[13px] text-foreground/70 flex items-start gap-2">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/30" />
                  <div className="flex-1">
                    <span>{t.task}</span>
                    <TaskFrameBadge createdAt={t.created_at} dueDate={t.due_date} status={t.status} />
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

      {/* ── E. Úkoly — pro Káťu — SKRYTO když existuje briefing.ask_kata ── */}
      {!hideDuplicateBlocks && kataTasks.length > 0 && (
        <>
          <NarrativeDivider />
          <div className="py-2">
            <SectionHead icon={<ClipboardList className="w-4 h-4 text-primary/60" />}>
              Káťo, potřebuji od tebe
            </SectionHead>
            <ul className="space-y-2">
              {kataTasks.map(t => (
                <li key={t.id} className="text-[13px] text-foreground/70 flex items-start gap-2">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/30" />
                  <div className="flex-1">
                    <span>{t.task}</span>
                    <TaskFrameBadge createdAt={t.created_at} dueDate={t.due_date} status={t.status} />
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

      {/* ── E. Úkoly pro celý tým / poradní ──
          ARCHIVOVÁNO 2026-04-19: sekce „Společná porada — řešíme spolu" byla
          odstraněna z této komponenty. Důvod: generovala desítky duplicitních
          generických „Otevřít poradu" položek z task seedu.
          Single source of truth pro týmové porady = `did_daily_briefings`
          (renderuje `DidDailyBriefingPanel`) + `TeamDeliberationsPanel`. */}

      {/* ── F. Nezodpovězené otázky — SKRYTO když existuje briefing.waiting_for ── */}
      {!hideDuplicateBlocks && questions.length > 0 && (
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

      {/* ── G. (removed) Motivační/hodnoticí blok byl admin-flavored copy
              recyklovaný za briefing — Karel má dedukovat, ne motivovat. ── */}
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
    </article>
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

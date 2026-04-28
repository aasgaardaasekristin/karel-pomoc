import { useCallback, useEffect, useState, useRef } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import {
  Target,
  Loader2,
  Zap,
  CheckCircle2,
  Search,
  Brain,
  FileText,
  Send,
  UserRoundCog,
  ChevronDown,
  ChevronUp,
  PenLine,
  MessageSquare,
  Play,
  Square,
  Clock,
  Trash2,
  RefreshCw,
  Plus,
  Users,
  Lock,
  Dices,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";
import { getAuthHeaders } from "@/lib/auth";
import { toast } from "sonner";
import RichMarkdown from "@/components/ui/RichMarkdown";
import { useSessionPrepRoom } from "@/hooks/useSessionPrepRoom";
import { signoffProgress } from "@/types/teamDeliberation";
import { finalizeDidSessionWithJob } from "@/lib/karelFinalizeJobs";

interface SessionPlan {
  id: string;
  plan_date: string;
  selected_part: string;
  urgency_score: number;
  urgency_breakdown: Record<string, any>;
  plan_markdown: string;
  therapist: string;
  status: string;
  lifecycle_status?: string;
  distributed_drive: boolean;
  distributed_email: boolean;
  generated_by: string;
  completed_at: string | null;
  session_lead: string;
  session_format: string;
  program_status?: string;
  approved_at?: string | null;
  overdue_days: number;
  created_at?: string;
}

const isKarelDirectPlan = (plan: SessionPlan) =>
  plan.urgency_breakdown?.session_actor === "karel_direct" &&
  plan.urgency_breakdown?.lead_entity === "karel" &&
  plan.urgency_breakdown?.ui_surface === "did_kids_playroom";
const hasPlayroomPlan = (plan: SessionPlan) =>
  !!plan.urgency_breakdown?.playroom_plan &&
  typeof plan.urgency_breakdown.playroom_plan === "object" &&
  Array.isArray(plan.urgency_breakdown.playroom_plan.therapeutic_program) &&
  plan.urgency_breakdown.playroom_plan.therapeutic_program.length > 0;
const LEGACY_PLAN_GENERATORS = new Set(["auto", "manual"]);
const ANALYTIC_PLAN_GENERATORS = new Set([
  "analyst_loop",
  "recovery_mode",
  "karel-did-apply-analysis",
  "crisis-retroactive-scan",
]);

const hasExplicitRoleContract = (plan: SessionPlan) =>
  ["therapist_led", "karel_direct"].includes(
    String(plan.urgency_breakdown?.session_actor ?? ""),
  ) && plan.urgency_breakdown?.human_review_required === true;

const isKarelDirectApprovedForHerna = (plan: SessionPlan) =>
  isKarelDirectPlan(plan) &&
  hasPlayroomPlan(plan) &&
  plan.urgency_breakdown?.human_review_required === true &&
  plan.urgency_breakdown?.approved_for_child_session === true &&
  ["approved", "ready_to_start", "in_progress"].includes(
    String(
      plan.program_status ||
        plan.urgency_breakdown?.review_state ||
        plan.urgency_breakdown?.approval?.review_state ||
        "",
    ),
  );

const PROGRAM_START_BLOCKED_STATUSES = new Set([
  "draft",
  "in_revision",
  "awaiting_signatures",
  "awaiting_signature",
  "pending_review",
]);

const programStartBlockedReason = (plan: SessionPlan) => {
  const programStatus = String(
    plan.program_status ||
      plan.urgency_breakdown?.review_state ||
      plan.urgency_breakdown?.approval?.review_state ||
      "",
  ).toLowerCase();
  const humanReviewRequired =
    plan.urgency_breakdown?.human_review_required === true ||
    plan.urgency_breakdown?.approval?.required === true ||
    plan.urgency_breakdown?.playroom_plan?.approval?.required === true ||
    plan.urgency_breakdown?.playroom_plan?.therapist_review?.required === true;
  const reviewFulfilled =
    ["approved", "ready_to_start", "in_progress", "completed"].includes(
      programStatus,
    ) || !!plan.approved_at || !!plan.urgency_breakdown?.approved_at;
  const childFacingPlayroom =
    isKarelDirectPlan(plan) || !!plan.urgency_breakdown?.playroom_plan;
  const approvedForChild =
    plan.urgency_breakdown?.approved_for_child_session === true ||
    plan.urgency_breakdown?.approval?.approved_for_child_session === true ||
    plan.urgency_breakdown?.playroom_plan?.approval
      ?.approved_for_child_session === true ||
    plan.urgency_breakdown?.playroom_plan?.therapist_review
      ?.approved_for_child_session === true;

  if (
    (humanReviewRequired && !reviewFulfilled) ||
    PROGRAM_START_BLOCKED_STATUSES.has(programStatus) ||
    (childFacingPlayroom && !approvedForChild)
  ) {
    return "Program byl upraven podle odpovědi terapeutky a čeká na podpis Haničky a Káti.";
  }
  return null;
};

const isSignatureGuardError = (error: unknown) =>
  String((error as any)?.message ?? error ?? "").includes(
    "daily_session_plan_requires_signatures_before_start",
  );

const approvalDesyncMessage =
  "Porada je podepsaná, ale denní plán nemá aktuální approval metadata. Karel právě synchronizuje schválení.";

const isQuarantinedPlan = (plan: SessionPlan) =>
  LEGACY_PLAN_GENERATORS.has(plan.generated_by) ||
  (ANALYTIC_PLAN_GENERATORS.has(plan.generated_by) &&
    !hasExplicitRoleContract(plan));

interface PreviousSession {
  therapist: string;
  session_date: string;
  ai_analysis: string | null;
  handoff_note: string | null;
  karel_notes: string | null;
}

interface Props {
  refreshTrigger: number;
  /**
   * Pracovna SESSION-CONTROLS CLEANUP (2026-04-21):
   *  Když true, skryjí se plánovací/údržbové akce, které nepatří na hlavní
   *  pracovní stůl (Nový plán, Určit část, Přegenerovat, Smazat).
   *  Layer 4 v Pracovně tak zobrazuje jen schválená dnešní sezení a akce
   *  jejich průběhu (Zahájit / Splněno / Live / Ukončit).
   */
  compact?: boolean;
  /**
   * SESSION PREP ROOM PASS (2026-04-21):
   *  Otevírá `DeliberationRoom` (modal) pro přípravnou poradu typu
   *  `session_plan` navázanou na konkrétní dnešní plán. Pracovna ho
   *  přepošle z hostitelského surface (PracovnaSurface drží
   *  setOpenDeliberationId).
   *  Když není dodán, prep CTA se nerendrují — chování zůstává původní.
   */
  onOpenPrepRoom?: (deliberationId: string) => void;
}

const urgencyLabels: Record<string, string> = {
  crisis: "🔴 Krize",
  nightmares_flashbacks: "Noční můry",
  emotional_dysregulation: "Emoční dysregulace",
  pending_tasks: "Nedokončené úkoly",
  fading_alert: "⚠️ Odmlčení",
  active_3d: "Aktivní",
  dormant_7d: "Neaktivní >7d",
  fallback_oldest: "Nejdéle neviděn",
  therapist_override: "✅ Terapeutka",
  overdue_escalation: "🔴 Odložený plán",
  recent_session: "↩ Nedávné sezení",
};

const GENERATION_STEPS = [
  { key: "data", label: "Sběr dat z registru + kartotéky", icon: Search },
  { key: "scoring", label: "Výpočet naléhavosti", icon: Target },
  { key: "research", label: "Perplexity rešerše", icon: Brain },
  { key: "ai", label: "Generování plánu (AI)", icon: FileText },
  { key: "save", label: "Ukládání a distribuce", icon: Send },
];

import DidLiveSessionPanel from "./DidLiveSessionPanel";

const DidDailySessionPlan = ({
  refreshTrigger,
  compact = false,
  onOpenPrepRoom,
}: Props) => {
  const [plans, setPlans] = useState<SessionPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [genStep, setGenStep] = useState(0);
  const [expandedPlanId, setExpandedPlanId] = useState<string | null>(null);
  const [registryParts, setRegistryParts] = useState<
    { part_name: string; status: string }[]
  >([]);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [customPartName, setCustomPartName] = useState("");
  const [prevSession, setPrevSession] = useState<PreviousSession | null>(null);

  // Preference dialog state
  const [prefDialogOpen, setPrefDialogOpen] = useState(false);
  const [prefSelectedPart, setPrefSelectedPart] = useState("");
  const [prefStep, setPrefStep] = useState<"ask" | "detail">("ask");
  const [prefDetail, setPrefDetail] = useState("");

  // Live session state
  const [activeLivePlanId, setActiveLivePlanId] = useState<string | null>(null);
  const [openingSessionThread, setOpeningSessionThread] = useState(false);

  // Today key (Prague TZ) — used as filter and for "stale" guard
  const todayPragueKey = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Prague",
  }).format(new Date());

  // First pending plan TODAY only (no stale plans from yesterday allowed as "today's reality")
  const firstPendingPlan =
    plans.find(
      (p) =>
        (p.status === "generated" || p.status === "in_progress") &&
        p.plan_date === todayPragueKey &&
        !isQuarantinedPlan(p),
    ) || null;

  const loadTodayPlans = useCallback(async () => {
    setLoading(true);
    try {
      const today = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Prague",
      }).format(new Date());
      // BUGFIX (FÁZE 3 dormant leak): operational truth for "is there a crisis
      // today?" comes ONLY from crisis_events (canonical). crisis_alerts is
      // a notification projection — reading it here re-introduces the parallel
      // resolver bug (a closed event but an unclosed alert would falsely
      // trigger a "crisis" badge in today's session plan).
      const { data, error } = await (supabase as any)
        .from("did_daily_session_plans")
        .select("*")
        .eq("plan_date", today)
        .order("created_at", { ascending: false });
      if (error) throw error;
      setPlans(data || []);
    } catch (e) {
      console.error("Failed to load session plans:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTodayPlans();
  }, [loadTodayPlans, refreshTrigger]);

  useEffect(() => {
    const channel = (supabase as any)
      .channel(`did_daily_session_plans_${todayPragueKey}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "did_daily_session_plans",
          filter: `plan_date=eq.${todayPragueKey}`,
        },
        () => {
          void loadTodayPlans();
        },
      )
      .subscribe();
    return () => {
      (supabase as any).removeChannel(channel);
    };
  }, [loadTodayPlans, todayPragueKey]);

  // ── SPUSTIT-SEZENI EVENT LISTENER (2026-04-23) ──
  // DeliberationRoom (porada „Návrh sezení k poradě") emituje
  // `karel:start-live-session` v okamžiku, kdy terapeutka klikne "Spustit
  // sezení". Tato karta (Pracovna → Dnes) musí na to reagovat:
  //   1) refresh plánů (status už je in_progress díky DB updatu v Deliberation Room),
  //   2) přepnout `liveSessionActive=true`, aby se otevřel DidLiveSessionPanel.
  // Pokud event nese `planId` a plán mezi dnešními neexistuje (např. uživatel
  // je na jiné záložce), refresh ho dotáhne, a další render už trefí
  // `firstPendingPlan` (status='in_progress' splňuje filter).
  useEffect(() => {
    const handler = async (e: Event) => {
      const detail = (e as CustomEvent<{ planId?: string }>).detail || {};
      try {
        await loadTodayPlans();
      } catch {
        /* refresh failure shouldn't block UI flip */
      }
      setActiveLivePlanId(detail.planId ?? null);
      // Pokud event přišel s konkrétním planId a my ho v aktuálním plans
      // nemáme (race condition), počkáme jeden tick a refresh zopakujeme.
      if (detail.planId) {
        setTimeout(() => {
          loadTodayPlans();
        }, 600);
      }
    };
    window.addEventListener(
      "karel:start-live-session",
      handler as EventListener,
    );
    return () =>
      window.removeEventListener(
        "karel:start-live-session",
        handler as EventListener,
      );
  }, [loadTodayPlans]);

  // Load previous session for first pending plan
  useEffect(() => {
    const plan = firstPendingPlan;
    if (!plan?.selected_part) {
      setPrevSession(null);
      return;
    }
    const loadPrev = async () => {
      const currentTherapist = (plan.therapist || "hanka").toLowerCase();
      let query = supabase
        .from("did_part_sessions")
        .select(
          "therapist, session_date, ai_analysis, handoff_note, karel_notes",
        )
        .eq("part_name", plan.selected_part)
        .order("created_at", { ascending: false })
        .limit(10);
      const { data: rows } = await query;
      const other = (rows || []).find(
        (r) => r.therapist?.toLowerCase() !== currentTherapist,
      );
      setPrevSession((other as PreviousSession) || null);
    };
    loadPrev();
  }, [firstPendingPlan?.selected_part, firstPendingPlan?.therapist]);

  // BUGFIX (dormant leak): default override picker MUST NOT include `sleeping`.
  // The everyday "Určit část" flow is for today's reality. A separate explicit
  // toggle could later expose the dormant pool; until then we keep it strictly
  // active-only to prevent Karel from being nudged toward parts that have no
  // canonical reason to be on the schedule.
  const loadRegistryParts = useCallback(async () => {
    const { data } = await supabase
      .from("did_part_registry")
      .select("part_name, status")
      .eq("status", "active")
      .order("part_name");
    setRegistryParts(data || []);
  }, []);

  useEffect(() => {
    loadRegistryParts();
  }, [loadRegistryParts]);

  const generatePlan = useCallback(
    async (forcePart?: string, therapistContext?: string) => {
      setGenerating(true);
      setGenStep(0);

      const stepTimer = setInterval(() => {
        setGenStep((prev) => {
          if (prev < GENERATION_STEPS.length - 1) return prev + 1;
          return prev;
        });
      }, 4500);

      try {
        const headers = await getAuthHeaders();
        const body: Record<string, string> = {};
        if (forcePart) body.forcePart = forcePart;
        if (therapistContext) body.therapistContext = therapistContext;

        const resp = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-auto-session-plan`,
          { method: "POST", headers, body: JSON.stringify(body) },
        );
        const data = await resp.json();
        clearInterval(stepTimer);
        setGenStep(GENERATION_STEPS.length);

        if (!resp.ok) throw new Error(data.error || "Generování selhalo");
        if (data.skipped) {
          toast.info("Automatický plán na dnes už existuje");
        } else if (data.reason === "no_active_parts") {
          toast.info("Žádná aktivní/komunikující část — plán nevygenerován");
        } else {
          const leadLabel =
            data.sessionLead === "obe"
              ? "Hanka + Káťa"
              : data.sessionLead === "kata"
                ? "Káťa"
                : "Hanka";
          toast.success(
            `Plán vygenerován pro ${data.selectedPart} (VEDE: ${leadLabel})`,
          );
        }
        await loadTodayPlans();
      } catch (e: any) {
        clearInterval(stepTimer);
        toast.error(e.message || "Generování plánu selhalo");
      } finally {
        setGenerating(false);
        setGenStep(0);
      }
    },
    [loadTodayPlans],
  );

  // ═══ MARK AS DONE ═══
  const markDone = useCallback(
    async (planId: string) => {
      try {
        const result = await finalizeDidSessionWithJob({
          planId,
          source: "manual_end",
          reason: "completed",
          onAccepted: () =>
            toast.info(
              "Karel dokončuje vyhodnocení. Výsledek se uloží automaticky.",
            ),
        });
        if (!result.ok) throw new Error(result.error || "Finalizace selhala");
        await loadTodayPlans();
        toast.success(
          result.status === "already_done"
            ? "Vyhodnocení už bylo dokončeno"
            : "Plán předán k vyhodnocení",
        );
      } catch (e) {
        toast.error("Nepodařilo se spustit vyhodnocení");
      }
    },
    [loadTodayPlans],
  );

  // ═══ DELETE PLAN ═══
  const deletePlan = useCallback(async (planId: string) => {
    if (!window.confirm("Opravdu smazat tento plán? Tato akce je nevratná."))
      return;
    try {
      await (supabase as any)
        .from("did_daily_session_plans")
        .delete()
        .eq("id", planId);
      setPlans((prev) => prev.filter((p) => p.id !== planId));
      toast.success("Plán smazán");
    } catch (e) {
      toast.error("Nepodařilo se smazat plán");
    }
  }, []);

  // Called when therapist picks a part from the popover
  const handlePartSelected = (partName: string) => {
    setOverrideOpen(false);
    setCustomPartName("");
    setPrefSelectedPart(partName);
    setPrefStep("ask");
    setPrefDetail("");
    setPrefDialogOpen(true);
  };

  // Preference dialog actions
  const handleNoPreference = () => {
    setPrefDialogOpen(false);
    generatePlan(prefSelectedPart);
  };

  const handleWantToSpecify = () => {
    setPrefStep("detail");
  };

  const handleSubmitWithContext = () => {
    setPrefDialogOpen(false);
    generatePlan(prefSelectedPart, prefDetail.trim() || undefined);
  };

  // ═══ SESSION START ═══
  const startSession = useCallback(async (plan: SessionPlan) => {
    try {
      const blockedReason = programStartBlockedReason(plan);
      if (blockedReason) {
        toast.info(blockedReason);
        return;
      }
      const { error: sessErr } = await supabase
        .from("did_part_sessions")
        .insert({
          part_name: plan.selected_part,
          therapist: plan.session_lead || plan.therapist || "hanka",
          session_type: "planned",
          session_date: plan.plan_date,
          karel_notes: `Plán sezení (urgency ${plan.urgency_score}):\n${plan.plan_markdown.slice(0, 2000)}`,
        });
      if (sessErr) console.error("Failed to insert session:", sessErr);

      await supabase
        .from("did_part_registry")
        .update({
          last_seen_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .ilike("part_name", plan.selected_part);

      const { error: startErr } = await (supabase as any)
        .from("did_daily_session_plans")
        .update({
          status: "in_progress",
          lifecycle_status: "in_progress",
          started_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", plan.id);

      if (startErr) throw startErr;

      setPlans((prev) =>
        prev.map((p) =>
          p.id === plan.id ? { ...p, status: "in_progress" } : p,
        ),
      );
      setActiveLivePlanId(plan.id);
      toast.success(`Sezení s ${plan.selected_part} zahájeno`);
    } catch (e: any) {
      toast.error(
        isSignatureGuardError(e)
          ? approvalDesyncMessage
          : "Nepodařilo se zahájit sezení",
      );
      console.error(e);
    }
  }, []);

  // ═══ SESSION END ═══
  const endSession = useCallback(
    async (plan: SessionPlan) => {
      try {
        const { data: sessionRow } = await supabase
          .from("did_part_sessions")
          .select("id")
          .eq("part_name", plan.selected_part)
          .eq("session_date", plan.plan_date)
          .eq("session_type", "planned")
          .maybeSingle();

        if (sessionRow) {
          await supabase
            .from("did_part_sessions")
            .update({
              karel_therapist_feedback: `Sezení dokončeno dle plánu (urgency ${plan.urgency_score}).`,
              updated_at: new Date().toISOString(),
            })
            .eq("id", sessionRow.id);
        }

        const result = await finalizeDidSessionWithJob({
          planId: plan.id,
          source: "manual_end",
          reason: "partial",
          onAccepted: () =>
            toast.info(
              "Karel dokončuje vyhodnocení. Výsledek se uloží automaticky.",
            ),
        });
        if (!result.ok) throw new Error(result.error || "Finalizace selhala");
        await loadTodayPlans();
        toast.success(
          `Sezení s ${plan.selected_part} ukončeno a předáno k vyhodnocení`,
        );
      } catch (e: any) {
        toast.error("Nepodařilo se ukončit sezení");
        console.error(e);
      }
    },
    [loadTodayPlans],
  );

  // ═══ REVERT STATUS ═══
  const revertStatus = useCallback(async (plan: SessionPlan) => {
    try {
      await (supabase as any)
        .from("did_daily_session_plans")
        .update({
          status: "generated",
          completed_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", plan.id);
      setPlans((prev) =>
        prev.map((p) =>
          p.id === plan.id
            ? { ...p, status: "generated", completed_at: null }
            : p,
        ),
      );
      setActiveLivePlanId((current) => (current === plan.id ? null : current));
      toast.success("Stav vrácen na Naplánováno");
    } catch (e: any) {
      toast.error("Nepodařilo se změnit stav");
    }
  }, []);

  // ═══ LIVE SESSION END HANDLER ═══
  const currentLivePlan = activeLivePlanId
    ? (plans.find((p) => p.id === activeLivePlanId) ?? null)
    : null;

  const handleLiveSessionEnd = useCallback(
    async (summary: string) => {
      const plan = currentLivePlan;
      setActiveLivePlanId(null);
      if (!plan) return;

      try {
        const { data: sessionRow } = await supabase
          .from("did_part_sessions")
          .select("id")
          .eq("part_name", plan.selected_part)
          .eq("session_date", plan.plan_date)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (sessionRow) {
          await supabase
            .from("did_part_sessions")
            .update({
              ai_analysis: summary,
              updated_at: new Date().toISOString(),
            })
            .eq("id", sessionRow.id);
        }
      } catch (e) {
        console.error("Failed to save AI analysis:", e);
      }

      await endSession(plan);
    },
    [currentLivePlan, endSession],
  );

  if (loading) {
    return (
      <div className="mb-4 rounded-lg border border-border/70 bg-card/38 p-3 backdrop-blur-sm">
        <div className="flex items-center text-xs text-muted-foreground">
          <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> Načítám plány
          sezení...
        </div>
      </div>
    );
  }

  // ═══ LIVE SESSION ACTIVE → show DidLiveSessionPanel ═══
  // Renderujeme jako fixed-overlay přes celý viewport, abychom obešli capped
  // rodičovské wrappery (Pracovna / DidContentRouter mají max-h-[22rem]).
  // Bez tohoto by byl input live sezení vytlačen pod fold a nešlo by k němu doscrollovat.
  if (currentLivePlan) {
    // LIVE SEZENÍ — fullscreen overlay přes portál na document.body.
    // Důvody:
    //  1) Obchází `max-h-[22rem]` wrappery v DidDashboard / DidContentRouter,
    //     které by jinak panel zmáčkly do nečitelného boxu.
    //  2) Obchází Radix Dialog (DeliberationRoom) — odkud se sezení často spouští.
    //
    // KRITICKÉ (oprava 2026-04-23): wrapper MUSÍ mít `relative`, protože vnitřek
    // `DidLiveSessionPanel` se renderuje jako `absolute inset-0`. Bez `relative`
    // se panel "vypařil" mimo flow a uživatelka viděla jen prázdné tmavé pozadí.
    return createPortal(
      <div className="fixed inset-0 z-[200] bg-background">
        <div className="relative w-full h-full overflow-hidden">
          <DidLiveSessionPanel
            partName={currentLivePlan.selected_part}
            therapistName={
              currentLivePlan.session_lead === "kata" ? "Káťa" : "Hanka"
            }
            contextBrief={currentLivePlan.plan_markdown}
            planId={currentLivePlan.id}
            onEnd={handleLiveSessionEnd}
            onBack={() => setActiveLivePlanId(null)}
          />
        </div>
      </div>,
      document.body,
    );
  }

  const showLegacyDrafts =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("showLegacyDrafts") ===
      "true";

  // Split plans into runtime, hidden legacy/analytic drafts, and archived.
  const pendingPlans = plans.filter(
    (p) =>
      (p.status === "generated" || p.status === "in_progress") &&
      !isQuarantinedPlan(p),
  );
  const playroomPlans = pendingPlans.filter(isKarelDirectPlan);
  const therapistSessionPlans = pendingPlans.filter(
    (p) => !isKarelDirectPlan(p),
  );
  const quarantinedPlans = plans.filter(
    (p) =>
      ["pending", "generated", "in_progress"].includes(p.status) &&
      isQuarantinedPlan(p),
  );
  const archivedPlans = plans.filter(
    (p) => p.status === "done" || p.status === "skipped",
  );
  const hasKarelDirectPlan = playroomPlans.length > 0;

  return (
    <>
      <div className="mb-4 rounded-lg border border-border/70 bg-card/38 p-3 backdrop-blur-sm sm:p-4">
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-xs font-medium text-foreground flex items-center gap-1.5">
            {hasKarelDirectPlan ? (
              <Dices className="w-3.5 h-3.5 text-primary" />
            ) : (
              <Target className="w-3.5 h-3.5 text-primary" />
            )}
            Denní programy
          </h4>
          <div className="flex items-center gap-1.5">
            {!generating && !compact && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => generatePlan()}
                  className="h-7 px-2 text-[0.625rem]"
                >
                  <Plus className="mr-1 h-3 w-3" /> Nový plán
                </Button>
                <Popover
                  open={overrideOpen}
                  onOpenChange={(open) => {
                    setOverrideOpen(open);
                    if (!open) setCustomPartName("");
                  }}
                >
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 text-[10px]"
                    >
                      <UserRoundCog className="mr-1 h-3 w-3" />
                      Určit část
                      <ChevronDown className="ml-0.5 h-2.5 w-2.5" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-52 p-1.5" align="end">
                    <p className="text-[0.625rem] text-muted-foreground px-2 py-1 mb-1">
                      Vygenerovat plán pro konkrétní část:
                    </p>
                    <div className="max-h-48 overflow-y-auto space-y-0.5 mb-2">
                      {registryParts.map((p) => (
                        <button
                          key={p.part_name}
                          onClick={() => handlePartSelected(p.part_name)}
                          className="w-full flex items-center gap-2 rounded px-2 py-1.5 text-left text-[0.6875rem] hover:bg-accent transition-colors"
                        >
                          <span className="h-1.5 w-1.5 rounded-full shrink-0 bg-green-500" />
                          {p.part_name}
                          <span className="text-[0.5625rem] text-muted-foreground ml-auto">
                            aktivní
                          </span>
                        </button>
                      ))}
                      {registryParts.length === 0 && (
                        <p className="text-[0.625rem] text-muted-foreground px-2 py-1">
                          Žádné aktivní části v registru
                        </p>
                      )}
                    </div>
                    <div className="border-t border-border/60 pt-2 px-1">
                      <p className="text-[0.5625rem] text-muted-foreground mb-1 flex items-center gap-1">
                        <PenLine className="h-2.5 w-2.5" /> Nebo napiš jméno:
                      </p>
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          const name = customPartName.trim();
                          if (!name) return;
                          handlePartSelected(name);
                        }}
                        className="flex gap-1"
                      >
                        <input
                          type="text"
                          value={customPartName}
                          onChange={(e) => setCustomPartName(e.target.value)}
                          placeholder="Jméno části…"
                          className="flex-1 h-7 rounded border border-border/70 bg-background px-2 text-[11px] placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/40"
                        />
                        <Button
                          type="submit"
                          variant="secondary"
                          size="sm"
                          className="h-7 px-2 text-[0.625rem]"
                          disabled={!customPartName.trim()}
                        >
                          <Zap className="h-3 w-3" />
                        </Button>
                      </form>
                    </div>
                  </PopoverContent>
                </Popover>
              </>
            )}
          </div>
        </div>

        {/* ═══ GENERATION PROGRESS ═══ */}
        {generating && (
          <div className="space-y-2 py-1">
            <Progress
              value={((genStep + 1) / GENERATION_STEPS.length) * 100}
              className="h-1.5"
            />
            <div className="space-y-1">
              {GENERATION_STEPS.map((step, i) => {
                const StepIcon = step.icon;
                const isDone = i < genStep;
                const isCurrent = i === genStep;
                return (
                  <div
                    key={step.key}
                    className={`flex items-center gap-2 text-[0.625rem] transition-all duration-300 ${
                      isDone
                        ? "text-primary/70"
                        : isCurrent
                          ? "text-foreground font-medium"
                          : "text-muted-foreground/50"
                    }`}
                  >
                    {isDone ? (
                      <CheckCircle2 className="h-3 w-3 text-primary shrink-0" />
                    ) : isCurrent ? (
                      <Loader2 className="h-3 w-3 animate-spin text-primary shrink-0" />
                    ) : (
                      <StepIcon className="h-3 w-3 shrink-0" />
                    )}
                    {step.label}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {pendingPlans.length === 0 &&
          archivedPlans.length === 0 &&
          !generating && (
            <div className="rounded-md border border-dashed border-border/50 bg-background/30 p-3">
              <p className="text-[0.6875rem] text-muted-foreground leading-relaxed">
                Dnes zatím není otevřená žádná Karlova herna ani schválené
                sezení.
                <br />
                <span className="text-muted-foreground/70">
                  Karlův návrh sezení vzniká v{" "}
                  <strong>Společné poradě týmu</strong> (návrh → otázky →
                  podpisy). Po schválení se zde objeví vykonatelná karta s
                  programem a vstupem do připravené místnosti.
                </span>
              </p>
            </div>
          )}

        {/* ═══ PLAYROOM PLANS ═══ */}
        {playroomPlans.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[0.5625rem] text-muted-foreground font-medium uppercase tracking-wider">
              Herna na dnes
            </p>
            {playroomPlans.map((plan) => (
              <PlanCard
                key={plan.id}
                plan={plan}
                isExpanded={expandedPlanId === plan.id}
                onToggleExpand={() =>
                  setExpandedPlanId(expandedPlanId === plan.id ? null : plan.id)
                }
                onStartSession={() => startSession(plan)}
                onEndSession={() => endSession(plan)}
                onRevert={() => revertStatus(plan)}
                onMarkDone={() => markDone(plan.id)}
                onDelete={() => deletePlan(plan.id)}
                onRegenerate={() => handlePartSelected(plan.selected_part)}
                onOpenLive={() => setActiveLivePlanId(plan.id)}
                prevSession={null}
                compact={compact}
                onOpenPrepRoom={onOpenPrepRoom}
              />
            ))}
          </div>
        )}

        {/* ═══ THERAPIST-LED SESSION PLANS ═══ */}
        {therapistSessionPlans.length > 0 && (
          <div className="mt-3 space-y-1.5">
            <p className="text-[0.5625rem] text-muted-foreground font-medium uppercase tracking-wider">
              Sezení na dnes
            </p>
            {therapistSessionPlans.map((plan) => (
              <PlanCard
                key={plan.id}
                plan={plan}
                isExpanded={expandedPlanId === plan.id}
                onToggleExpand={() =>
                  setExpandedPlanId(expandedPlanId === plan.id ? null : plan.id)
                }
                onStartSession={() => startSession(plan)}
                onEndSession={() => endSession(plan)}
                onRevert={() => revertStatus(plan)}
                onMarkDone={() => markDone(plan.id)}
                onDelete={() => deletePlan(plan.id)}
                onRegenerate={() => handlePartSelected(plan.selected_part)}
                onOpenLive={() => setActiveLivePlanId(plan.id)}
                prevSession={
                  plan.id === firstPendingPlan?.id ? prevSession : null
                }
                compact={compact}
                onOpenPrepRoom={onOpenPrepRoom}
              />
            ))}
          </div>
        )}

        {/* ═══ DEBUG-ONLY LEGACY / ANALYTIC DRAFTS ═══ */}
        {showLegacyDrafts && quarantinedPlans.length > 0 && (
          <div className="mt-3 space-y-1.5 rounded-md border border-dashed border-border/70 bg-muted/20 p-2.5">
            <p className="text-[0.5625rem] text-muted-foreground font-medium uppercase tracking-wider">
              Karanténa návrhů
            </p>
            {quarantinedPlans.map((plan) => (
              <PlanCard
                key={plan.id}
                plan={plan}
                isExpanded={expandedPlanId === plan.id}
                onToggleExpand={() =>
                  setExpandedPlanId(expandedPlanId === plan.id ? null : plan.id)
                }
                onStartSession={() => {}}
                onEndSession={() => {}}
                onRevert={() => revertStatus(plan)}
                onMarkDone={() => {}}
                onDelete={() => deletePlan(plan.id)}
                onRegenerate={() => handlePartSelected(plan.selected_part)}
                onOpenLive={() => {}}
                prevSession={null}
                isArchived
                compact={compact}
                onOpenPrepRoom={undefined}
              />
            ))}
          </div>
        )}

        {/* ═══ ARCHIVED PLANS (done/skipped) ═══ */}
        {archivedPlans.length > 0 && (
          <div className="mt-3 space-y-1.5">
            <p className="text-[0.5625rem] text-muted-foreground font-medium uppercase tracking-wider">
              Archiv
            </p>
            {archivedPlans.map((plan) => (
              <PlanCard
                key={plan.id}
                plan={plan}
                isExpanded={expandedPlanId === plan.id}
                onToggleExpand={() =>
                  setExpandedPlanId(expandedPlanId === plan.id ? null : plan.id)
                }
                onStartSession={() => {}}
                onEndSession={() => {}}
                onRevert={() => revertStatus(plan)}
                onMarkDone={() => {}}
                onDelete={() => deletePlan(plan.id)}
                onRegenerate={() => handlePartSelected(plan.selected_part)}
                onOpenLive={() => {}}
                prevSession={null}
                isArchived
                compact={compact}
                onOpenPrepRoom={onOpenPrepRoom}
              />
            ))}
          </div>
        )}
      </div>

      {/* ═══ THERAPIST PREFERENCE DIALOG ═══ */}
      <Dialog open={prefDialogOpen} onOpenChange={setPrefDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              <MessageSquare className="h-4 w-4 text-primary" />
              Příprava sezení: {prefSelectedPart}
            </DialogTitle>
            <DialogDescription className="text-xs">
              Karel se ptá, zda máš vlastní impulz pro dnešní sezení.
            </DialogDescription>
          </DialogHeader>

          {prefStep === "ask" && (
            <div className="space-y-3 pt-2">
              <p className="text-sm text-foreground">
                Máš nějaké konkrétní téma, motiv nebo situaci, kterou bys
                chtěl/a na dnešním sezení s <strong>{prefSelectedPart}</strong>{" "}
                zpracovat?
              </p>
              <p className="text-xs text-muted-foreground">
                Např. noční děsy, ranní situace, konkrétní konflikt, emoční
                stav…
              </p>
              <div className="flex gap-2 pt-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleNoPreference}
                  className="flex-1 text-xs"
                >
                  Nemám preference — Karel ať rozhodne
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  onClick={handleWantToSpecify}
                  className="flex-1 text-xs"
                >
                  Ano, chci upřesnit
                </Button>
              </div>
            </div>
          )}

          {prefStep === "detail" && (
            <div className="space-y-3 pt-2">
              <p className="text-sm text-foreground">
                Popiš situaci, téma nebo kontext, který chceš do plánu sezení s{" "}
                <strong>{prefSelectedPart}</strong> zahrnout:
              </p>
              <Textarea
                value={prefDetail}
                onChange={(e) => setPrefDetail(e.target.value)}
                placeholder={`Např.: Dnes ráno ${prefSelectedPart} plakal/a ze spaní…`}
                className="min-h-[7.5rem] text-sm resize-none"
              />
              <p className="text-[0.625rem] text-muted-foreground">
                Karel tyto informace zakomponuje jako prioritní vstup do plánu
                sezení.
              </p>
              <div className="flex gap-2 pt-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleNoPreference}
                  className="text-xs"
                >
                  Přeskočit
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  onClick={handleSubmitWithContext}
                  className="flex-1 text-xs"
                >
                  <Send className="mr-1 h-3 w-3" />
                  Vygenerovat s kontextem
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
};

// ═══ PLAN CARD COMPONENT ═══
interface PlanCardProps {
  plan: SessionPlan;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onStartSession: () => void;
  onEndSession: () => void;
  onRevert: () => void;
  onMarkDone: () => void;
  onDelete: () => void;
  onRegenerate: () => void;
  onOpenLive: () => void;
  prevSession: PreviousSession | null;
  isArchived?: boolean;
  /** Pracovna SESSION-CONTROLS CLEANUP: skrývá Přegenerovat / Smazat. */
  compact?: boolean;
  /** SESSION PREP ROOM PASS: otevírá `DeliberationRoom` modal. */
  onOpenPrepRoom?: (deliberationId: string) => void;
}

const PlanCard = ({
  plan,
  isExpanded,
  onToggleExpand,
  onStartSession,
  onEndSession,
  onRevert,
  onMarkDone,
  onDelete,
  onRegenerate,
  onOpenLive,
  prevSession,
  isArchived,
  compact = false,
  onOpenPrepRoom,
}: PlanCardProps) => {
  const leadLabel =
    plan.session_format === "crisis_intervention" || plan.session_lead === "all"
      ? "Karel (vlákno) · Káťa (telefon) · Hanička (sezení)"
      : plan.session_lead === "obe"
        ? "Hanka + Káťa"
        : plan.session_lead === "kata"
          ? "Káťa"
          : plan.session_lead === "karel"
            ? "Karel (online)"
            : "Hanka";
  const formatLabel =
    plan.session_format === "crisis_intervention"
      ? "krizová intervence"
      : plan.session_lead === "obe"
        ? "kombinované"
        : plan.session_format ||
          (plan.session_lead === "kata"
            ? "chat"
            : plan.session_lead === "karel"
              ? "online"
              : "osobně");

  // ── SESSION PREP ROOM PASS (2026-04-21) ──
  // Najde poradu (session_plan deliberation) navázanou na tento dnešní plán.
  // Když existuje:
  //   - approved → plán je „připravený k zahájení", aktivuj „Zahájit sezení"
  //   - active / awaiting_signoff → blokuj „Zahájit", nabídni „Otevřít přípravu"
  // Když neexistuje (legacy / manuálně generovaný plán mimo deliberation flow):
  //   - blokuj „Zahájit", nabídni „Připravit s týmem" (vytvoří poradu)
  // Když není dodán `onOpenPrepRoom` (komponenta žije mimo Pracovnu — např.
  // session prep wizard), prep gate se přeskakuje a UI je legacy chování.
  const prepGateEnabled = !!onOpenPrepRoom;
  const [localHernaApproved, setLocalHernaApproved] = useState(() =>
    isKarelDirectApprovedForHerna(plan),
  );
  useEffect(() => {
    setLocalHernaApproved(isKarelDirectApprovedForHerna(plan));
  }, [plan.id, plan.urgency_breakdown]);
  const {
    deliberation: prepRoom,
    loading: prepLoading,
    createForExistingPlan,
  } = useSessionPrepRoom(prepGateEnabled ? plan.id : null);
  const [creatingPrep, setCreatingPrep] = useState(false);
  const prepApproved = prepRoom?.status === "approved";
  const prepInProgress =
    prepRoom &&
    (prepRoom.status === "active" || prepRoom.status === "awaiting_signoff");
  const prepProgress = prepRoom ? signoffProgress(prepRoom) : null;
  const karelDirect = isKarelDirectPlan(plan);
  const legacyDraft = LEGACY_PLAN_GENERATORS.has(plan.generated_by);
  const analyticDraftWithoutContract =
    ANALYTIC_PLAN_GENERATORS.has(plan.generated_by) &&
    !hasExplicitRoleContract(plan);
  const quarantinedDraft = legacyDraft || analyticDraftWithoutContract;
  const hernaApproved = localHernaApproved;
  const startBlockedReason = programStartBlockedReason(plan);
  const hernaStatusLabel = hernaApproved
    ? "Schváleno"
    : "Čeká na schválení terapeutkami";
  // „Zahájit" je v Pracovně dostupné JEN když je plán schválený přes prep room.
  // Mimo Pracovnu (prepGateEnabled=false) zůstává staré chování.
  const startBlockedByPrep = prepGateEnabled && !prepApproved && !karelDirect;

  // 2026-04-22 — KAREL+ČÁST HERNA vstup z karty `Sezení s Karlem`.
  // Volá idempotentní `karel-part-session-prepare` a deep-linkuje do herny.
  const navigate = useNavigate();
  const [openingPartRoom, setOpeningPartRoom] = useState(false);

  // KAREL+ČÁST IN DNES TRUTH PASS (2026-04-22):
  //   Inline doplnění od Haničky / Káti k programu před vstupem do herny.
  //   Ukládáme do localStorage per plan.id (frontend-only, žádný nový model
  //   ani sloupec — uživatel výslovně řekl: "žádná nová tabulka").
  //   Při vstupu do herny se text předá do `karel-part-session-prepare` jako
  //   součást `briefing_proposed_session.therapist_addendum`, takže Karel ho
  //   zahrne do generování dnešního programu.
  const addendumKey = `karel_part_addendum_${plan.id}`;
  const [therapistAddendum, setTherapistAddendum] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return localStorage.getItem(addendumKey) ?? "";
  });
  const [addendumSavedAt, setAddendumSavedAt] = useState<string | null>(null);
  const [reviewBusy, setReviewBusy] = useState<
    "approve" | "defer" | "reject" | null
  >(null);
  const playroomPlan =
    plan.urgency_breakdown?.playroom_plan &&
    typeof plan.urgency_breakdown.playroom_plan === "object"
      ? plan.urgency_breakdown.playroom_plan
      : null;
  const therapeuticProgram = Array.isArray(playroomPlan?.therapeutic_program)
    ? playroomPlan.therapeutic_program
    : [];
  const onSaveAddendum = useCallback(() => {
    try {
      localStorage.setItem(addendumKey, therapistAddendum);
      setAddendumSavedAt(
        new Date().toLocaleTimeString("cs-CZ", {
          hour: "2-digit",
          minute: "2-digit",
        }),
      );
      toast.success("Doplnění uloženo. Karel ho použije při vstupu do herny.");
    } catch {
      toast.error("Nepodařilo se uložit doplnění.");
    }
  }, [addendumKey, therapistAddendum]);

  const updateHernaReview = useCallback(
    async (action: "approve" | "defer" | "reject") => {
      if (reviewBusy) return;
      setReviewBusy(action);
      try {
        const nextBreakdown = {
          ...plan.urgency_breakdown,
          approved_for_child_session: action === "approve",
          review_state:
            action === "approve"
              ? "approved"
              : action === "defer"
                ? "deferred"
                : "rejected",
          human_review_required: action !== "approve",
          approval: {
            ...(plan.urgency_breakdown?.approval ?? {}),
            required: action !== "approve",
            approved_for_child_session: action === "approve",
            review_state:
              action === "approve"
                ? "approved"
                : action === "defer"
                  ? "deferred"
                  : "rejected",
          },
          playroom_plan: hasPlayroomPlan(plan)
            ? {
                ...playroomPlan,
                therapist_review: {
                  ...(playroomPlan.therapist_review ?? {}),
                  required: action !== "approve",
                  approved_for_child_session: action === "approve",
                  review_state:
                    action === "approve"
                      ? "approved"
                      : action === "defer"
                        ? "deferred"
                        : "rejected",
                },
                approval: {
                  ...(playroomPlan.approval ?? {}),
                  required: action !== "approve",
                  approved_for_child_session: action === "approve",
                  review_state:
                    action === "approve"
                      ? "approved"
                      : action === "defer"
                        ? "deferred"
                        : "rejected",
                },
              }
            : undefined,
        };
        const nextProgramStatus =
          action === "approve"
            ? "approved"
            : action === "defer"
              ? "in_revision"
              : "cancelled";
        const { error } = await (supabase as any)
          .from("did_daily_session_plans")
          .update({
            urgency_breakdown: nextBreakdown,
            program_status: nextProgramStatus,
            status: action === "reject" ? "skipped" : plan.status,
          })
          .eq("id", plan.id);
        if (error) throw error;
        setLocalHernaApproved(action === "approve");
        toast.success(
          action === "approve"
            ? "Herna schválena."
            : action === "defer"
              ? "Herna odložena."
              : "Herna odmítnuta.",
        );
      } catch (e: any) {
        toast.error(e?.message || "Nepodařilo se uložit rozhodnutí.");
      } finally {
        setReviewBusy(null);
      }
    },
    [plan.id, plan.status, plan.urgency_breakdown, playroomPlan, reviewBusy],
  );

  const onOpenPartRoom = useCallback(async () => {
    if (openingPartRoom) return;
    const blockedReason = programStartBlockedReason(plan);
    if (blockedReason) {
      toast.info(blockedReason);
      return;
    }
    if (!hernaApproved) {
      toast.info("Čeká na lidské schválení před otevřením herny.");
      return;
    }
    if (!playroomPlan) {
      toast.error(
        "Integritní chyba: dnešní Herna nemá playroom_plan. Spusť znovu Karlův přehled, aby se program doplnil.",
      );
      return;
    }
    setOpeningPartRoom(true);
    try {
      // Vždy načteme aktuální verzi addenda z localStorage, aby se nezapomněla
      // poslední úprava, kterou terapeutka neuložila explicitně.
      const liveAddendum =
        (typeof window !== "undefined"
          ? localStorage.getItem(addendumKey)
          : "") ||
        therapistAddendum ||
        "";
      // C1 SESSION-LEAD TRUTH PASS (2026-04-22):
      //   `first_draft` / `plan_markdown` (therapist-led program) se sem
      //   NEPOSÍLÁ — Karel-led child-facing opener nesmí mít hint, který
      //   by mohl reprodukovat therapist-facing obsah.
      const { data, error } = await (supabase as any).functions.invoke(
        "karel-part-session-prepare",
        {
          body: {
            part_name: plan.selected_part,
            plan_id: plan.id,
            first_question: plan.urgency_breakdown?.first_question || undefined,
            session_actor: plan.urgency_breakdown?.session_actor || undefined,
            session_mode: plan.urgency_breakdown?.session_mode || undefined,
            readiness_today:
              plan.urgency_breakdown?.readiness_today || undefined,
            briefing_proposed_session: {
              why_today:
                playroomPlan.why_this_part_today ||
                `Schválená herna: ${plan.selected_part}`,
              duration_min: playroomPlan.duration_min || 20,
              led_by: "Karel",
              playroom_plan: playroomPlan,
              session_actor: plan.urgency_breakdown?.session_actor || undefined,
              session_mode: plan.urgency_breakdown?.session_mode || undefined,
              readiness_today:
                plan.urgency_breakdown?.readiness_today || undefined,
              first_question:
                plan.urgency_breakdown?.first_question || undefined,
              therapist_addendum: liveAddendum.trim() || undefined,
            },
          },
        },
      );
      if (error) throw error;
      const threadId = (data as any)?.thread_id;
      if ((data as any)?.deferred) {
        toast.info(
          "Karlův přímý kontakt je dnes odložený; vznikla doplňující otázka.",
        );
        return;
      }
      if (!threadId) throw new Error("Herna nebyla vytvořena.");
      toast.success(`🎲 Herna s ${plan.selected_part} otevřena.`);
      try {
        sessionStorage.setItem("karel_playroom_plan_id", plan.id);
        sessionStorage.setItem("karel_playroom_thread_id", threadId);
      } catch {
        /* ignore */
      }
      navigate(`/chat?workspace_thread=${threadId}`);
    } catch (e: any) {
      console.error("[DidDailySessionPlan] onOpenPartRoom failed:", e);
      toast.error(e?.message || "Nepodařilo se otevřít hernu.");
    } finally {
      setOpeningPartRoom(false);
    }
  }, [
    navigate,
    openingPartRoom,
    hernaApproved,
    plan,
    addendumKey,
    therapistAddendum,
  ]);

  // Overdue calculation using Prague timezone
  const todayPrague = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Prague",
  }).format(new Date());
  const isOverdue = plan.status === "generated" && plan.plan_date < todayPrague;
  const overdueDays = isOverdue
    ? Math.floor(
        (new Date(todayPrague).getTime() - new Date(plan.plan_date).getTime()) /
          (24 * 60 * 60 * 1000),
      )
    : 0;

  const needsReschedule = isOverdue && overdueDays >= 3;
  const awaitingWriteup = plan.status === "done" && !plan.completed_at;

  const lifeCycleBorder = needsReschedule
    ? "border-l-[3px] border-l-destructive"
    : plan.status === "in_progress"
      ? "border-l-[3px] border-l-[hsl(38,42%,48%)]"
      : plan.status === "done"
        ? "border-l-[3px] border-l-green-600/60"
        : isOverdue
          ? "border-l-[3px] border-l-amber-500"
          : "";

  const handleCreatePrep = async () => {
    if (creatingPrep) return;
    setCreatingPrep(true);
    try {
      const ledBy: "Hanička" | "Káťa" | "společně" =
        plan.session_lead === "kata"
          ? "Káťa"
          : plan.session_lead === "obe"
            ? "společně"
            : "Hanička";
      const created = await createForExistingPlan({
        daily_plan_id: plan.id,
        part_name: plan.selected_part,
        plan_markdown: plan.plan_markdown,
        led_by: ledBy,
      });
      if (created?.id) {
        toast.success("Přípravná místnost otevřena.");
        onOpenPrepRoom?.(created.id);
      } else {
        toast.error("Nepodařilo se založit přípravu.");
      }
    } catch (e: any) {
      toast.error(e?.message || "Nepodařilo se založit přípravu.");
    } finally {
      setCreatingPrep(false);
    }
  };

  return (
    <div
      className={`rounded-md border p-2.5 mt-1.5 transition-all ${lifeCycleBorder} ${
        isArchived
          ? "border-border/40 bg-muted/20 opacity-70"
          : "border-border/60 bg-background/40"
      }`}
    >
      <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
        <Badge
          variant="secondary"
          className="text-[0.6875rem] h-5 px-2 font-semibold"
        >
          {plan.selected_part}
        </Badge>
        {karelDirect && (
          <Badge
            variant="outline"
            className="text-[10px] h-5 px-1.5 border-primary/40 text-primary bg-primary/5"
          >
            <Dices className="mr-0.5 h-2.5 w-2.5" /> Karlova herna
          </Badge>
        )}
        {legacyDraft && (
          <Badge
            variant="outline"
            className="text-[10px] h-5 px-1.5 border-muted-foreground/40 text-muted-foreground bg-muted/30"
          >
            Legacy inspirační návrh — nepoužívat jako sezení
          </Badge>
        )}
        {analyticDraftWithoutContract && (
          <Badge
            variant="outline"
            className="text-[10px] h-5 px-1.5 border-amber-500/40 text-amber-700 bg-amber-500/5"
          >
            Operační/analytický návrh — vyžaduje převod do schvalovacího sezení
          </Badge>
        )}
        <span
          className={`h-2 w-2 rounded-full shrink-0 ${
            plan.urgency_score >= 8
              ? "bg-destructive"
              : plan.urgency_score >= 4
                ? "bg-amber-500"
                : "bg-primary"
          }`}
          title={`Naléhavost: ${plan.urgency_score}`}
        />
        {!karelDirect && !quarantinedDraft && (
          <Badge
            variant="outline"
            className="text-[10px] h-5 px-1.5 border-amber-600/40 text-amber-700 bg-amber-500/5"
          >
            <Users className="mr-0.5 h-2.5 w-2.5" /> VEDE: {leadLabel} (
            {formatLabel})
          </Badge>
        )}
        {/* Generated by badge */}
        {plan.generated_by === "auto" && (
          <Badge
            variant="outline"
            className="text-[9px] h-4 px-1 border-muted-foreground/30 text-muted-foreground"
          >
            auto
          </Badge>
        )}

        {/* Overdue badge */}
        {isOverdue && overdueDays >= 2 && (
          <Badge className="text-[0.625rem] h-5 px-1.5 bg-destructive/20 text-destructive border border-destructive/30">
            🔴 Čeká {overdueDays}{" "}
            {overdueDays >= 5 ? "dní" : overdueDays >= 2 ? "dny" : "den"}
          </Badge>
        )}

        {/* Status badges */}
        {karelDirect && plan.status === "generated" && !isOverdue && (
          <Badge
            variant="outline"
            className={`text-[10px] h-5 px-1.5 ${hernaApproved ? "border-primary/40 text-primary bg-primary/10" : "border-amber-500/50 text-amber-700 bg-amber-500/10"}`}
          >
            {hernaApproved ? (
              <CheckCircle2 className="mr-0.5 h-2.5 w-2.5" />
            ) : (
              <Lock className="mr-0.5 h-2.5 w-2.5" />
            )}
            {hernaStatusLabel}
          </Badge>
        )}
        {!karelDirect && plan.status === "generated" && !isOverdue && (
          <Badge
            variant="outline"
            className="text-[10px] h-5 px-1.5 border-amber-500/50 text-amber-600"
          >
            <Clock className="mr-0.5 h-2.5 w-2.5" /> Naplánováno
          </Badge>
        )}
        {plan.status === "generated" && isOverdue && !needsReschedule && (
          <Badge className="text-[10px] h-5 px-1.5 bg-amber-500/20 text-amber-600 border border-amber-500/30">
            <Clock className="mr-0.5 h-2.5 w-2.5" /> Čeká na zápis
          </Badge>
        )}
        {needsReschedule && (
          <Badge className="text-[10px] h-5 px-1.5 bg-destructive/20 text-destructive border border-destructive/30">
            <RefreshCw className="mr-0.5 h-2.5 w-2.5" /> Vyžaduje přeplánování
          </Badge>
        )}
        {plan.status === "in_progress" && (
          <Badge className="text-[0.625rem] h-5 px-1.5 bg-primary/20 text-primary border border-primary/30">
            <Play className="mr-0.5 h-2.5 w-2.5" /> Probíhá
          </Badge>
        )}
        {plan.status === "done" && (
          <Badge className="text-[0.625rem] h-5 px-1.5 bg-green-500/20 text-green-700 border border-green-500/30">
            <CheckCircle2 className="mr-0.5 h-2.5 w-2.5" /> Splněno
          </Badge>
        )}
        {plan.status === "skipped" && (
          <Badge
            variant="outline"
            className="text-[10px] h-5 px-1.5 border-muted-foreground/30 text-muted-foreground"
          >
            Přeskočeno
          </Badge>
        )}

        {/* SESSION PREP ROOM PASS — stav přípravné místnosti.
            Renderuje se jen když je gate aktivní (Pracovna). */}
        {prepGateEnabled &&
          !karelDirect &&
          !quarantinedDraft &&
          plan.status === "generated" &&
          !isArchived &&
          (prepLoading ? (
            <Badge
              variant="outline"
              className="text-[10px] h-5 px-1.5 border-muted-foreground/30 text-muted-foreground"
            >
              <Loader2 className="mr-0.5 h-2.5 w-2.5 animate-spin" /> Příprava…
            </Badge>
          ) : prepApproved ? (
            <Badge className="text-[10px] h-5 px-1.5 bg-primary/15 text-primary border border-primary/30">
              <CheckCircle2 className="mr-0.5 h-2.5 w-2.5" /> Připraveno k
              zahájení
            </Badge>
          ) : prepInProgress ? (
            <Badge className="text-[10px] h-5 px-1.5 bg-amber-500/15 text-amber-700 border border-amber-500/30">
              <Users className="mr-0.5 h-2.5 w-2.5" />
              Příprava ({prepProgress?.signed ?? 0}/{prepProgress?.total ?? 2}{" "}
              podpisů)
            </Badge>
          ) : (
            <Badge
              variant="outline"
              className="text-[10px] h-5 px-1.5 border-amber-500/40 text-amber-700"
            >
              <Lock className="mr-0.5 h-2.5 w-2.5" /> Bez schválené přípravy
            </Badge>
          ))}

        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={onToggleExpand}
            className="h-6 px-1.5 text-[0.625rem]"
          >
            {isExpanded ? (
              <ChevronUp className="h-3 w-3" />
            ) : (
              <ChevronDown className="h-3 w-3" />
            )}
          </Button>
        </div>
      </div>

      {/* ═══ GATE BLOCKER STRIP — viditelná pravda, proč Zahájit nejde ═══
           Renderuje se POUZE když je prep gate aktivní (Pracovna), plán je
           naplánovaný (status=generated) a NENÍ schválený poradou. Hanka tak
           okamžitě vidí, co chybí, a nemusí hádat z disabled tlačítka. */}
      {prepGateEnabled &&
        !karelDirect &&
        !quarantinedDraft &&
        plan.status === "generated" &&
        !isArchived &&
        !prepLoading &&
        !prepApproved && (
          <div className="mb-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5">
            <p className="text-[0.625rem] leading-4 text-amber-800 dark:text-amber-300">
              <Lock className="mr-1 inline h-2.5 w-2.5 -mt-px" />
              <strong>Zahájit nelze bez schválené týmové přípravy.</strong>{" "}
              {prepInProgress ? (
                <>
                  Porada už běží — chybí{" "}
                  {prepProgress?.missing
                    .map((m) => (m === "hanka" ? "Hanička" : "Káťa"))
                    .join(" + ") || "podpis"}
                  .
                </>
              ) : (
                <>
                  Otevřete přípravnou místnost (Karel ↔ Hanička ↔ Káťa).
                  Schválení vyžaduje podpis Haničky a Káti.
                </>
              )}
            </p>
          </div>
        )}
      {karelDirect &&
        !hernaApproved &&
        plan.status === "generated" &&
        !isArchived && (
          <div className="mb-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5">
            <p className="text-[0.625rem] leading-4 text-amber-800 dark:text-amber-300">
              <Lock className="mr-1 inline h-2.5 w-2.5 -mt-px" />
              {startBlockedReason || "Čeká na schválení terapeutkami."}
            </p>
          </div>
        )}
      {karelDirect &&
        hernaApproved &&
        plan.status === "generated" &&
        !isArchived && (
          <div className="mb-1.5 rounded-md border border-primary/30 bg-primary/10 px-2.5 py-1.5">
            <p className="text-[0.625rem] leading-4 text-primary">
              <CheckCircle2 className="mr-1 inline h-2.5 w-2.5 -mt-px" />
              Schváleno pro: <strong>{plan.selected_part}</strong>
            </p>
          </div>
        )}

      {/* ═══ ACTION BUTTONS ═══ */}
      <div className="flex flex-wrap items-center gap-1 mb-1.5">
        {plan.status === "generated" && !isArchived && !quarantinedDraft && (
          <>
            {/* SESSION PREP ROOM PASS — primární akce v Pracovně:
                 - Když existuje rozpracovaná porada → "Otevřít přípravu"
                 - Když porada neexistuje → "Připravit s týmem" (vytvoří ji)
                 - Když je porada schválená → fallthrough na "Zahájit" níže
                 Mimo Pracovnu (prepGateEnabled=false) se nic z toho nerendrují. */}
            {prepGateEnabled && !karelDirect && prepInProgress && prepRoom && (
              <Button
                variant="default"
                size="sm"
                onClick={() => onOpenPrepRoom?.(prepRoom.id)}
                className="h-6 px-2 text-[10px]"
              >
                <Users className="mr-0.5 h-2.5 w-2.5" /> Otevřít přípravu
                {prepProgress &&
                  ` (${prepProgress.signed}/${prepProgress.total})`}
              </Button>
            )}
            {prepGateEnabled && !karelDirect && !prepLoading && !prepRoom && (
              <Button
                variant="default"
                size="sm"
                onClick={handleCreatePrep}
                disabled={creatingPrep}
                className="h-6 px-2 text-[10px]"
              >
                {creatingPrep ? (
                  <Loader2 className="mr-0.5 h-2.5 w-2.5 animate-spin" />
                ) : (
                  <Users className="mr-0.5 h-2.5 w-2.5" />
                )}
                Připravit s týmem
              </Button>
            )}
            {karelDirect && !hernaApproved && (
              <>
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => updateHernaReview("approve")}
                  disabled={!!reviewBusy}
                  className="h-6 px-2 text-[10px]"
                >
                  {reviewBusy === "approve" ? (
                    <Loader2 className="mr-0.5 h-2.5 w-2.5 animate-spin" />
                  ) : (
                    <CheckCircle2 className="mr-0.5 h-2.5 w-2.5" />
                  )}
                  Schválit hernu
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onToggleExpand}
                  className="h-6 px-2 text-[10px]"
                >
                  <PenLine className="mr-0.5 h-2.5 w-2.5" /> Upravit / poznámka
                  pro Karla
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => updateHernaReview("defer")}
                  disabled={!!reviewBusy}
                  className="h-6 px-2 text-[10px]"
                >
                  Odložit
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => updateHernaReview("reject")}
                  disabled={!!reviewBusy}
                  className="h-6 px-2 text-[10px] border-destructive/40 text-destructive hover:bg-destructive/10"
                >
                  Odmítnout
                </Button>
              </>
            )}
            {/* SPUSTIT-SEZENI MIGRACE (2026-04-23):
                Když je porada schválená, Spustit sezení žije VÝHRADNĚ v ní
                (DeliberationRoom má dedikované tlačítko, které propíše živý
                program a otevře LIVE panel). Zde tlačítko „Zahájit" v té
                situaci skrýváme, místo něj nabídneme „Otevřít poradu →
                spustit", aby Hanka neměla dvě konfliktní akce.
                Když porada NEEXISTUJE (legacy plán bez prep gatu) nebo gate
                není aktivní, zachováváme staré chování s tlačítkem Zahájit. */}
            {karelDirect ? null : prepGateEnabled &&
              prepApproved &&
              prepRoom ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onOpenPrepRoom?.(prepRoom.id)}
                className="h-6 px-2 text-[10px] border-primary/40 text-primary hover:bg-primary/10"
                title="Otevři poradu — spuštění sezení je tam (po podpisech)."
              >
                <Play className="mr-0.5 h-2.5 w-2.5" /> Otevřít poradu → spustit
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={onStartSession}
                disabled={startBlockedByPrep || !!startBlockedReason}
                title={
                  startBlockedReason ||
                  (startBlockedByPrep
                    ? "Nejdřív tým musí v přípravné místnosti podepsat plán."
                    : undefined)
                }
                className="h-6 px-2 text-[10px] border-primary/40 text-primary hover:bg-primary/10 disabled:opacity-50"
              >
                <Play className="mr-0.5 h-2.5 w-2.5" /> Zahájit
              </Button>
            )}
            {/* 2026-04-22 — KAREL+ČÁST HERNA: vstup do připravené místnosti.
                 Renderuje se jen když je plán schválený poradou (prepApproved).
                 KAREL+ČÁST IN DNES TRUTH PASS (2026-04-22): odstraněn gating
                 podle session_format — Karel může mít své sezení s částí i v
                 krizovém kontextu (krize ≠ vyloučení Karlova vlastního sezení).
                 Klik volá `karel-part-session-prepare` (idempotentní) a deep-linkuje
                 do `/chat?workspace_thread=<id>`. */}
            {prepGateEnabled && hernaApproved && (
              <Button
                variant="default"
                size="sm"
                onClick={onOpenPartRoom}
                disabled={
                  openingPartRoom ||
                  !!startBlockedReason ||
                  (karelDirect && !hernaApproved)
                }
                className="h-6 px-2 text-[10px]"
                title={
                  startBlockedReason || `Otevřít hernu s ${plan.selected_part}`
                }
              >
                {openingPartRoom ? (
                  <Loader2 className="mr-0.5 h-2.5 w-2.5 animate-spin" />
                ) : (
                  <Dices className="mr-0.5 h-2.5 w-2.5" />
                )}
                Vstup do herny
              </Button>
            )}
            {!karelDirect && (
              <Button
                variant="outline"
                size="sm"
                onClick={onMarkDone}
                className="h-6 px-2 text-[10px] border-green-500/40 text-green-700 hover:bg-green-500/10"
              >
                <CheckCircle2 className="mr-0.5 h-2.5 w-2.5" /> Splněno
              </Button>
            )}
          </>
        )}
        {plan.status === "in_progress" && !isArchived && (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={onOpenLive}
              className="h-6 px-2 text-[10px] border-primary/40 text-primary hover:bg-primary/10"
            >
              <Play className="mr-0.5 h-2.5 w-2.5" /> Live
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={onEndSession}
              className="h-6 px-2 text-[10px] border-green-500/40 text-green-700 hover:bg-green-500/10"
            >
              <Square className="mr-0.5 h-2.5 w-2.5" /> Ukončit
            </Button>
          </>
        )}
        {plan.status === "done" && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onRevert}
            className="h-6 px-2 text-[0.625rem] text-muted-foreground"
          >
            ↩ Vrátit
          </Button>
        )}
        {!compact && (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={onRegenerate}
              className="h-6 px-2 text-[0.625rem] text-muted-foreground"
            >
              <RefreshCw className="mr-0.5 h-2.5 w-2.5" /> Přegenerovat
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onDelete}
              className="h-6 px-2 text-[0.625rem] text-destructive/70 hover:text-destructive"
            >
              <Trash2 className="mr-0.5 h-2.5 w-2.5" /> Smazat
            </Button>
          </>
        )}
      </div>

      {/* ═══ EXPANDED CONTENT ═══ */}
      {isExpanded && (
        <div className="mt-2 space-y-3 max-h-[31.25rem] overflow-y-auto">
          <div className="rounded-md border border-border/60 bg-background/40 p-3 session-plan-content">
            {karelDirect && playroomPlan ? (
              <div className="space-y-3 text-[0.6875rem] leading-relaxed">
                <div>
                  <p className="font-semibold text-foreground">
                    Samostatný program Herny pro terapeutky
                  </p>
                  <p className="text-muted-foreground">
                    Pro: <strong>{plan.selected_part}</strong> · Stav:{" "}
                    {hernaStatusLabel}
                  </p>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <p>
                    <strong>Proč dnes:</strong>{" "}
                    {playroomPlan.why_this_part_today}
                  </p>
                  <p>
                    <strong>Cíl:</strong> {playroomPlan.clinical_goal}
                  </p>
                  <p>
                    <strong>Prakticky:</strong>{" "}
                    {playroomPlan.practical_goal ||
                      playroomPlan.therapeutic_frame}
                  </p>
                  <p>
                    <strong>Režim:</strong>{" "}
                    {playroomPlan.session_mode ||
                      plan.urgency_breakdown?.session_mode}{" "}
                    · {playroomPlan.duration_min || "?"} min
                  </p>
                </div>
                {playroomPlan.room_design && (
                  <div>
                    <p className="font-semibold text-foreground mb-1">
                      Místnost
                    </p>
                    <p>{playroomPlan.room_design?.visual_theme}</p>
                    <p className="text-muted-foreground">
                      Vstup: {playroomPlan.room_design?.opening_scene} · Konec:{" "}
                      {playroomPlan.room_design?.exit_symbol}
                    </p>
                  </div>
                )}
                <div className="space-y-2">
                  <p className="font-semibold text-foreground">
                    Terapeutický program ({therapeuticProgram.length} kroků)
                  </p>
                  {therapeuticProgram.map((step: any, index: number) => (
                    <div
                      key={`${step.step ?? index}-${step.title ?? "krok"}`}
                      className="rounded-md border border-border/50 bg-background/50 p-2"
                    >
                      <p className="font-medium text-foreground">
                        {step.step}. {step.title}
                      </p>
                      <p>
                        <strong>Instrukce pro Karla:</strong>{" "}
                        {step.instruction_for_karel ||
                          step.karel_internal_instruction}
                      </p>
                      <p>
                        <strong>Sledovat:</strong>{" "}
                        {step.expected_signal ||
                          (step.text_signals_to_observe ?? []).join(", ")}
                      </p>
                      {step.clinical_intent && (
                        <p>
                          <strong>Cíl:</strong> {step.clinical_intent}
                        </p>
                      )}
                      {step.method && (
                        <p>
                          <strong>Metoda:</strong> {step.method}{" "}
                          {step.why_this_method
                            ? `— ${step.why_this_method}`
                            : ""}
                        </p>
                      )}
                      {step.stop_if && (
                        <p>
                          <strong>Stop:</strong>{" "}
                          {(step.stop_if ?? []).join(", ")}
                        </p>
                      )}
                      {step.fallback && (
                        <p>
                          <strong>Fallback:</strong> {step.fallback}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <RichMarkdown compact>{plan.plan_markdown}</RichMarkdown>
            )}
          </div>

          {/* KAREL+ČÁST IN DNES TRUTH PASS (2026-04-22):
               Inline doplnění od Haničky / Káti k programu před vstupem do herny.
               Renderuje se v Pracovně (prepGateEnabled) a jen u plánů, které
               ještě nejsou ukončené. Text se ukládá do localStorage per plan.id
               a předává se do `karel-part-session-prepare` jako součást briefingu. */}
          {prepGateEnabled &&
            !quarantinedDraft &&
            !isArchived &&
            plan.status !== "done" && (
              <div className="rounded-md border border-primary/20 bg-primary/5 p-3 space-y-2">
                <div className="flex items-center gap-1.5">
                  <PenLine className="w-3 h-3 text-primary" />
                  <span className="text-[0.6875rem] font-medium text-primary">
                    Doplnění před vstupem do herny
                  </span>
                  {addendumSavedAt && (
                    <span className="text-[0.5625rem] text-muted-foreground ml-auto">
                      uloženo {addendumSavedAt}
                    </span>
                  )}
                </div>
                <p className="text-[0.625rem] leading-4 text-muted-foreground">
                  Hanička / Káťa — chceš ještě před spuštěním Karlovi něco
                  doplnit ke schválenému programu? (např. ranní stav, čerstvý
                  postřeh, na co dnes obzvlášť dát pozor) Karel to zahrne do
                  dnešního programu.
                </p>
                <Textarea
                  value={therapistAddendum}
                  onChange={(e) => setTherapistAddendum(e.target.value)}
                  placeholder={`Volitelné. Např.: Tundrupek se ráno probudil zmatený, spí špatně po novém léku — buď s ním obzvlášť jemný…`}
                  className="min-h-[4.5rem] text-[0.6875rem] resize-none bg-background/60 border-border/60"
                />
                <div className="flex items-center justify-end">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={onSaveAddendum}
                    disabled={!therapistAddendum.trim()}
                    className="h-6 px-2 text-[0.625rem]"
                  >
                    Uložit doplnění
                  </Button>
                </div>
              </div>
            )}

          {prevSession && (
            <div className="rounded-md border border-border/60 bg-background/40 p-3 space-y-2.5">
              <div className="flex items-center gap-1.5 text-[0.625rem] font-medium text-muted-foreground">
                <FileText className="w-3 h-3 text-primary" />
                Poslední sezení — {prevSession.therapist},{" "}
                {prevSession.session_date}
              </div>

              {prevSession.handoff_note && prevSession.handoff_note.trim() && (
                <div className="rounded-md bg-primary/5 border border-primary/15 p-2.5">
                  <span className="text-[0.5625rem] font-medium text-primary flex items-center gap-1 mb-1">
                    <MessageSquare className="w-2.5 h-2.5" />
                    Předání pro kolegyni
                  </span>
                  <p className="text-[0.625rem] leading-4 text-foreground whitespace-pre-wrap">
                    {prevSession.handoff_note}
                  </p>
                </div>
              )}

              {prevSession.ai_analysis && prevSession.ai_analysis.trim() && (
                <div>
                  <span className="text-[0.5625rem] font-medium text-muted-foreground flex items-center gap-1 mb-1">
                    <Brain className="w-2.5 h-2.5" />
                    AI analýza sezení
                  </span>
                  <div className="text-[0.625rem] leading-4 text-muted-foreground">
                    <RichMarkdown compact>
                      {prevSession.ai_analysis}
                    </RichMarkdown>
                  </div>
                </div>
              )}

              {(() => {
                const notes = prevSession.karel_notes || "";
                const refIdx = notes.indexOf("## REFLEXE TERAPEUTKY");
                if (refIdx === -1) return null;
                const refText = notes
                  .slice(refIdx + "## REFLEXE TERAPEUTKY".length)
                  .trim();
                if (!refText) return null;
                return (
                  <div className="rounded-md bg-amber-500/5 border border-amber-500/15 p-2.5">
                    <span className="text-[0.5625rem] font-medium text-amber-700 dark:text-amber-400 flex items-center gap-1 mb-1">
                      <PenLine className="w-2.5 h-2.5" />
                      Reflexe terapeutky
                    </span>
                    <p className="text-[0.625rem] leading-4 text-foreground whitespace-pre-wrap">
                      {refText}
                    </p>
                  </div>
                );
              })()}

              {!prevSession.handoff_note?.trim() &&
                !prevSession.ai_analysis?.trim() && (
                  <p className="text-[0.625rem] text-muted-foreground/60 italic">
                    Bez detailů z minulého sezení.
                  </p>
                )}
            </div>
          )}
        </div>
      )}

      {!isExpanded && (
        <p className="text-[0.625rem] text-muted-foreground line-clamp-1">
          {plan.plan_markdown.replace(/[#*\-]/g, "").slice(0, 100)}…
        </p>
      )}
    </div>
  );
};

export default DidDailySessionPlan;

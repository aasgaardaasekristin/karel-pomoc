import { useCallback, useEffect, useState, useRef } from "react";
import { Target, Loader2, Zap, CheckCircle2, Search, Brain, FileText, Send, UserRoundCog, ChevronDown, ChevronUp, PenLine, MessageSquare, Play, Square, Clock, Trash2, RefreshCw, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";
import { getAuthHeaders } from "@/lib/auth";
import { toast } from "sonner";
import RichMarkdown from "@/components/ui/RichMarkdown";

interface SessionPlan {
  id: string;
  plan_date: string;
  selected_part: string;
  urgency_score: number;
  urgency_breakdown: Record<string, number>;
  plan_markdown: string;
  therapist: string;
  status: string;
  distributed_drive: boolean;
  distributed_email: boolean;
  generated_by: string;
  completed_at: string | null;
  session_lead: string;
  session_format: string;
  overdue_days: number;
  created_at?: string;
}

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

const DidDailySessionPlan = ({ refreshTrigger, compact = false }: Props) => {
  const [plans, setPlans] = useState<SessionPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [genStep, setGenStep] = useState(0);
  const [expandedPlanId, setExpandedPlanId] = useState<string | null>(null);
  const [registryParts, setRegistryParts] = useState<{ part_name: string; status: string }[]>([]);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [customPartName, setCustomPartName] = useState("");
  const [prevSession, setPrevSession] = useState<PreviousSession | null>(null);

  // Preference dialog state
  const [prefDialogOpen, setPrefDialogOpen] = useState(false);
  const [prefSelectedPart, setPrefSelectedPart] = useState("");
  const [prefStep, setPrefStep] = useState<"ask" | "detail">("ask");
  const [prefDetail, setPrefDetail] = useState("");

  // Live session state
  const [liveSessionActive, setLiveSessionActive] = useState(false);
  const [openingSessionThread, setOpeningSessionThread] = useState(false);

  // Today key (Prague TZ) — used as filter and for "stale" guard
  const todayPragueKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague" }).format(new Date());

  // First pending plan TODAY only (no stale plans from yesterday allowed as "today's reality")
  const firstPendingPlan = plans.find(
    p => (p.status === "generated" || p.status === "in_progress") && p.plan_date === todayPragueKey
  ) || null;

  const loadTodayPlans = useCallback(async () => {
    setLoading(true);
    try {
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague" }).format(new Date());
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

  useEffect(() => { loadTodayPlans(); }, [loadTodayPlans, refreshTrigger]);

  // Load previous session for first pending plan
  useEffect(() => {
    const plan = firstPendingPlan;
    if (!plan?.selected_part) { setPrevSession(null); return; }
    const loadPrev = async () => {
      const currentTherapist = (plan.therapist || "hanka").toLowerCase();
      let query = supabase
        .from("did_part_sessions")
        .select("therapist, session_date, ai_analysis, handoff_note, karel_notes")
        .eq("part_name", plan.selected_part)
        .order("created_at", { ascending: false })
        .limit(10);
      const { data: rows } = await query;
      const other = (rows || []).find(r =>
        r.therapist?.toLowerCase() !== currentTherapist
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

  useEffect(() => { loadRegistryParts(); }, [loadRegistryParts]);

  const generatePlan = useCallback(async (forcePart?: string, therapistContext?: string) => {
    setGenerating(true);
    setGenStep(0);

    const stepTimer = setInterval(() => {
      setGenStep(prev => {
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
        { method: "POST", headers, body: JSON.stringify(body) }
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
        const leadLabel = data.sessionLead === "obe" ? "Hanka + Káťa" : data.sessionLead === "kata" ? "Káťa" : "Hanka";
        toast.success(`Plán vygenerován pro ${data.selectedPart} (VEDE: ${leadLabel})`);
      }
      await loadTodayPlans();
    } catch (e: any) {
      clearInterval(stepTimer);
      toast.error(e.message || "Generování plánu selhalo");
    } finally {
      setGenerating(false);
      setGenStep(0);
    }
  }, [loadTodayPlans]);

  // ═══ MARK AS DONE ═══
  const markDone = useCallback(async (planId: string) => {
    try {
      await (supabase as any)
        .from("did_daily_session_plans")
        .update({ status: "done", completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", planId);
      setPlans(prev => prev.map(p => p.id === planId ? { ...p, status: "done", completed_at: new Date().toISOString() } : p));
      toast.success("Plán označen jako splněný");
    } catch (e) {
      toast.error("Nepodařilo se označit plán");
    }
  }, []);

  // ═══ DELETE PLAN ═══
  const deletePlan = useCallback(async (planId: string) => {
    if (!window.confirm("Opravdu smazat tento plán? Tato akce je nevratná.")) return;
    try {
      await (supabase as any)
        .from("did_daily_session_plans")
        .delete()
        .eq("id", planId);
      setPlans(prev => prev.filter(p => p.id !== planId));
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
        .update({ last_seen_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .ilike("part_name", plan.selected_part);

      await (supabase as any)
        .from("did_daily_session_plans")
        .update({ status: "in_progress", updated_at: new Date().toISOString() })
        .eq("id", plan.id);

      setPlans(prev => prev.map(p => p.id === plan.id ? { ...p, status: "in_progress" } : p));
      setLiveSessionActive(true);
      toast.success(`Sezení s ${plan.selected_part} zahájeno`);
    } catch (e: any) {
      toast.error("Nepodařilo se zahájit sezení");
      console.error(e);
    }
  }, []);

  // ═══ SESSION END ═══
  const endSession = useCallback(async (plan: SessionPlan) => {
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

      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague" }).format(new Date());
      const driveContent = `## Záznam sezení — ${today}\n**Část:** ${plan.selected_part}\n**Naléhavost:** ${plan.urgency_score}\n**Terapeutka:** ${plan.session_lead === "kata" ? "Káťa" : "Hanka"} (${plan.session_format})\n\n### Plán sezení\n${plan.plan_markdown}\n\n---\n*Záznam vytvořen automaticky při ukončení sezení.*`;

      await supabase
        .from("did_pending_drive_writes")
        .insert({
          target_document: `06_INTERVENCE/${today}_${plan.selected_part}`,
          content: driveContent,
          write_type: "create",
          priority: "high",
        });

      await (supabase as any)
        .from("did_daily_session_plans")
        .update({ status: "done", completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", plan.id);

      setPlans(prev => prev.map(p => p.id === plan.id ? { ...p, status: "done", completed_at: new Date().toISOString() } : p));
      toast.success(`Sezení s ${plan.selected_part} ukončeno — záznam odeslán na Drive`);
    } catch (e: any) {
      toast.error("Nepodařilo se ukončit sezení");
      console.error(e);
    }
  }, []);

  // ═══ REVERT STATUS ═══
  const revertStatus = useCallback(async (plan: SessionPlan) => {
    try {
      await (supabase as any)
        .from("did_daily_session_plans")
        .update({ status: "generated", completed_at: null, updated_at: new Date().toISOString() })
        .eq("id", plan.id);
      setPlans(prev => prev.map(p => p.id === plan.id ? { ...p, status: "generated", completed_at: null } : p));
      setLiveSessionActive(false);
      toast.success("Stav vrácen na Naplánováno");
    } catch (e: any) {
      toast.error("Nepodařilo se změnit stav");
    }
  }, []);

  // ═══ LIVE SESSION END HANDLER ═══
  const handleLiveSessionEnd = useCallback(async (summary: string) => {
    setLiveSessionActive(false);
    const plan = firstPendingPlan;
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
  }, [firstPendingPlan, endSession]);

  if (loading) {
    return (
      <div className="mb-4 rounded-lg border border-border/70 bg-card/38 p-3 backdrop-blur-sm">
        <div className="flex items-center text-xs text-muted-foreground">
          <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> Načítám plány sezení...
        </div>
      </div>
    );
  }

  // ═══ LIVE SESSION ACTIVE → show DidLiveSessionPanel ═══
  if (liveSessionActive && firstPendingPlan) {
    return (
      <div className="mb-4 rounded-lg border border-border/70 bg-card/38 backdrop-blur-sm overflow-hidden" style={{ minHeight: "60vh" }}>
        <DidLiveSessionPanel
          partName={firstPendingPlan.selected_part}
          therapistName={firstPendingPlan.session_lead === "kata" ? "Káťa" : "Hanka"}
          contextBrief={firstPendingPlan.plan_markdown}
          onEnd={handleLiveSessionEnd}
          onBack={() => setLiveSessionActive(false)}
        />
      </div>
    );
  }

  // Split plans into pending and archived
  const pendingPlans = plans.filter(p => p.status === "generated" || p.status === "in_progress");
  const archivedPlans = plans.filter(p => p.status === "done" || p.status === "skipped");

  return (
    <>
      <div className="mb-4 rounded-lg border border-border/70 bg-card/38 p-3 backdrop-blur-sm sm:p-4">
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-xs font-medium text-foreground flex items-center gap-1.5">
            <Target className="w-3.5 h-3.5 text-primary" />
            Plán sezení na dnes
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
                <Popover open={overrideOpen} onOpenChange={(open) => { setOverrideOpen(open); if (!open) setCustomPartName(""); }}>
                  <PopoverTrigger asChild>
                    <Button variant="outline" size="sm" className="h-7 px-2 text-[10px]">
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
                        <p className="text-[0.625rem] text-muted-foreground px-2 py-1">Žádné aktivní části v registru</p>
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

        {plans.length === 0 && !generating && (
          <p className="text-[0.6875rem] text-muted-foreground">
            Automatický plán se generuje v 6:00. Můžeš ho vygenerovat i ručně.
          </p>
        )}

        {/* ═══ PENDING PLANS ═══ */}
        {pendingPlans.map((plan) => (
          <PlanCard
            key={plan.id}
            plan={plan}
            isExpanded={expandedPlanId === plan.id}
            onToggleExpand={() => setExpandedPlanId(expandedPlanId === plan.id ? null : plan.id)}
            onStartSession={() => startSession(plan)}
            onEndSession={() => endSession(plan)}
            onRevert={() => revertStatus(plan)}
            onMarkDone={() => markDone(plan.id)}
            onDelete={() => deletePlan(plan.id)}
            onRegenerate={() => handlePartSelected(plan.selected_part)}
            onOpenLive={() => setLiveSessionActive(true)}
            prevSession={plan.id === firstPendingPlan?.id ? prevSession : null}
            compact={compact}
          />
        ))}

        {/* ═══ ARCHIVED PLANS (done/skipped) ═══ */}
        {archivedPlans.length > 0 && (
          <div className="mt-3 space-y-1.5">
            <p className="text-[0.5625rem] text-muted-foreground font-medium uppercase tracking-wider">Archiv</p>
            {archivedPlans.map((plan) => (
              <PlanCard
                key={plan.id}
                plan={plan}
                isExpanded={expandedPlanId === plan.id}
                onToggleExpand={() => setExpandedPlanId(expandedPlanId === plan.id ? null : plan.id)}
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
                Máš nějaké konkrétní téma, motiv nebo situaci, kterou bys chtěl/a na dnešním sezení s <strong>{prefSelectedPart}</strong> zpracovat?
              </p>
              <p className="text-xs text-muted-foreground">
                Např. noční děsy, ranní situace, konkrétní konflikt, emoční stav…
              </p>
              <div className="flex gap-2 pt-1">
                <Button variant="outline" size="sm" onClick={handleNoPreference} className="flex-1 text-xs">
                  Nemám preference — Karel ať rozhodne
                </Button>
                <Button variant="default" size="sm" onClick={handleWantToSpecify} className="flex-1 text-xs">
                  Ano, chci upřesnit
                </Button>
              </div>
            </div>
          )}

          {prefStep === "detail" && (
            <div className="space-y-3 pt-2">
              <p className="text-sm text-foreground">
                Popiš situaci, téma nebo kontext, který chceš do plánu sezení s <strong>{prefSelectedPart}</strong> zahrnout:
              </p>
              <Textarea
                value={prefDetail}
                onChange={(e) => setPrefDetail(e.target.value)}
                placeholder={`Např.: Dnes ráno ${prefSelectedPart} plakal/a ze spaní…`}
                className="min-h-[7.5rem] text-sm resize-none"
              />
              <p className="text-[0.625rem] text-muted-foreground">
                Karel tyto informace zakomponuje jako prioritní vstup do plánu sezení.
              </p>
              <div className="flex gap-2 pt-1">
                <Button variant="outline" size="sm" onClick={handleNoPreference} className="text-xs">
                  Přeskočit
                </Button>
                <Button variant="default" size="sm" onClick={handleSubmitWithContext} className="flex-1 text-xs">
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
}: PlanCardProps) => {
  const leadLabel = plan.session_format === "crisis_intervention" || plan.session_lead === "all"
    ? "Karel (vlákno) · Káťa (telefon) · Hanička (sezení)"
    : plan.session_lead === "obe" ? "Hanka + Káťa" : plan.session_lead === "kata" ? "Káťa" : "Hanka";
  const formatLabel = plan.session_format === "crisis_intervention"
    ? "krizová intervence"
    : plan.session_lead === "obe" ? "kombinované" : plan.session_format || (plan.session_lead === "kata" ? "chat" : "osobně");

  // Overdue calculation using Prague timezone
  const todayPrague = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague" }).format(new Date());
  const isOverdue = plan.status === "generated" && plan.plan_date < todayPrague;
  const overdueDays = isOverdue
    ? Math.floor((new Date(todayPrague).getTime() - new Date(plan.plan_date).getTime()) / (24 * 60 * 60 * 1000))
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

  return (
    <div className={`rounded-md border p-2.5 mt-1.5 transition-all ${lifeCycleBorder} ${
      isArchived
        ? "border-border/40 bg-muted/20 opacity-70"
        : "border-border/60 bg-background/40"
    }`}>
      <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
        <Badge variant="secondary" className="text-[0.6875rem] h-5 px-2 font-semibold">
          {plan.selected_part}
        </Badge>
        <span className={`h-2 w-2 rounded-full shrink-0 ${
          plan.urgency_score >= 8 ? "bg-destructive" : plan.urgency_score >= 4 ? "bg-amber-500" : "bg-primary"
        }`} title={`Naléhavost: ${plan.urgency_score}`} />

        {/* Session lead badge */}
        <Badge variant="outline" className="text-[10px] h-5 px-1.5 border-primary/30 text-primary">
          VEDE: {leadLabel} ({formatLabel})
        </Badge>

        {/* Generated by badge */}
        {plan.generated_by === "auto" && (
          <Badge variant="outline" className="text-[9px] h-4 px-1 border-muted-foreground/30 text-muted-foreground">
            auto
          </Badge>
        )}

        {/* Overdue badge */}
        {isOverdue && overdueDays >= 2 && (
          <Badge className="text-[0.625rem] h-5 px-1.5 bg-destructive/20 text-destructive border border-destructive/30">
            🔴 Čeká {overdueDays} {overdueDays >= 5 ? "dní" : overdueDays >= 2 ? "dny" : "den"}
          </Badge>
        )}

        {/* Status badges */}
        {plan.status === "generated" && !isOverdue && (
          <Badge variant="outline" className="text-[10px] h-5 px-1.5 border-amber-500/50 text-amber-600">
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
          <Badge variant="outline" className="text-[10px] h-5 px-1.5 border-muted-foreground/30 text-muted-foreground">
            Přeskočeno
          </Badge>
        )}

        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={onToggleExpand} className="h-6 px-1.5 text-[0.625rem]">
            {isExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </Button>
        </div>
      </div>

      {/* ═══ ACTION BUTTONS ═══ */}
      <div className="flex flex-wrap items-center gap-1 mb-1.5">
        {plan.status === "generated" && !isArchived && (
          <>
            <Button variant="outline" size="sm" onClick={onStartSession} className="h-6 px-2 text-[10px] border-primary/40 text-primary hover:bg-primary/10">
              <Play className="mr-0.5 h-2.5 w-2.5" /> Zahájit
            </Button>
            <Button variant="outline" size="sm" onClick={onMarkDone} className="h-6 px-2 text-[10px] border-green-500/40 text-green-700 hover:bg-green-500/10">
              <CheckCircle2 className="mr-0.5 h-2.5 w-2.5" /> Splněno
            </Button>
          </>
        )}
        {plan.status === "in_progress" && !isArchived && (
          <>
            <Button variant="outline" size="sm" onClick={onOpenLive} className="h-6 px-2 text-[10px] border-primary/40 text-primary hover:bg-primary/10">
              <Play className="mr-0.5 h-2.5 w-2.5" /> Live
            </Button>
            <Button variant="outline" size="sm" onClick={onEndSession} className="h-6 px-2 text-[10px] border-green-500/40 text-green-700 hover:bg-green-500/10">
              <Square className="mr-0.5 h-2.5 w-2.5" /> Ukončit
            </Button>
          </>
        )}
        {plan.status === "done" && (
          <Button variant="ghost" size="sm" onClick={onRevert} className="h-6 px-2 text-[0.625rem] text-muted-foreground">
            ↩ Vrátit
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onRegenerate} className="h-6 px-2 text-[0.625rem] text-muted-foreground">
          <RefreshCw className="mr-0.5 h-2.5 w-2.5" /> Přegenerovat
        </Button>
        <Button variant="ghost" size="sm" onClick={onDelete} className="h-6 px-2 text-[0.625rem] text-destructive/70 hover:text-destructive">
          <Trash2 className="mr-0.5 h-2.5 w-2.5" /> Smazat
        </Button>
      </div>

      {/* ═══ EXPANDED CONTENT ═══ */}
      {isExpanded && (
        <div className="mt-2 space-y-3 max-h-[31.25rem] overflow-y-auto">
          <div className="rounded-md border border-border/60 bg-background/40 p-3 session-plan-content">
            <RichMarkdown compact>{plan.plan_markdown}</RichMarkdown>
          </div>

          {prevSession && (
            <div className="rounded-md border border-border/60 bg-background/40 p-3 space-y-2.5">
              <div className="flex items-center gap-1.5 text-[0.625rem] font-medium text-muted-foreground">
                <FileText className="w-3 h-3 text-primary" />
                Poslední sezení — {prevSession.therapist}, {prevSession.session_date}
              </div>

              {prevSession.handoff_note && prevSession.handoff_note.trim() && (
                <div className="rounded-md bg-primary/5 border border-primary/15 p-2.5">
                  <span className="text-[0.5625rem] font-medium text-primary flex items-center gap-1 mb-1">
                    <MessageSquare className="w-2.5 h-2.5" />
                    Předání pro kolegyni
                  </span>
                  <p className="text-[0.625rem] leading-4 text-foreground whitespace-pre-wrap">{prevSession.handoff_note}</p>
                </div>
              )}

              {prevSession.ai_analysis && prevSession.ai_analysis.trim() && (
                <div>
                  <span className="text-[0.5625rem] font-medium text-muted-foreground flex items-center gap-1 mb-1">
                    <Brain className="w-2.5 h-2.5" />
                    AI analýza sezení
                  </span>
                  <div className="text-[0.625rem] leading-4 text-muted-foreground">
                    <RichMarkdown compact>{prevSession.ai_analysis}</RichMarkdown>
                  </div>
                </div>
              )}

              {(() => {
                const notes = prevSession.karel_notes || "";
                const refIdx = notes.indexOf("## REFLEXE TERAPEUTKY");
                if (refIdx === -1) return null;
                const refText = notes.slice(refIdx + "## REFLEXE TERAPEUTKY".length).trim();
                if (!refText) return null;
                return (
                  <div className="rounded-md bg-amber-500/5 border border-amber-500/15 p-2.5">
                    <span className="text-[0.5625rem] font-medium text-amber-700 dark:text-amber-400 flex items-center gap-1 mb-1">
                      <PenLine className="w-2.5 h-2.5" />
                      Reflexe terapeutky
                    </span>
                    <p className="text-[0.625rem] leading-4 text-foreground whitespace-pre-wrap">{refText}</p>
                  </div>
                );
              })()}

              {!prevSession.handoff_note?.trim() && !prevSession.ai_analysis?.trim() && (
                <p className="text-[0.625rem] text-muted-foreground/60 italic">Bez detailů z minulého sezení.</p>
              )}
            </div>
          )}
        </div>
      )}

      {!isExpanded && (
        <p className="text-[0.625rem] text-muted-foreground line-clamp-1">
          {plan.plan_markdown.replace(/[#*\-]/g, '').slice(0, 100)}…
        </p>
      )}
    </div>
  );
};

export default DidDailySessionPlan;

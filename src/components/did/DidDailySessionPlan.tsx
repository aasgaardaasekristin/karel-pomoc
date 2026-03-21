import { useCallback, useEffect, useState, useRef } from "react";
import { Target, Loader2, Zap, CheckCircle2, Search, Brain, FileText, Send, UserRoundCog, ChevronDown, ChevronUp, PenLine, MessageSquare, Play, Square, Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";
import { getAuthHeaders } from "@/lib/auth";
import { toast } from "sonner";
import DidLiveSessionPanel from "./DidLiveSessionPanel";

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
};

const GENERATION_STEPS = [
  { key: "data", label: "Sběr dat z registru", icon: Search },
  { key: "scoring", label: "Výpočet naléhavosti", icon: Target },
  { key: "research", label: "Perplexity rešerše", icon: Brain },
  { key: "ai", label: "Generování plánu (AI)", icon: FileText },
  { key: "save", label: "Ukládání a distribuce", icon: Send },
];

/** Simple markdown → HTML for session plan rendering */
const renderMarkdown = (md: string): string => {
  return md
    .split('\n')
    .map(line => {
      // Headings
      if (line.startsWith('### ')) return `<h4 class="font-serif font-semibold text-xs mt-3 mb-1 text-foreground">${line.slice(4)}</h4>`;
      if (line.startsWith('## ')) return `<h3 class="font-serif font-semibold text-[13px] mt-4 mb-1.5 text-foreground">${line.slice(3)}</h3>`;
      // Horizontal rule
      if (line.trim() === '---') return '<hr class="my-2 border-border/40" />';
      // List items
      if (/^\s*[\*\-]\s/.test(line)) {
        const content = line.replace(/^\s*[\*\-]\s/, '');
        const formatted = content.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        return `<li class="ml-3 mb-0.5 list-disc list-inside">${formatted}</li>`;
      }
      // Bold in regular text
      const formatted = line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      if (line.trim() === '') return '<div class="h-1.5"></div>';
      return `<p class="mb-0.5">${formatted}</p>`;
    })
    .join('');
};

const DidDailySessionPlan = ({ refreshTrigger }: Props) => {
  const [plan, setPlan] = useState<SessionPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [genStep, setGenStep] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [registryParts, setRegistryParts] = useState<{ part_name: string; status: string }[]>([]);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [customPartName, setCustomPartName] = useState("");
  const [prevSession, setPrevSession] = useState<PreviousSession | null>(null);
  const [_prevSessionExpanded, _setPrevSessionExpanded] = useState(false); // kept for hook order

  // Preference dialog state
  const [prefDialogOpen, setPrefDialogOpen] = useState(false);
  const [prefSelectedPart, setPrefSelectedPart] = useState("");
  const [prefStep, setPrefStep] = useState<"ask" | "detail">("ask");
  const [prefDetail, setPrefDetail] = useState("");

  // Live session state
  const [liveSessionActive, setLiveSessionActive] = useState(false);

  const loadTodayPlan = useCallback(async () => {
    setLoading(true);
    try {
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague" }).format(new Date());
      const { data, error } = await (supabase as any)
        .from("did_daily_session_plans")
        .select("*")
        .eq("plan_date", today)
        .maybeSingle();
      if (error) throw error;
      setPlan(data || null);
    } catch (e) {
      console.error("Failed to load session plan:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadTodayPlan(); }, [loadTodayPlan, refreshTrigger]);

  // Load previous session for current plan's part
  useEffect(() => {
    if (!plan?.selected_part) { setPrevSession(null); return; }
    const loadPrev = async () => {
      // Load last session from the OTHER therapist for handoff context
      const currentTherapist = (plan.therapist || "hanka").toLowerCase();
      // Filter out both case variants of current therapist
      let query = supabase
        .from("did_part_sessions")
        .select("therapist, session_date, ai_analysis, handoff_note")
        .eq("part_name", plan.selected_part)
        .order("created_at", { ascending: false })
        .limit(10);
      const { data: rows } = await query;
      // Find first session by the OTHER therapist
      const other = (rows || []).find(r =>
        r.therapist?.toLowerCase() !== currentTherapist
      );
      setPrevSession((other as PreviousSession) || null);
    };
    loadPrev();
  }, [plan?.selected_part, plan?.therapist]);

  const loadRegistryParts = useCallback(async () => {
    const { data } = await supabase
      .from("did_part_registry")
      .select("part_name, status")
      .in("status", ["active", "sleeping"])
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
        toast.info("Plán na dnes už existuje");
      } else {
        toast.success(`Plán vygenerován pro ${data.selectedPart} (naléhavost ${data.urgencyScore})`);
      }
      await loadTodayPlan();
    } catch (e: any) {
      clearInterval(stepTimer);
      toast.error(e.message || "Generování plánu selhalo");
    } finally {
      setGenerating(false);
      setGenStep(0);
    }
  }, [loadTodayPlan]);

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

  // ═══ SESSION START: create did_part_sessions + update registry ═══
  const startSession = useCallback(async () => {
    if (!plan) return;
    try {
      // 1) Create session record in did_part_sessions
      const { error: sessErr } = await supabase
        .from("did_part_sessions")
        .insert({
          part_name: plan.selected_part,
          therapist: plan.therapist || "hanka",
          session_type: "planned",
          session_date: plan.plan_date,
          karel_notes: `Plán sezení (urgency ${plan.urgency_score}):\n${plan.plan_markdown.slice(0, 2000)}`,
        });
      if (sessErr) console.error("Failed to insert session:", sessErr);

      // 2) Update registry last_seen_at for the part
      await supabase
        .from("did_part_registry")
        .update({ last_seen_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .ilike("part_name", plan.selected_part);

      // 3) Update plan status
      await (supabase as any)
        .from("did_daily_session_plans")
        .update({ status: "in_progress", updated_at: new Date().toISOString() })
        .eq("id", plan.id);

      setPlan(prev => prev ? { ...prev, status: "in_progress" } : null);
      setLiveSessionActive(true);
      toast.success(`Sezení s ${plan.selected_part} zahájeno — Karel je připraven asistovat`);
    } catch (e: any) {
      toast.error("Nepodařilo se zahájit sezení");
      console.error(e);
    }
  }, [plan]);

  // ═══ SESSION END: finalize session, queue Drive write, update registry ═══
  const endSession = useCallback(async () => {
    if (!plan) return;
    try {
      // 1) Find today's session record and update it
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

      // 2) Queue Drive write — intervention record to 06_INTERVENCE
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague" }).format(new Date());
      const driveContent = `## Záznam sezení — ${today}\n**Část:** ${plan.selected_part}\n**Naléhavost:** ${plan.urgency_score}\n**Terapeutka:** ${plan.therapist}\n\n### Plán sezení\n${plan.plan_markdown}\n\n---\n*Záznam vytvořen automaticky při ukončení sezení.*`;

      await supabase
        .from("did_pending_drive_writes")
        .insert({
          target_document: `06_INTERVENCE/${today}_${plan.selected_part}`,
          content: driveContent,
          write_type: "create",
          priority: "high",
        });

      // 3) Update plan status
      await (supabase as any)
        .from("did_daily_session_plans")
        .update({ status: "done", updated_at: new Date().toISOString() })
        .eq("id", plan.id);

      setPlan(prev => prev ? { ...prev, status: "done" } : null);
      toast.success(`Sezení s ${plan.selected_part} ukončeno — záznam odeslán na Drive`);
    } catch (e: any) {
      toast.error("Nepodařilo se ukončit sezení");
      console.error(e);
    }
  }, [plan]);

  // ═══ REVERT STATUS ═══
  const revertStatus = useCallback(async () => {
    if (!plan) return;
    try {
      await (supabase as any)
        .from("did_daily_session_plans")
        .update({ status: "generated", updated_at: new Date().toISOString() })
        .eq("id", plan.id);
      setPlan(prev => prev ? { ...prev, status: "generated" } : null);
      setLiveSessionActive(false);
      toast.success("Stav vrácen na Naplánováno");
    } catch (e: any) {
      toast.error("Nepodařilo se změnit stav");
    }
  }, [plan]);

  // ═══ LIVE SESSION END HANDLER ═══
  const handleLiveSessionEnd = useCallback(async (summary: string) => {
    setLiveSessionActive(false);
    if (!plan) return;

    // Save AI analysis to session record
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

    // Run existing endSession logic (Drive write + status update)
    await endSession();
  }, [plan, endSession]);

  if (loading) {
    return (
      <div className="mb-4 rounded-lg border border-border/70 bg-card/38 p-3 backdrop-blur-sm">
        <div className="flex items-center text-xs text-muted-foreground">
          <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> Načítám plán sezení...
        </div>
      </div>
    );
  }

  // ═══ LIVE SESSION ACTIVE → show DidLiveSessionPanel ═══
  if (liveSessionActive && plan) {
    return (
      <div className="mb-4 rounded-lg border border-border/70 bg-card/38 backdrop-blur-sm overflow-hidden" style={{ minHeight: "60vh" }}>
        <DidLiveSessionPanel
          partName={plan.selected_part}
          therapistName={plan.therapist === "kata" || plan.therapist === "Káťa" ? "Káťa" : "Hanka"}
          contextBrief={plan.plan_markdown}
          onEnd={handleLiveSessionEnd}
          onBack={() => setLiveSessionActive(false)}
        />
      </div>
    );
  }

  return (
    <>
      <div className="mb-4 rounded-lg border border-border/70 bg-card/38 p-3 backdrop-blur-sm sm:p-4">
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-xs font-medium text-foreground flex items-center gap-1.5">
            <Target className="w-3.5 h-3.5 text-primary" />
            Plán sezení na dnes
          </h4>
          <div className="flex items-center gap-1.5">
            {!generating && (
              <>
                {!plan && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => generatePlan()}
                    className="h-7 px-2 text-[10px]"
                  >
                    <Zap className="mr-1 h-3 w-3" /> Vygenerovat
                  </Button>
                )}
                <Popover open={overrideOpen} onOpenChange={(open) => { setOverrideOpen(open); if (!open) setCustomPartName(""); }}>
                  <PopoverTrigger asChild>
                    <Button variant="outline" size="sm" className="h-7 px-2 text-[10px]">
                      <UserRoundCog className="mr-1 h-3 w-3" />
                      {plan ? "Přegenerovat" : "Určit část"}
                      <ChevronDown className="ml-0.5 h-2.5 w-2.5" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-52 p-1.5" align="end">
                    <p className="text-[10px] text-muted-foreground px-2 py-1 mb-1">
                      {plan ? "Nahradí stávající plán:" : "Přepsat automatický výběr:"}
                    </p>
                    <div className="max-h-48 overflow-y-auto space-y-0.5 mb-2">
                      {registryParts.map((p) => (
                        <button
                          key={p.part_name}
                          onClick={() => handlePartSelected(p.part_name)}
                          className="w-full flex items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] hover:bg-accent transition-colors"
                        >
                          <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${
                            p.status === "active" ? "bg-green-500" : "bg-muted-foreground/40"
                          }`} />
                          {p.part_name}
                          <span className="text-[9px] text-muted-foreground ml-auto">
                            {p.status === "active" ? "aktivní" : "spící"}
                          </span>
                        </button>
                      ))}
                      {registryParts.length === 0 && (
                        <p className="text-[10px] text-muted-foreground px-2 py-1">Žádné části v registru</p>
                      )}
                    </div>
                    <div className="border-t border-border/60 pt-2 px-1">
                      <p className="text-[9px] text-muted-foreground mb-1 flex items-center gap-1">
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
                          className="h-7 px-2 text-[10px]"
                          disabled={!customPartName.trim()}
                        >
                          <Zap className="h-3 w-3" />
                        </Button>
                      </form>
                    </div>
                  </PopoverContent>
                </Popover>
                {plan && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setExpanded(!expanded)}
                    className="h-7 px-2 text-[10px]"
                  >
                    {expanded ? "Sbalit" : "Rozbalit"}
                  </Button>
                )}
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
                    className={`flex items-center gap-2 text-[10px] transition-all duration-300 ${
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

        {!plan && !generating && (
          <p className="text-[11px] text-muted-foreground">
            Automatický plán se generuje ve 13:50. Můžeš ho vygenerovat i ručně.
          </p>
        )}

        {plan && (
          <div>
            <div className="flex flex-wrap items-center gap-1.5 mb-2">
              <Badge variant="secondary" className="text-[11px] h-5 px-2 font-semibold">
                {plan.selected_part}
              </Badge>
              <span className={`h-2 w-2 rounded-full shrink-0 ${
                plan.urgency_score >= 70 ? "bg-destructive" : plan.urgency_score >= 40 ? "bg-amber-500" : "bg-primary"
              }`} title={`Naléhavost: ${plan.urgency_score}`} />

              {plan.status === "generated" && (
                <Badge variant="outline" className="text-[11px] h-5 px-2 border-amber-500/50 text-amber-600">
                  <Clock className="mr-1 h-3 w-3" /> Naplánováno
                </Badge>
              )}
              {plan.status === "in_progress" && (
                <Badge className="text-[11px] h-5 px-2 bg-primary/20 text-primary border border-primary/30">
                  <Play className="mr-1 h-3 w-3" /> Probíhá
                </Badge>
              )}
              {plan.status === "done" && (
                <Badge className="text-[11px] h-5 px-2 bg-green-500/20 text-green-700 border border-green-500/30">
                  <CheckCircle2 className="mr-1 h-3 w-3" /> Dokončeno
                </Badge>
              )}
            </div>

            {/* ═══ LIFECYCLE BUTTONS ═══ */}
            <div className="flex flex-wrap items-center gap-1.5 mb-2">
              {plan.status === "generated" && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={startSession}
                  className="h-7 px-2.5 text-[11px] border-primary/40 text-primary hover:bg-primary/10"
                >
                  <Play className="mr-1 h-3 w-3" /> Zahájit sezení
                </Button>
              )}
              {plan.status === "in_progress" && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setLiveSessionActive(true)}
                  className="h-7 px-2.5 text-[11px] border-primary/40 text-primary hover:bg-primary/10"
                >
                  <Play className="mr-1 h-3 w-3" /> Otevřít live asistenci
                </Button>
              )}
              {plan.status === "in_progress" && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={endSession}
                  className="h-7 px-2.5 text-[11px] border-green-500/40 text-green-700 hover:bg-green-500/10"
                >
                  <Square className="mr-1 h-3 w-3" /> Ukončit sezení
                </Button>
              )}
              {plan.status === "done" && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={revertStatus}
                  className="h-7 px-2.5 text-[11px] text-muted-foreground"
                >
                  ↩ Vrátit
                </Button>
              )}
            </div>

            {expanded && (
              <div className="mt-2 space-y-3 max-h-[500px] overflow-y-auto">
                {/* Session plan */}
                <div className="rounded-md border border-border/60 bg-background/40 p-3 session-plan-content">
                  <div
                    className="text-[11px] leading-5 text-foreground"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(plan.plan_markdown) }}
                  />
                </div>

                {/* Previous session: handoff + AI analysis inline */}
                {prevSession && (
                  <div className="rounded-md border border-border/60 bg-background/40 p-3 space-y-2.5">
                    <div className="flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground">
                      <FileText className="w-3 h-3 text-primary" />
                      Poslední sezení — {prevSession.therapist}, {prevSession.session_date}
                    </div>

                    {prevSession.handoff_note && prevSession.handoff_note.trim() && (
                      <div className="rounded-md bg-primary/5 border border-primary/15 p-2.5">
                        <span className="text-[9px] font-medium text-primary flex items-center gap-1 mb-1">
                          <MessageSquare className="w-2.5 h-2.5" />
                          Předání pro kolegyni
                        </span>
                        <p className="text-[10px] leading-4 text-foreground whitespace-pre-wrap">{prevSession.handoff_note}</p>
                      </div>
                    )}

                    {prevSession.ai_analysis && prevSession.ai_analysis.trim() && (
                      <div>
                        <span className="text-[9px] font-medium text-muted-foreground flex items-center gap-1 mb-1">
                          <Brain className="w-2.5 h-2.5" />
                          AI analýza sezení
                        </span>
                        <div
                          className="text-[10px] leading-4 text-muted-foreground"
                          dangerouslySetInnerHTML={{ __html: renderMarkdown(prevSession.ai_analysis) }}
                        />
                      </div>
                    )}

                    {!prevSession.handoff_note?.trim() && !prevSession.ai_analysis?.trim() && (
                      <p className="text-[10px] text-muted-foreground/60 italic">Bez detailů z minulého sezení.</p>
                    )}
                  </div>
                )}
              </div>
            )}

            {!expanded && (
              <p className="text-[11px] text-muted-foreground line-clamp-2">
              {plan.plan_markdown.replace(/[#*\-]/g, '').slice(0, 150)}…
              </p>
            )}
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
                Popiš situaci, téma nebo kontext, který chceš do plánu sezení s <strong>{prefSelectedPart}</strong> zahrnout:
              </p>
              <Textarea
                value={prefDetail}
                onChange={(e) => setPrefDetail(e.target.value)}
                placeholder={`Např.: Dnes ráno ${prefSelectedPart} plakal/a ze spaní, budila jsem ho/ji, ale nemohl/a se probudit. Celé dopoledne byl/a plačtivý/á a velmi skleslý/á…`}
                className="min-h-[120px] text-sm resize-none"
              />
              <p className="text-[10px] text-muted-foreground">
                Karel tyto informace zakomponuje jako prioritní vstup do plánu sezení. Pokud nic nenapíšeš, Karel se zařídí podle standardního programu.
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

export default DidDailySessionPlan;

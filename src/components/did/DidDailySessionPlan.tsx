import { useCallback, useEffect, useState, useRef } from "react";
import { Target, Loader2, Zap, CheckCircle2, Search, Brain, FileText, Send, UserRoundCog, ChevronDown, PenLine } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { supabase } from "@/integrations/supabase/client";
import { getAuthHeaders } from "@/lib/auth";
import { toast } from "sonner";

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

const DidDailySessionPlan = ({ refreshTrigger }: Props) => {
  const [plan, setPlan] = useState<SessionPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [genStep, setGenStep] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [registryParts, setRegistryParts] = useState<{ part_name: string; status: string }[]>([]);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [customPartName, setCustomPartName] = useState("");

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

  const loadRegistryParts = useCallback(async () => {
    const { data } = await supabase
      .from("did_part_registry")
      .select("part_name, status")
      .in("status", ["active", "sleeping"])
      .order("part_name");
    setRegistryParts(data || []);
  }, []);

  useEffect(() => { loadRegistryParts(); }, [loadRegistryParts]);

  const generatePlan = useCallback(async (forcePart?: string) => {
    setGenerating(true);
    setGenStep(0);

    // Simulate step progression while waiting for the actual call
    const stepTimer = setInterval(() => {
      setGenStep(prev => {
        if (prev < GENERATION_STEPS.length - 1) return prev + 1;
        return prev;
      });
    }, 4500); // ~4.5s per step, total ~22s for 5 steps

    try {
      const headers = await getAuthHeaders();
      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-auto-session-plan`,
        { method: "POST", headers, body: JSON.stringify(forcePart ? { forcePart } : {}) }
      );
      const data = await resp.json();
      clearInterval(stepTimer);
      setGenStep(GENERATION_STEPS.length); // done

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

  if (loading) {
    return (
      <div className="mb-4 rounded-lg border border-border/70 bg-card/38 p-3 backdrop-blur-sm">
        <div className="flex items-center text-xs text-muted-foreground">
          <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> Načítám plán sezení...
        </div>
      </div>
    );
  }

  return (
    <div className="mb-4 rounded-lg border border-border/70 bg-card/38 p-3 backdrop-blur-sm sm:p-4">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-xs font-medium text-foreground flex items-center gap-1.5">
          <Target className="w-3.5 h-3.5 text-primary" />
          Plán sezení na dnes
        </h4>
        <div className="flex items-center gap-1.5">
          {!plan && !generating && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => generatePlan()}
                className="h-7 px-2 text-[10px]"
              >
                <Zap className="mr-1 h-3 w-3" /> Vygenerovat
              </Button>
              <Popover open={overrideOpen} onOpenChange={setOverrideOpen}>
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
                <PopoverContent className="w-48 p-1.5" align="end">
                  <p className="text-[10px] text-muted-foreground px-2 py-1 mb-1">
                    Přepsat automatický výběr:
                  </p>
                  <div className="max-h-48 overflow-y-auto space-y-0.5">
                    {registryParts.map((p) => (
                      <button
                        key={p.part_name}
                        onClick={() => {
                          setOverrideOpen(false);
                          generatePlan(p.part_name);
                        }}
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
                </PopoverContent>
              </Popover>
            </>
          )}
          {plan && (
            <>
              <Popover open={overrideOpen} onOpenChange={setOverrideOpen}>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="h-7 px-2 text-[10px]">
                    <UserRoundCog className="mr-1 h-3 w-3" />
                    Přegenerovat
                    <ChevronDown className="ml-0.5 h-2.5 w-2.5" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-48 p-1.5" align="end">
                  <p className="text-[10px] text-muted-foreground px-2 py-1 mb-1">
                    Vyber část (nahradí stávající plán):
                  </p>
                  <div className="max-h-48 overflow-y-auto space-y-0.5">
                    {registryParts.map((p) => (
                      <button
                        key={p.part_name}
                        onClick={() => {
                          setOverrideOpen(false);
                          generatePlan(p.part_name);
                        }}
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
                  </div>
                </PopoverContent>
              </Popover>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setExpanded(!expanded)}
                className="h-7 px-2 text-[10px]"
              >
                {expanded ? "Sbalit" : "Rozbalit"}
              </Button>
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
            <Badge variant="secondary" className="text-[10px] h-5 px-1.5 font-semibold">
              {plan.selected_part}
            </Badge>
            <Badge variant="outline" className="text-[10px] h-5 px-1.5">
              Naléhavost: {plan.urgency_score}
            </Badge>
            {Object.entries(plan.urgency_breakdown || {}).map(([key, val]) => (
              <Badge key={key} variant="outline" className="text-[9px] h-4 px-1">
                {urgencyLabels[key] || key} +{val as number}
              </Badge>
            ))}
          </div>

          <div className="flex gap-1.5 mb-2">
            {plan.distributed_drive && (
              <Badge variant="secondary" className="text-[8px] h-4 px-1">✓ Drive</Badge>
            )}
            {plan.distributed_email && (
              <Badge variant="secondary" className="text-[8px] h-4 px-1">✓ Email</Badge>
            )}
          </div>

          {expanded && (
            <div className="mt-2 rounded-md border border-border/60 bg-background/40 p-3 max-h-[400px] overflow-y-auto">
              <p className="whitespace-pre-line text-[11px] leading-5 text-foreground">
                {plan.plan_markdown}
              </p>
            </div>
          )}

          {!expanded && (
            <p className="text-[11px] text-muted-foreground line-clamp-2">
              {plan.plan_markdown.slice(0, 150)}...
            </p>
          )}
        </div>
      )}
    </div>
  );
};

export default DidDailySessionPlan;

import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Loader2,
  BookOpen,
  RefreshCw,
  CheckCircle2,
  Trash2,
  FileDown,
  Play,
  Pencil,
} from "lucide-react";
// re-opened below
  Bot,
  RotateCcw,
} from "lucide-react";
import { getAuthHeaders } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { blobToBase64 } from "@/lib/driveUtils";
import jsPDF from "jspdf";
import html2canvas from "html2canvas";

interface ClientSessionPrepPanelProps {
  clientId: string;
  clientName: string;
  sessions?: any[];
  onPlanApproved?: (plan: any) => void;
  onPlanDeleted?: () => void;
  onStartSession?: (plan: any) => void;
}

type PrepState = "idle" | "generating" | "review" | "approved";

const SPINNER_CHARS = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

const PROGRESS_MESSAGES = [
  { until: 4000, text: "Čtu kartu klienta..." },
  { until: 10000, text: "Analyzuju předchozí sezení..." },
  { until: 20000, text: "Konzultuji odborné zdroje..." },
  { until: Infinity, text: "Sestavuju plán sezení..." },
];

const phaseColors: Record<string, string> = {
  "Zahájení": "bg-blue-500/10 border-blue-500/20",
  "Hlavní téma": "bg-orange-500/10 border-orange-500/20",
  "Aktivita": "bg-green-500/10 border-green-500/20",
  "Zpracování": "bg-purple-500/10 border-purple-500/20",
  "Uzavření": "bg-muted/30 border-border",
};

type SavedPrep = {
  id: string;
  session_number: number | null;
  created_at: string;
  plan: any;
  approved_at: string | null;
};

const ClientSessionPrepPanel = ({
  clientId,
  clientName,
  sessions,
  onPlanApproved,
  onPlanDeleted,
  onStartSession,
}: ClientSessionPrepPanelProps) => {
  const [prepState, setPrepState] = useState<PrepState>("idle");
  const [prepMode, setPrepMode] = useState<"auto" | "custom" | null>(null);
  const [customRequest, setCustomRequest] = useState("");
  const [modificationNote, setModificationNote] = useState("");
  const [plan, setPlan] = useState<any>(null);
  const [sessionNumber, setSessionNumber] = useState<number | null>(null);
  const [approvedAt, setApprovedAt] = useState<string | null>(null);
  const originalRequestRef = useRef<any>(null);

  // Saved preparations
  const [savedPreps, setSavedPreps] = useState<SavedPrep[]>([]);
  const [loadingPreps, setLoadingPreps] = useState(false);

  useEffect(() => {
    const fetchPreps = async () => {
      setLoadingPreps(true);
      const { data } = await supabase
        .from("session_preparations" as any)
        .select("id, session_number, created_at, plan, approved_at")
        .eq("client_id", clientId)
        .order("created_at", { ascending: false });
      if (data) setSavedPreps(data as any);
      setLoadingPreps(false);
    };
    fetchPreps();
  }, [clientId]);

  // Progress animation
  const [spinnerChar, setSpinnerChar] = useState(SPINNER_CHARS[0]);
  const [progressText, setProgressText] = useState("");
  const [progressValue, setProgressValue] = useState(0);
  const startTimeRef = useRef<number>(0);

  useEffect(() => {
    if (prepState !== "generating") return;

    const spinnerInterval = setInterval(() => {
      setSpinnerChar((prev) => {
        const idx = SPINNER_CHARS.indexOf(prev);
        return SPINNER_CHARS[(idx + 1) % SPINNER_CHARS.length];
      });
    }, 100);

    const progressInterval = setInterval(() => {
      const elapsed = Date.now() - startTimeRef.current;
      const msg = PROGRESS_MESSAGES.find((m) => elapsed < m.until);
      setProgressText(msg?.text || "Sestavuju plán sezení...");
      setProgressValue(Math.min(95, (elapsed / 30000) * 100));
    }, 1000);

    return () => {
      clearInterval(spinnerInterval);
      clearInterval(progressInterval);
    };
  }, [prepState]);

  const handleGenerate = async (modifications?: string) => {
    setPrepState("generating");
    setModificationNote("");
    startTimeRef.current = Date.now();
    setProgressValue(0);
    setProgressText(PROGRESS_MESSAGES[0].text);

    try {
      const headers = await getAuthHeaders();
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-session-plan`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            clientId,
            customRequest: originalRequestRef.current?.customRequest || undefined,
            modificationsRequested: modifications || undefined,
          }),
        }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Chyba ${res.status}`);
      }
      const data = await res.json();
      setPlan(data.plan);
      setSessionNumber(data.sessionNumber);
      setPrepState("review");
    } catch (e: any) {
      toast.error(e.message || "Chyba při generování plánu");
      setPrepState("idle");
    }
  };

  const handleApprove = async () => {
    setPrepState("approved");
    const now = new Date().toISOString();
    setApprovedAt(now);
    onPlanApproved?.(plan);

    // Persist to DB
    try {
      const { data: inserted } = await supabase.from("session_preparations" as any).insert({
        client_id: clientId,
        session_number: sessionNumber,
        plan,
        approved_at: now,
      }).select("id, session_number, created_at, plan, approved_at").single();
      if (inserted) setSavedPreps(prev => [inserted as any, ...prev]);
    } catch (e) {
      console.warn("Failed to persist preparation:", e);
    }

    // Fire-and-forget: backup plan PDF to Drive
    try {
      const el = document.getElementById("session-plan-printable");
      if (el) {
        const canvas = await html2canvas(el, { scale: 2 });
        const pdf = new jsPDF("p", "mm", "a4");
        const w = pdf.internal.pageSize.getWidth();
        const h = (canvas.height * w) / canvas.width;
        pdf.addImage(canvas.toDataURL("image/png"), "PNG", 0, 0, w, h);
        const blob = new Blob([pdf.output("arraybuffer")], { type: "application/pdf" });
        const base64 = await blobToBase64(blob);
        const today = new Date().toISOString().split("T")[0];
        const nextNum = sessionNumber ?? (sessions?.length ? sessions.length + 1 : 1);
        supabase.functions.invoke("karel-session-drive-backup", {
          body: {
            pdfBase64: base64,
            fileName: `Plan_${nextNum}_${clientId}_${today}.pdf`,
            clientId,
            folder: "Plany",
          },
        });
      }
    } catch (e) {
      console.warn("Plan backup failed:", e);
    }
  };

  const handleDeletePrep = async (prepId: string) => {
    if (!window.confirm("Smazat tuto přípravu?")) return;
    await supabase.from("session_preparations" as any).delete().eq("id", prepId);
    setSavedPreps(prev => prev.filter(p => p.id !== prepId));
    toast.success("Příprava smazána");
  };

  const handleLoadPrep = (prep: SavedPrep) => {
    setPlan(prep.plan);
    setSessionNumber(prep.session_number);
    setPrepState("review");
    toast.success("Příprava načtena");
  };

  const handleDelete = () => {
    if (window.confirm("Smazat schválený plán?")) {
      setPlan(null);
      setPrepState("idle");
      setApprovedAt(null);
      setPrepMode(null);
      onPlanDeleted?.();
    }
  };

  const handleRework = () => {
    handleGenerate(modificationNote);
  };

  const handleExportPdf = async () => {
    const el = document.getElementById("session-plan-printable");
    if (!el) return;
    try {
      const canvas = await html2canvas(el, { scale: 2 });
      const pdf = new jsPDF("p", "mm", "a4");
      const w = pdf.internal.pageSize.getWidth();
      const h = (canvas.height * w) / canvas.width;
      pdf.addImage(canvas.toDataURL("image/png"), "PNG", 0, 0, w, h);
      const date = new Date().toISOString().split("T")[0];
      pdf.save(`Plan_sezeni_${sessionNumber}_${clientName}_${date}.pdf`);
      toast.success("PDF exportováno");
    } catch {
      toast.error("Chyba při exportu PDF");
    }
  };

  const nextSessionNum = sessionNumber ?? (sessions?.length ? sessions.length + 1 : 1);

  // ─── IDLE ───
  if (prepState === "idle") {
    return (
      <ScrollArea className="flex-1">
        <div className="max-w-2xl mx-auto px-4 py-6 space-y-5">
          <div className="text-center space-y-2">
            <h3 className="text-lg font-serif font-semibold">
              Připravit sezení č. {nextSessionNum} – {clientName}
            </h3>
          </div>

          {/* Mód A */}
          <div className="bg-card border border-border rounded-xl p-5 space-y-3">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                <Bot className="w-5 h-5 text-primary" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-semibold">Karel připraví sám</p>
                <p className="text-xs text-muted-foreground">
                  Prostuduje kartu, sezení, úkoly a internet
                </p>
              </div>
            </div>
            <Button
              className="w-full h-11 gap-2"
              onClick={() => {
                originalRequestRef.current = { clientId, mode: "auto" };
                setPrepMode("auto");
                handleGenerate();
              }}
            >
              <BookOpen className="w-4 h-4" />
              Spustit
            </Button>
          </div>

          {/* Mód B */}
          <div className="bg-card border border-border rounded-xl p-5 space-y-3">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-accent/50 flex items-center justify-center shrink-0">
                <Pencil className="w-5 h-5 text-foreground" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-semibold">Zadám vlastní požadavek</p>
                <p className="text-xs text-muted-foreground">
                  Specifikuj zaměření, metody nebo kontext
                </p>
              </div>
            </div>
            <Textarea
              value={customRequest}
              onChange={(e) => setCustomRequest(e.target.value)}
              placeholder="Např. včera se pohádal s manželkou, zapracovat do sezení. Metody 1 a 3 fungovaly dobře…"
              className="min-h-[80px] text-sm"
            />
            <Button
              className="w-full h-11 gap-2"
              disabled={!customRequest.trim()}
              onClick={() => {
                originalRequestRef.current = {
                  clientId,
                  mode: "custom",
                  customRequest: customRequest.trim(),
                };
                setPrepMode("custom");
                handleGenerate();
              }}
            >
              <BookOpen className="w-4 h-4" />
              Vygenerovat
            </Button>
          </div>

          {/* Saved preparations */}
          {savedPreps.length > 0 && (
            <div className="bg-card border border-border rounded-xl p-5 space-y-3">
              <p className="text-sm font-semibold">Uložené přípravy</p>
              <div className="space-y-2">
                {savedPreps.map((prep) => (
                  <div key={prep.id} className="flex items-center gap-2 p-2.5 bg-secondary/30 rounded-lg">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">
                        Příprava na sezení č. {prep.session_number ?? "?"} – {new Date(prep.created_at).toLocaleDateString("cs-CZ")}
                      </p>
                    </div>
                    <Button variant="outline" size="sm" className="h-7 text-xs gap-1 shrink-0" onClick={() => handleLoadPrep(prep)}>
                      <RotateCcw className="w-3 h-3" />
                      Použít
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => handleDeletePrep(prep.id)}>
                      <Trash2 className="w-3.5 h-3.5 text-destructive" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </ScrollArea>
    );
  }

  // ─── GENERATING ───
  if (prepState === "generating") {
    return (
      <div className="flex flex-col items-center justify-center py-20 space-y-6">
        <div className="text-4xl font-mono text-primary">{spinnerChar}</div>
        <p className="text-sm text-muted-foreground">{progressText}</p>
        <Progress value={progressValue} className="w-64 h-2" />
      </div>
    );
  }

  // ─── PLAN DISPLAY (shared between review & approved) ───
  const isApproved = prepState === "approved";

  return (
    <div className="flex flex-col h-[calc(100vh-200px)]">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          {isApproved ? (
            <CheckCircle2 className="w-4 h-4 text-primary" />
          ) : (
            <Loader2 className="w-4 h-4 text-primary" />
          )}
          <span className="text-sm font-medium">
            {isApproved
              ? `✅ Plán sezení č. ${sessionNumber} – schváleno ${approvedAt ? new Date(approvedAt).toLocaleDateString("cs-CZ") : ""}`
              : `Návrh sezení č. ${sessionNumber} – ke schválení`}
          </span>
        </div>
        {isApproved && (
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleDelete}>
            <Trash2 className="w-4 h-4 text-destructive" />
          </Button>
        )}
      </div>

      {/* Content */}
      <ScrollArea className="flex-1 px-4 py-4">
        <div className="max-w-2xl mx-auto space-y-4">
          <div id="session-plan-printable" className="space-y-4">
            {/* Session Goal */}
            {plan?.sessionGoal && (
              <div className="bg-primary/5 border border-primary/20 rounded-xl p-4">
                <p className="text-xs text-muted-foreground mb-1">Cíl sezení</p>
                <p className="text-sm font-semibold">{plan.sessionGoal}</p>
              </div>
            )}

            {/* Phases */}
            {(plan?.phases || []).map((phase: any, i: number) => (
              <div
                key={i}
                className={`rounded-xl border p-4 space-y-2.5 ${phaseColors[phase.name] || "bg-muted/20 border-border"}`}
              >
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-[10px] tabular-nums shrink-0">
                    ⏱ {phase.timeStart}–{phase.timeEnd}
                  </Badge>
                  <span className="text-sm font-semibold">{phase.name}</span>
                </div>

                {phase.technique && (
                  <p className="text-xs text-muted-foreground">
                    Technika: <span className="text-foreground">{phase.technique}</span>
                  </p>
                )}

                {(phase.howToStart || phase.clientInstruction || phase.closingPhrase) && (
                  <div className="bg-background/60 rounded-lg p-3">
                    <p className="text-xs text-muted-foreground mb-0.5">Řekni:</p>
                    <p className="text-sm italic">
                      "{phase.howToStart || phase.clientInstruction || phase.closingPhrase}"
                    </p>
                  </div>
                )}

                {phase.procedure?.length > 0 && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-0.5">Postup:</p>
                    {phase.procedure.map((s: string, j: number) => (
                      <p key={j} className="text-xs">
                        {j + 1}. {s}
                      </p>
                    ))}
                  </div>
                )}

                {phase.supplies?.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    <span className="text-xs text-muted-foreground">Pomůcky:</span>
                    {phase.supplies.map((s: string, j: number) => (
                      <Badge key={j} variant="outline" className="text-[10px]">
                        {s}
                      </Badge>
                    ))}
                  </div>
                )}

                {phase.watchFor?.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    👀 Všímej si: {phase.watchFor.join(", ")}
                  </p>
                )}

                {phase.fallback && (
                  <p className="text-xs text-muted-foreground">
                    🔄 Fallback: {phase.fallback}
                  </p>
                )}

                {phase.questions?.length > 0 && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-0.5">Otázky:</p>
                    {phase.questions.map((q: string, j: number) => (
                      <p key={j} className="text-xs">
                        ❓ {q}
                      </p>
                    ))}
                  </div>
                )}

                {phase.homeworkForClient && (
                  <p className="text-xs">📝 Domácí úkol: {phase.homeworkForClient}</p>
                )}
              </div>
            ))}

            {/* Why this plan */}
            {plan?.whyThisPlan && (
              <details className="bg-muted/20 rounded-xl border border-border">
                <summary className="px-4 py-3 text-xs font-medium cursor-pointer text-muted-foreground hover:text-foreground transition-colors">
                  Proč tento plán?
                </summary>
                <div className="px-4 pb-3">
                  <p className="text-sm">{plan.whyThisPlan}</p>
                </div>
              </details>
            )}
          </div>

          {/* Review controls */}
          {!isApproved && (
            <div className="space-y-3 pt-2">
              <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground">
                  Máš připomínky nebo požadavky na změnu?
                </p>
                <Textarea
                  value={modificationNote}
                  onChange={(e) => setModificationNote(e.target.value)}
                  placeholder="Metodu 2 změň na… / Aktivitu zkrať…"
                  className="min-h-[60px] text-sm"
                />
              </div>
              <div className="flex gap-2 flex-wrap">
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={handleRework}
                  disabled={!modificationNote.trim()}
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Přepracovat
                </Button>
                <Button variant="outline" size="sm" className="gap-1.5" onClick={handleExportPdf}>
                  <FileDown className="w-3.5 h-3.5" />
                  Export PDF
                </Button>
                <Button size="sm" className="gap-1.5 ml-auto" onClick={handleApprove}>
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  Schválit
                </Button>
              </div>
            </div>
          )}

          {/* Approved controls */}
          {isApproved && (
            <div className="flex gap-2 flex-wrap pt-2">
              <Button variant="outline" size="sm" className="gap-1.5" onClick={handleExportPdf}>
                <FileDown className="w-3.5 h-3.5" />
                Export PDF
              </Button>
              {onStartSession && (
                <Button size="sm" className="gap-1.5 ml-auto" onClick={() => onStartSession(plan)}>
                  <Play className="w-3.5 h-3.5" />
                  Zahájit asistenci
                </Button>
              )}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
};

export default ClientSessionPrepPanel;

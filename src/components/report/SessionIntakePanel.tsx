import { useState, useCallback, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Mic, Keyboard, Send, Square, Pause, Play, RefreshCw, Save, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { getAuthHeaders } from "@/lib/auth";
import { toast } from "sonner";
import { useSessionAudioRecorder } from "@/hooks/useSessionAudioRecorder";
import ReactMarkdown from "react-markdown";

const formatDuration = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
};

const SPINNER_CHARS = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

const formatBirps = (raw: string): string => {
  if (!raw || raw === "—") return raw;
  if (raw.includes("## B")) return raw;
  let text = raw.replace(/^Strukturovaný zápis ve formátu BIRP\+S:\s*/i, "");
  return text
    .replace(/B\s*[–-]\s*PREZENTACE KLIENTA:?\s*/g, "## B – PREZENTACE KLIENTA\n")
    .replace(/I\s*[–-]\s*INTERVENCE:?\s*/g, "\n## I – INTERVENCE\n")
    .replace(/R\s*[–-]\s*ODPOVĚĎ KLIENTA:?\s*/g, "\n## R – ODPOVĚĎ KLIENTA\n")
    .replace(/P\s*[–-]\s*PLÁN:?\s*/g, "\n## P – PLÁN\n")
    .replace(/S\s*[–-]\s*SUPERVIZNÍ POZNÁMKA[^:]*:?\s*/g, "\n## S – SUPERVIZNÍ POZNÁMKA (Karel)\n");
};


interface SessionIntakePanelProps {
  clientId: string;
  clientName: string;
  onComplete: () => void;
}

const SessionIntakePanel = ({ clientId, clientName, onComplete }: SessionIntakePanelProps) => {
  const [inputMode, setInputMode] = useState<"choose" | "text" | "audio">("choose");
  const [textInput, setTextInput] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [progressText, setProgressText] = useState("");
  const [spinnerChar, setSpinnerChar] = useState("⠋");
  const [result, setResult] = useState<any>(null);
  const [revisionNote, setRevisionNote] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isRevising, setIsRevising] = useState(false);
  const recorder = useSessionAudioRecorder();
  const startTimeRef = useRef<number>(0);
  const originalBodyRef = useRef<any>(null);

  // Animated spinner
  useEffect(() => {
    if (!isProcessing) return;
    const id = setInterval(() => {
      setSpinnerChar(c => {
        const idx = SPINNER_CHARS.indexOf(c);
        return SPINNER_CHARS[(idx + 1) % SPINNER_CHARS.length];
      });
    }, 100);
    return () => clearInterval(id);
  }, [isProcessing]);

  // Progress text based on elapsed time
  useEffect(() => {
    if (!isProcessing) return;
    const isAudio = inputMode === "audio";
    const id = setInterval(() => {
      const elapsed = (Date.now() - startTimeRef.current) / 1000;
      if (elapsed < 3) setProgressText("Přijímám vstup...");
      else if (elapsed < 8 && isAudio) setProgressText("Přepisuji audio...");
      else if (elapsed < 18) setProgressText("Analyzuju s kartou klienta...");
      else if (elapsed < 25) setProgressText("Konzultuji odborné zdroje...");
      else setProgressText("Sestavuju zápis a doporučení...");
    }, 1000);
    return () => clearInterval(id);
  }, [isProcessing, inputMode]);

  const callIntake = useCallback(async (body: any) => {
    const headers = await getAuthHeaders();
    const res = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-session-intake`,
      { method: "POST", headers, body: JSON.stringify(body) }
    );
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `Chyba ${res.status}`);
    }
    return res.json();
  }, []);

  const handleSubmit = useCallback(async () => {
    setIsProcessing(true);
    startTimeRef.current = Date.now();
    setProgressText("Přijímám vstup...");

    try {
      const body: any = {
        clientId,
        sessionDate: new Date().toISOString().split("T")[0],
        therapistName: "Hanka",
      };

      if (inputMode === "audio") {
        const base64 = await recorder.getBase64();
        if (!base64) throw new Error("Žádná nahrávka");
        body.inputType = "audio";
        body.audioBase64 = base64;
      } else {
        if (!textInput.trim()) { toast.error("Napiš popis sezení"); setIsProcessing(false); return; }
        body.inputType = "text";
        body.textInput = textInput;
      }

      originalBodyRef.current = body;
      const data = await callIntake(body);
      setResult(data);
    } catch (err: any) {
      console.error("Session intake error:", err);
      toast.error(err.message || "Chyba při zpracování");
    } finally {
      setIsProcessing(false);
    }
  }, [clientId, inputMode, textInput, recorder, callIntake]);

  const handleRevision = useCallback(async () => {
    if (!revisionNote.trim()) { toast.error("Napiš co chceš změnit"); return; }
    setIsRevising(true);
    setIsProcessing(true);
    startTimeRef.current = Date.now();
    setProgressText("Přijímám vstup...");

    try {
      const body = { ...originalBodyRef.current, revisionRequest: revisionNote };
      const data = await callIntake(body);
      setResult(data);
      setRevisionNote("");
    } catch (err: any) {
      toast.error(err.message || "Chyba při přepracování");
    } finally {
      setIsProcessing(false);
      setIsRevising(false);
    }
  }, [revisionNote, callIntake]);

  const saveToDb = useCallback(async () => {
    if (!result) return;
    setIsSaving(true);

    try {
      const rec = result.sessionRecord || {};
      const { error: sessionError } = await supabase.from("client_sessions").insert({
        client_id: clientId,
        session_number: result.sessionNumber,
        session_date: result.sessionDate || new Date().toISOString().split("T")[0],
        ai_analysis: rec.summary || "",
        ai_hypotheses: rec.analysis || "",
        ai_recommended_methods: (rec.therapeuticRecommendations || []).map((r: any) => `${r.approach}: ${r.reason}`).join("\n"),
        ai_risk_assessment: rec.diagnosticHypothesis?.hypothesis || "",
        notes: `Zápis sezení č. ${result.sessionNumber} – Hanka – ${new Date().toLocaleDateString("cs-CZ")}`,
        report_next_session_goal: (rec.nextSessionFocus || []).join("; "),
        report_missing_data: (rec.diagnosticHypothesis?.missingData || []).join("; "),
      });
      if (sessionError) throw sessionError;

      const allTasks: any[] = [];
      (result.questionnaire || []).forEach((q: any) => {
        allTasks.push({
          client_id: clientId,
          task: q.question,
          task_type: "therapist_question",
          priority: q.priority || "medium",
          status: "planned",
          method: q.category || "other",
        });
      });
      (result.clientTasks || []).forEach((t: string) => {
        allTasks.push({
          client_id: clientId,
          task: t,
          task_type: "client_homework",
          priority: "medium",
          status: "planned",
          for_session: result.sessionNumber + 1,
        });
      });

      if (allTasks.length > 0) {
        const { error: tasksError } = await supabase.from("client_tasks").insert(allTasks);
        if (tasksError) console.error("Tasks insert error:", tasksError);
      }

      toast.success(`Sezení č. ${result.sessionNumber} uloženo`);
      onComplete();
    } catch (err: any) {
      console.error("Save error:", err);
      toast.error("Chyba při ukládání");
    } finally {
      setIsSaving(false);
    }
  }, [result, clientId, onComplete]);

  // ── Processing state ──
  if (isProcessing) {
    return (
      <div className="bg-card rounded-xl border border-border p-6 space-y-4">
        <div className="flex items-center gap-3">
          <span className="text-lg font-mono text-primary">{spinnerChar}</span>
          <span className="text-sm font-medium text-foreground">{progressText}</span>
        </div>
        <Progress value={65} className="h-2" />
        <p className="text-xs text-muted-foreground">
          {isRevising ? "Přepracovávám podle tvých instrukcí…" : "Obvykle ~15 sekund"}
        </p>
      </div>
    );
  }

  // ── Result view — Review panel ──
  if (result) {
    return (
      <div className="space-y-4">
        <div className="bg-card rounded-xl border border-border p-4">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-lg">✅</span>
            <h3 className="font-semibold text-foreground text-sm">
              Karel sestavil zápis – zkontroluj než uložíš
            </h3>
          </div>

          {result.transcription && (
            <div className="mb-3 p-3 bg-muted/30 rounded-lg">
              <p className="text-xs text-muted-foreground mb-1">Přepis audia:</p>
              <p className="text-sm">{result.transcription}</p>
            </div>
          )}

          <Tabs defaultValue="summary" className="space-y-3">
            <TabsList className="grid w-full grid-cols-4 h-8">
              <TabsTrigger value="summary" className="text-xs">Zápis</TabsTrigger>
              <TabsTrigger value="analysis" className="text-xs">Analýza</TabsTrigger>
              <TabsTrigger value="diagnosis" className="text-xs">Diagnostika</TabsTrigger>
              <TabsTrigger value="recommendations" className="text-xs">Doporučení</TabsTrigger>
            </TabsList>

            <TabsContent value="summary" className="prose prose-sm max-w-none dark:prose-invert">
              <ReactMarkdown>{formatBirps(result.sessionRecord?.summary || "—")}</ReactMarkdown>
            </TabsContent>

            <TabsContent value="analysis" className="prose prose-sm max-w-none dark:prose-invert">
              <ReactMarkdown>{result.sessionRecord?.analysis || "—"}</ReactMarkdown>
            </TabsContent>

            <TabsContent value="diagnosis" className="space-y-3">
              {result.sessionRecord?.diagnosticHypothesis && (
                <div className="space-y-2">
                  <p className="text-sm">{result.sessionRecord.diagnosticHypothesis.hypothesis || "—"}</p>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">Jistota:</span>
                    <Badge variant={
                      result.sessionRecord.diagnosticHypothesis.confidence === "high" ? "default" :
                      result.sessionRecord.diagnosticHypothesis.confidence === "medium" ? "secondary" : "outline"
                    } className="text-xs">
                      {result.sessionRecord.diagnosticHypothesis.confidence === "high" ? "Vysoká" :
                       result.sessionRecord.diagnosticHypothesis.confidence === "medium" ? "Střední" : "Nízká"}
                    </Badge>
                  </div>
                  {result.sessionRecord.diagnosticHypothesis.missingData?.length > 0 && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Co chybí:</p>
                      <ul className="text-sm space-y-1">
                        {result.sessionRecord.diagnosticHypothesis.missingData.map((d: string, i: number) => (
                          <li key={i} className="flex items-start gap-1.5">
                            <span className="text-muted-foreground">•</span> {d}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </TabsContent>

            <TabsContent value="recommendations" className="space-y-3">
              {(result.sessionRecord?.therapeuticRecommendations || []).map((r: any, i: number) => (
                <div key={i} className="p-3 bg-muted/30 rounded-lg">
                  <p className="text-sm font-medium">{r.approach}</p>
                  <p className="text-xs text-muted-foreground mt-1">{r.reason}</p>
                </div>
              ))}
              {result.sessionRecord?.nextSessionFocus?.length > 0 && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Zaměření příště:</p>
                  <div className="flex flex-wrap gap-1.5">
                    {result.sessionRecord.nextSessionFocus.map((f: string, i: number) => (
                      <Badge key={i} variant="outline" className="text-xs">{f}</Badge>
                    ))}
                  </div>
                </div>
              )}
            </TabsContent>
          </Tabs>
        </div>

        {/* Questionnaire & tasks preview */}
        {(result.questionnaire?.length > 0 || result.clientTasks?.length > 0) && (
          <div className="bg-card rounded-xl border border-border p-4 space-y-3">
            {result.questionnaire?.length > 0 && (
              <div>
                <h4 className="text-sm font-semibold mb-2">📋 Dotazník do příště ({result.questionnaire.length} otázek)</h4>
                {result.questionnaire.map((q: any, i: number) => (
                  <div key={i} className="flex items-start gap-2 py-1.5">
                    <Badge variant={q.priority === "high" ? "destructive" : q.priority === "medium" ? "secondary" : "outline"} className="text-[10px] shrink-0 mt-0.5">
                      {q.priority === "high" ? "🔴" : q.priority === "medium" ? "🟡" : "🟢"}
                    </Badge>
                    <span className="text-sm">{q.question}</span>
                  </div>
                ))}
              </div>
            )}
            {result.clientTasks?.length > 0 && (
              <div>
                <h4 className="text-sm font-semibold mb-2">📝 Úkoly klienta</h4>
                {result.clientTasks.map((t: string, i: number) => (
                  <p key={i} className="text-sm py-1">• {t}</p>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Revision + Save */}
        <div className="bg-card rounded-xl border border-border p-4 space-y-3">
          <p className="text-sm text-muted-foreground">Chceš něco změnit?</p>
          <Textarea
            placeholder="Napiš Karlovi co upravit... (volitelné)"
            value={revisionNote}
            onChange={(e) => setRevisionNote(e.target.value)}
            className="min-h-[60px]"
          />
          <div className="flex gap-2">
            <Button variant="outline" onClick={handleRevision} disabled={!revisionNote.trim() || isSaving} className="gap-1.5 flex-1">
              <RefreshCw className="w-4 h-4" /> Přepracovat
            </Button>
            <Button onClick={saveToDb} disabled={isSaving} className="gap-1.5 flex-1">
              {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Uložit do sezení
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // ── Input mode selection ──
  return (
    <div className="bg-card rounded-xl border border-border p-4 sm:p-6 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-foreground">Zaznamenat sezení — {clientName}</h3>
        <p className="text-xs text-muted-foreground mt-0.5">Popiš co proběhlo na sezení. Karel to zpracuje.</p>
      </div>

      {inputMode === "choose" && (
        <div className="flex gap-3">
          <Button variant="outline" className="flex-1 h-20 flex-col gap-2" onClick={() => { setInputMode("audio"); recorder.startRecording(); }}>
            <Mic className="w-6 h-6" />
            <span className="text-xs">Namluvit</span>
          </Button>
          <Button variant="outline" className="flex-1 h-20 flex-col gap-2" onClick={() => setInputMode("text")}>
            <Keyboard className="w-6 h-6" />
            <span className="text-xs">Napsat</span>
          </Button>
        </div>
      )}

      {inputMode === "text" && (
        <div className="space-y-3">
          <Textarea
            placeholder="Co proběhlo na sezení? Piš volně, Karel to zpracuje sám…"
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            className="min-h-[150px]"
          />
          <div className="flex gap-2">
            <Button onClick={handleSubmit} disabled={!textInput.trim()} className="gap-1.5">
              <Send className="w-4 h-4" /> Odeslat Karlovi
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setInputMode("choose")}>Zpět</Button>
          </div>
        </div>
      )}

      {inputMode === "audio" && (
        <div className="space-y-3">
          {recorder.state === "recording" && (
            <div className="flex items-center gap-3 bg-destructive/5 rounded-lg p-3">
              <div className="w-3 h-3 rounded-full bg-destructive animate-pulse" />
              <span className="text-sm font-medium tabular-nums">{formatDuration(recorder.duration)}</span>
              <Progress value={Math.min((recorder.duration / recorder.maxDuration) * 100, 100)} className="h-2 flex-1" />
              <Button variant="ghost" size="sm" onClick={recorder.pauseRecording} className="h-8 w-8 p-0">
                <Pause className="w-4 h-4" />
              </Button>
              <Button variant="ghost" size="sm" onClick={recorder.stopRecording} className="h-8 w-8 p-0">
                <Square className="w-3.5 h-3.5" />
              </Button>
            </div>
          )}
          {recorder.state === "paused" && (
            <div className="flex items-center gap-3 bg-muted/50 rounded-lg p-3">
              <span className="text-sm">⏸ {formatDuration(recorder.duration)}</span>
              <Button variant="ghost" size="sm" onClick={recorder.resumeRecording} className="h-8 w-8 p-0">
                <Play className="w-4 h-4" />
              </Button>
              <Button variant="ghost" size="sm" onClick={recorder.stopRecording} className="h-8 w-8 p-0">
                <Square className="w-3.5 h-3.5" />
              </Button>
            </div>
          )}
          {recorder.state === "recorded" && (
            <div className="space-y-3">
              {recorder.audioUrl && <audio src={recorder.audioUrl} controls className="w-full h-10" />}
              <div className="flex gap-2">
                <Button onClick={handleSubmit} className="gap-1.5">
                  <Send className="w-4 h-4" /> Odeslat Karlovi
                </Button>
                <Button variant="ghost" size="sm" onClick={recorder.discardRecording}>Zahodit</Button>
              </div>
            </div>
          )}
          {recorder.state === "idle" && (
            <div className="flex gap-2">
              <Button variant="outline" onClick={recorder.startRecording} className="gap-1.5">
                <Mic className="w-4 h-4" /> Začít nahrávat
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setInputMode("choose")}>Zpět</Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default SessionIntakePanel;

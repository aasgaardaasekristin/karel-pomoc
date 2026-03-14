import { useState, useCallback } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { ClipboardList, Loader2, Save, Sparkles, FileText, Mic, Check } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { getAuthHeaders } from "@/lib/auth";
import { toast } from "sonner";
import SessionAudioRecorder from "./SessionAudioRecorder";
import { useSessionAudioRecorder } from "@/hooks/useSessionAudioRecorder";

type Message = { role: "user" | "assistant"; content: string };

interface HanaSessionReportProps {
  messages: Message[];
  disabled?: boolean;
}

interface SessionFields {
  clientName: string;
  keyTheme: string;
  summary: string;
  risks: string;
  nextGoal: string;
}

const EMPTY: SessionFields = { clientName: "", keyTheme: "", summary: "", risks: "", nextGoal: "" };

type StepStatus = "pending" | "active" | "done";

const StepIndicator = ({ 
  step, label, status, hint 
}: { step: number; label: string; status: StepStatus; hint?: string }) => (
  <div className="flex items-center gap-2 min-w-0">
    <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 transition-all ${
      status === "done" 
        ? "bg-primary text-primary-foreground" 
        : status === "active" 
          ? "bg-primary/20 text-primary ring-2 ring-primary/40" 
          : "bg-muted text-muted-foreground"
    }`}>
      {status === "done" ? <Check className="w-3 h-3" /> : step}
    </div>
    <div className="min-w-0">
      <p className={`text-[11px] font-medium leading-tight truncate ${
        status === "active" ? "text-foreground" : status === "done" ? "text-primary" : "text-muted-foreground"
      }`}>{label}</p>
      {hint && status === "active" && (
        <p className="text-[9px] text-muted-foreground leading-tight truncate">{hint}</p>
      )}
    </div>
  </div>
);

const HanaSessionReport = ({ messages, disabled }: HanaSessionReportProps) => {
  const [open, setOpen] = useState(false);
  const [fields, setFields] = useState<SessionFields>({ ...EMPTY });
  const [isPrefilling, setIsPrefilling] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isSynthesizing, setIsSynthesizing] = useState(false);
  const [voiceAnalyses, setVoiceAnalyses] = useState<string[]>([]);

  const recorder = useSessionAudioRecorder();

  const set = (k: keyof SessionFields, v: string) => setFields(prev => ({ ...prev, [k]: v }));

  const handlePrefill = useCallback(async () => {
    if (messages.length < 3) {
      toast.info("Potřebuji víc konverzace pro předvyplnění.");
      return;
    }
    setIsPrefilling(true);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-prefill`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          messages: messages.slice(-40),
          hint: "Vrať JSON s poli: keyTheme (klíčové téma sezení), summary (stručné shrnutí 2-3 věty), risks (rizika nebo důležité poznámky), nextGoal (cíl dalšího sezení). Bez jmen klientů.",
        }),
      });
      if (!res.ok) throw new Error("Prefill error");
      const data = await res.json();
      setFields(prev => ({
        ...prev,
        keyTheme: data.keyTheme || prev.keyTheme,
        summary: data.context || data.summary || prev.summary,
        risks: Array.isArray(data.risks) ? data.risks.join(", ") : (data.risks || data.missingData || prev.risks),
        nextGoal: data.nextSessionGoal || data.nextGoal || prev.nextGoal,
      }));
      toast.success("Předvyplněno z chatu");
    } catch {
      toast.error("Chyba při předvyplňování");
    } finally {
      setIsPrefilling(false);
    }
  }, [messages]);

  const handleAudioSend = useCallback(async () => {
    if (!fields.clientName.trim()) {
      toast.error("Nejdřív vyplň jméno klienta");
      return;
    }
    if (recorder.state !== "recorded") {
      toast.error("Nejdřív nahrávku zastav a pak ji odešli k analýze.");
      return;
    }
    setIsAnalyzing(true);
    try {
      const base64 = await recorder.getBase64();
      if (!base64) throw new Error("No audio");

      const chatContext = messages.slice(-10)
        .map(m => `${m.role === "user" ? "TERAPEUT" : "KAREL"}: ${m.content}`)
        .join("\n");

      const headers = await getAuthHeaders();
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-audio-analysis`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          audioBase64: base64,
          mode: "supervision",
          chatContext,
          clientName: fields.clientName.trim(),
        }),
      });

      if (!res.ok) {
        if (res.status === 429) { toast.error("Příliš mnoho požadavků, zkus to za chvíli"); return; }
        if (res.status === 402) { toast.error("Vyčerpán kredit AI"); return; }
        throw new Error("Analysis error");
      }

      const data = await res.json();
      const analysis = data.analysis || "Nepodařilo se analyzovat.";
      setVoiceAnalyses(prev => [...prev, analysis]);
      recorder.reset();
      toast.success("Audio analyzováno – mikrofon je připraven k dalšímu nahrávání");
    } catch (err) {
      console.error("Audio analysis error:", err);
      toast.error("Chyba při analýze audia");
    } finally {
      setIsAnalyzing(false);
    }
  }, [recorder, fields.clientName, messages]);

  const handleSynthesize = useCallback(async () => {
    if (!fields.clientName.trim()) {
      toast.error("Zadej jméno klienta");
      return;
    }
    if (voiceAnalyses.length === 0 && !fields.summary.trim()) {
      toast.error("Nemám žádné analýzy ani shrnutí k syntéze");
      return;
    }
    setIsSynthesizing(true);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-session-report`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          chatMessages: messages.slice(-30),
          formData: {
            context: fields.summary,
            keyTheme: fields.keyTheme,
            risks: fields.risks ? [fields.risks] : [],
            nextSessionGoal: fields.nextGoal,
          },
          clientName: fields.clientName.trim(),
          voiceAnalyses,
        }),
      });

      if (!res.ok) throw new Error("Synthesis error");
      const data = await res.json();
      const synthesizedReport = typeof data.report === "string" ? data.report.trim() : "";
      if (!synthesizedReport) throw new Error("Prázdný výstup syntézy");

      // Save to DB
      const { data: existing } = await supabase
        .from("clients")
        .select("id")
        .ilike("name", fields.clientName.trim())
        .limit(1)
        .maybeSingle();

      let clientId: string;
      if (existing) {
        clientId = existing.id;
      } else {
        const { data: newClient, error } = await supabase
          .from("clients")
          .insert({ name: fields.clientName.trim() })
          .select("id")
          .single();
        if (error || !newClient) throw error || new Error("Client create failed");
        clientId = newClient.id;
      }

      const { error: insertError } = await supabase.from("client_sessions").insert({
        client_id: clientId,
        report_key_theme: fields.keyTheme || null,
        report_context: fields.summary || null,
        report_risks: fields.risks ? [fields.risks] : null,
        report_next_session_goal: fields.nextGoal || null,
        ai_analysis: synthesizedReport,
        voice_analysis: voiceAnalyses.join("\n\n---\n\n") || null,
        notes: `Syntetizovaný report – ${new Date().toLocaleDateString("cs-CZ")}`,
      });
      if (insertError) throw insertError;

      toast.success("Report syntetizován a uložen na kartu klienta");
      setFields({ ...EMPTY });
      setVoiceAnalyses([]);
      setOpen(false);
    } catch (err) {
      console.error("Synthesis error:", err);
      toast.error("Chyba při syntéze reportu");
    } finally {
      setIsSynthesizing(false);
    }
  }, [fields, voiceAnalyses, messages]);

  const handleSave = useCallback(async () => {
    if (!fields.clientName.trim()) {
      toast.error("Zadej jméno klienta");
      return;
    }

    const hasAnyContent =
      !!fields.keyTheme.trim() ||
      !!fields.summary.trim() ||
      !!fields.risks.trim() ||
      !!fields.nextGoal.trim() ||
      voiceAnalyses.length > 0;

    if (!hasAnyContent) {
      toast.error("Vyplň aspoň jedno pole nebo nejdřív přidej audio analýzu.");
      return;
    }

    setIsSaving(true);
    try {
      const { data: existing } = await supabase
        .from("clients")
        .select("id")
        .ilike("name", fields.clientName.trim())
        .limit(1)
        .maybeSingle();

      let clientId: string;
      if (existing) {
        clientId = existing.id;
      } else {
        const { data: newClient, error } = await supabase
          .from("clients")
          .insert({ name: fields.clientName.trim() })
          .select("id")
          .single();
        if (error || !newClient) throw error || new Error("Failed to create client");
        clientId = newClient.id;
      }

      const { error: sessErr } = await supabase.from("client_sessions").insert({
        client_id: clientId,
        report_key_theme: fields.keyTheme || null,
        report_context: fields.summary || null,
        report_risks: fields.risks ? [fields.risks] : null,
        report_next_session_goal: fields.nextGoal || null,
        voice_analysis: voiceAnalyses.length > 0 ? voiceAnalyses.join("\n\n---\n\n") : null,
        notes: `Rychlý zápis z režimu Hana – ${new Date().toLocaleDateString("cs-CZ")}`,
      });
      if (sessErr) throw sessErr;

      toast.success("Sezení uloženo");
      setFields({ ...EMPTY });
      setVoiceAnalyses([]);
      setOpen(false);
    } catch (error) {
      console.error("Save session error:", error);
      toast.error("Chyba při ukládání");
    } finally {
      setIsSaving(false);
    }
  }, [fields, voiceAnalyses]);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          className="h-7 px-2 text-xs gap-1"
        >
          <ClipboardList className="w-3 h-3" />
          <span className="hidden sm:inline">Zápis sezení</span>
          <span className="sm:hidden">📋</span>
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-[340px] sm:w-[420px] overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="text-base">Rychlý zápis sezení</SheetTitle>
        </SheetHeader>

        {/* Step indicator */}
        {(() => {
          const hasFields = !!(fields.clientName.trim() && (fields.keyTheme.trim() || fields.summary.trim() || fields.risks.trim() || fields.nextGoal.trim()));
          const hasAudio = voiceAnalyses.length > 0;
          const step1: StepStatus = hasFields ? "done" : fields.clientName.trim() ? "active" : "active";
          const step2: StepStatus = hasAudio ? "done" : hasFields ? "active" : "pending";
          const step3: StepStatus = hasFields || hasAudio ? "active" : "pending";
          return (
            <div className="mt-3 flex items-center gap-1">
              <StepIndicator step={1} label="Vyplnit" status={step1} hint="Jméno + pole nebo Předvyplnit" />
              <div className="w-4 h-px bg-border shrink-0" />
              <StepIndicator step={2} label="Audio" status={step2} hint="Volitelné – nahrát a analyzovat" />
              <div className="w-4 h-px bg-border shrink-0" />
              <StepIndicator step={3} label="Syntetizovat" status={step3} hint="AI report → Kartotéka" />
            </div>
          );
        })()}

        <div className="mt-4 space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Klient</Label>
            <Input
              value={fields.clientName}
              onChange={e => set("clientName", e.target.value)}
              placeholder="Jméno / kód klienta"
              className="h-8 text-sm"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Hlavní téma</Label>
            <Input
              value={fields.keyTheme}
              onChange={e => set("keyTheme", e.target.value)}
              placeholder="např. Úzkost, Vztahy, Trauma..."
              className="h-8 text-sm"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Shrnutí sezení</Label>
            <Textarea
              value={fields.summary}
              onChange={e => set("summary", e.target.value)}
              placeholder="Stručný popis průběhu..."
              className="min-h-[80px] text-sm resize-none"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Rizika / poznámky</Label>
            <Textarea
              value={fields.risks}
              onChange={e => set("risks", e.target.value)}
              placeholder="Rizikové faktory, důležité postřehy..."
              className="min-h-[60px] text-sm resize-none"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Cíl dalšího sezení</Label>
            <Textarea
              value={fields.nextGoal}
              onChange={e => set("nextGoal", e.target.value)}
              placeholder="Na co navázat příště..."
              className="min-h-[60px] text-sm resize-none"
            />
          </div>

          {/* Audio recorder section */}
          <div className="border-t border-border pt-3 space-y-2">
            <div className="flex items-center gap-1.5">
              <Mic className="w-3.5 h-3.5 text-muted-foreground" />
              <Label className="text-xs font-medium">Audio nahrávka ze sezení</Label>
            </div>
            <SessionAudioRecorder
              state={recorder.state}
              duration={recorder.duration}
              audioUrl={recorder.audioUrl}
              isAnalyzing={isAnalyzing}
              onStart={recorder.startRecording}
              onPause={recorder.pauseRecording}
              onResume={recorder.resumeRecording}
              onStop={recorder.stopRecording}
              onDiscard={recorder.discardRecording}
              onSend={handleAudioSend}
              disabled={!fields.clientName.trim()}
            />
            {!fields.clientName.trim() && recorder.state === "idle" && (
              <p className="text-[10px] text-muted-foreground">Nejdřív vyplň jméno klienta</p>
            )}
            <p className="text-[10px] text-muted-foreground">
              Postup: Nahrát → Stop → Analyzovat. Potom můžeš report syntetizovat a uložit do Kartotéky.
            </p>
          </div>

          {/* Voice analyses list */}
          {voiceAnalyses.length > 0 && (
            <div className="border-t border-border pt-3 space-y-2">
              <Label className="text-xs font-medium text-muted-foreground">
                Analýzy z nahrávek ({voiceAnalyses.length})
              </Label>
              <div className="space-y-2 max-h-[200px] overflow-y-auto">
                {voiceAnalyses.map((a, i) => (
                  <div key={i} className="text-xs p-2 rounded-md bg-muted/50 border border-border">
                    <span className="font-medium text-primary">#{i + 1}</span>
                    <p className="mt-1 text-muted-foreground whitespace-pre-wrap line-clamp-4">{a}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex flex-col gap-2 pt-2 border-t border-border">
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handlePrefill}
                disabled={isPrefilling || messages.length < 3}
                className="text-xs h-8 gap-1 flex-1"
              >
                {isPrefilling ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                Předvyplnit
              </Button>
              <Button
                size="sm"
                onClick={handleSave}
                disabled={isSaving || !fields.clientName.trim()}
                className="text-xs h-8 gap-1 flex-1"
              >
                {isSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                Uložit
              </Button>
            </div>
            <Button
              size="sm"
              variant="secondary"
              onClick={handleSynthesize}
              disabled={
                isSynthesizing ||
                !fields.clientName.trim() ||
                (voiceAnalyses.length === 0 &&
                  !fields.summary.trim() &&
                  !fields.keyTheme.trim() &&
                  !fields.risks.trim() &&
                  !fields.nextGoal.trim())
              }
              className="text-xs h-8 gap-1 w-full"
            >
              {isSynthesizing ? <Loader2 className="w-3 h-3 animate-spin" /> : <FileText className="w-3 h-3" />}
              Syntetizovat report ({voiceAnalyses.length} audio)
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
};

export default HanaSessionReport;

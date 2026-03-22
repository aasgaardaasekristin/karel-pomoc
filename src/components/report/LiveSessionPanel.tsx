import { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Send, Loader2, Square, Mic, Pause, Play, StopCircle, ImagePlus, ClipboardList } from "lucide-react";
import { getAuthHeaders } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useActiveSessions } from "@/contexts/ActiveSessionsContext";
import ChatMessage from "@/components/ChatMessage";
import { useSessionAudioRecorder } from "@/hooks/useSessionAudioRecorder";
import { useImageUpload } from "@/hooks/useImageUpload";
import { Progress } from "@/components/ui/progress";

type Message = { role: "user" | "assistant"; content: string };
type SessionMode = "plan" | "modify" | "custom" | "free";

const formatDuration = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
};

interface LiveSessionPanelProps {
  clientId: string;
  clientName: string;
  caseSummary: string | null;
  onEndSession: (sessionReport: string) => void;
}

const LiveSessionPanel = ({ clientId, clientName, caseSummary, onEndSession }: LiveSessionPanelProps) => {
  const { activeSession, activeSessionId, updateChatMessages } = useActiveSessions();
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isFinishing, setIsFinishing] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const recorder = useSessionAudioRecorder();
  const [isAudioAnalyzing, setIsAudioAnalyzing] = useState(false);
  const audioSegmentCountRef = useRef(0);
  const { pendingImages, fileInputRef, openFilePicker, handleFileChange, clearImages } = useImageUpload();
  const [imageAnalysisType, setImageAnalysisType] = useState("Kresba klienta");
  const [isImageAnalyzing, setIsImageAnalyzing] = useState(false);
  const [sessionMode, setSessionMode] = useState<SessionMode | null>(null);
  const [customTopic, setCustomTopic] = useState("");
  const [modeConfirmed, setModeConfirmed] = useState(false);

  const messages = activeSession?.chatMessages ?? [];
  const sessionPlan = activeSession?.sessionPlan;
  const hasPlan = !!sessionPlan;

  // Auto-greet after mode confirmed
  useEffect(() => {
    if (activeSession && messages.length === 0 && modeConfirmed && sessionMode) {
      let greeting = "";
      switch (sessionMode) {
        case "plan":
          greeting = `Hani, jsem tu s tebou na sezení s **${clientName}**. 🎯\n\nPracujeme **podle připraveného plánu**. Budu tě provádět jednotlivými fázemi.\n\n*Začni kdykoliv – jsem připravený.*`;
          break;
        case "modify":
          greeting = `Hani, jsem tu s tebou na sezení s **${clientName}**. 🎯\n\nMáme plán, ale upravíme ho podle tvého zadání: "${customTopic}"\n\n*Začni kdykoliv – jsem připravený.*`;
          break;
        case "custom":
          greeting = `Hani, jsem tu s tebou na sezení s **${clientName}**. 🎯\n\nDnes se zaměříme na: **${customTopic}**\n\n*Začni kdykoliv – jsem připravený.*`;
          break;
        case "free":
        default:
          greeting = `Hani, jsem tu s tebou na sezení s **${clientName}**. 🎯\n\nPiš mi, co klient říká nebo dělá, a já ti v reálném čase poradím jak reagovat.\n\n*Začni kdykoliv – jsem připravený.*`;
          break;
      }
      updateChatMessages(activeSession.id, [{ role: "assistant", content: greeting }]);
    }
  }, [modeConfirmed]);

  // Scroll to bottom
  useEffect(() => {
    const viewport = scrollRef.current?.querySelector("[data-radix-scroll-area-viewport]") as HTMLDivElement | null;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [messages]);

  const buildContext = useCallback(() => {
    let planContext = "";
    if (sessionMode === "plan" && sessionPlan) {
      planContext = `\n═══ PLÁN SEZENÍ ═══\n${typeof sessionPlan === "string" ? sessionPlan : JSON.stringify(sessionPlan, null, 2)}\n\nŘIĎ SE PLÁNEM – naviguj terapeuta podle fází výše.\n`;
    } else if (sessionMode === "modify" && sessionPlan && customTopic) {
      planContext = `\n═══ UPRAVENÝ PLÁN ═══\nPůvodní plán: ${typeof sessionPlan === "string" ? sessionPlan : JSON.stringify(sessionPlan, null, 2)}\nÚprava terapeuta: ${customTopic}\n\nPřizpůsob plán podle úpravy terapeuta.\n`;
    } else if (sessionMode === "custom" && customTopic) {
      planContext = `\n═══ VLASTNÍ TÉMA ═══\nTerapeut zadal: ${customTopic}\nZaměř se na toto téma.\n`;
    }

    return `═══ LIVE SEZENÍ S KLIENTEM ═══
Klient: ${clientName}
Čas: ${new Date().toISOString()}

${caseSummary ? `SHRNUTÍ PŘÍPADU:\n${caseSummary}\n` : ""}${planContext}
═══ INSTRUKCE ═══
- Jsi Karel, klinický supervizor PŘÍTOMNÝ na živém sezení.
- Terapeut ti píše, co klient říká/dělá, nebo posílá audio segmenty.
- Odpovídej OKAMŽITĚ a STRUČNĚ (3-5 řádků max):
  🎯 Co říct klientovi (přesná věta)
  👀 Na co si dát pozor (neverbální signály)
  ⚠️ Rizika/varování (pokud relevantní)
  🎮 Další krok (co udělat/zeptat se)
- Pokud dostaneš audio analýzu, reaguj na zjištění z hlasu (tenze, emoce).
- Buď direktivní a konkrétní. Žádné filozofování.`;
  }, [clientName, caseSummary, sessionMode, sessionPlan, customTopic]);

  const sendMessage = async () => {
    if ((!input.trim()) || isLoading) return;
    const userMessage = input.trim();
    setInput("");

    const updatedMessages = [...messages, { role: "user" as const, content: userMessage }];
    updateChatMessages(activeSessionId!, updatedMessages);
    setIsLoading(true);

    let assistantContent = "";
    try {
      const headers = await getAuthHeaders();
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-chat`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            messages: updatedMessages,
            mode: "supervision",
            didInitialContext: buildContext(),
          }),
        }
      );

      if (!response.ok || !response.body) throw new Error("Chyba");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const withAssistant = [...updatedMessages, { role: "assistant" as const, content: "" }];
      updateChatMessages(activeSessionId!, withAssistant);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          let line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (!line.startsWith("data: ")) continue;
          const json = line.slice(6).trim();
          if (json === "[DONE]") break;
          try {
            const parsed = JSON.parse(json);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              assistantContent += content;
              updateChatMessages(activeSessionId!, [...updatedMessages, { role: "assistant" as const, content: assistantContent }]);
            }
          } catch {
            buffer = line + "\n" + buffer;
            break;
          }
        }
      }
    } catch (error) {
      console.error("Live session error:", error);
      toast.error("Chyba při komunikaci s Karlem");
      if (!assistantContent) updateChatMessages(activeSessionId!, messages);
    } finally {
      setIsLoading(false);
      textareaRef.current?.focus();
    }
  };

  // Audio segment analysis
  const handleAudioSegmentAnalysis = async () => {
    if (isAudioAnalyzing) return;
    setIsAudioAnalyzing(true);
    try {
      const base64 = await recorder.getBase64();
      if (!base64) throw new Error("Žádná nahrávka");

      audioSegmentCountRef.current += 1;
      const segNum = audioSegmentCountRef.current;

      const chatContext = messages.slice(-10).map(m =>
        `${m.role === "user" ? "TERAPEUT" : "KAREL"}: ${typeof m.content === "string" ? m.content : "(multimodal)"}`
      ).join("\n");

      const headers = await getAuthHeaders();
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-audio-analysis`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            audioBase64: base64,
            mode: "live-session",
            chatContext,
            clientName,
          }),
        }
      );

      if (!response.ok) throw new Error("Chyba při analýze");
      const { analysis } = await response.json();
      if (!analysis) throw new Error("Prázdná analýza");

      const updatedMessages = [
        ...messages,
        { role: "user" as const, content: `🎙️ *[Audio segment #${segNum} – ${formatDuration(recorder.duration)}]*` },
        { role: "assistant" as const, content: analysis },
      ];
      updateChatMessages(activeSessionId!, updatedMessages);
      recorder.reset();
      toast.success(`Audio segment #${segNum} analyzován`);
    } catch (error) {
      console.error("Audio analysis error:", error);
      toast.error("Chyba při analýze audia");
    } finally {
      setIsAudioAnalyzing(false);
    }
  };

  // End session and generate report
  const handleEndSession = async () => {
    if (messages.length < 2) {
      toast.error("Sezení je prázdné – nejdřív veď sezení.");
      return;
    }
    setIsFinishing(true);
    try {
      const headers = await getAuthHeaders();
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-session-finalize`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            clientId,
            clientName,
            chatMessages: messages,
            caseSummary,
          }),
        }
      );

      if (!response.ok) throw new Error("Chyba při finalizaci");
      const { report } = await response.json();
      onEndSession(report || "Zápis nebyl vygenerován.");
    } catch (error) {
      console.error("Finalize error:", error);
      toast.error("Chyba při zpracování sezení");
    } finally {
      setIsFinishing(false);
    }
  };

  // Mode selection dialog
  if (messages.length === 0 && !modeConfirmed) {
    const handleConfirm = () => {
      if (!sessionMode) return;
      if ((sessionMode === "modify" || sessionMode === "custom") && !customTopic.trim()) return;
      setModeConfirmed(true);
    };

    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-md space-y-6">
          <div className="text-center space-y-2">
            <ClipboardList className="w-10 h-10 text-primary mx-auto" />
            <h3 className="text-lg font-semibold text-foreground">Jak chceš vést sezení?</h3>
            <p className="text-sm text-muted-foreground">Zvol režim pro sezení s {clientName}</p>
          </div>
          <RadioGroup
            value={sessionMode ?? ""}
            onValueChange={(v) => setSessionMode(v as SessionMode)}
            className="space-y-3"
          >
            <label className={`flex items-start gap-3 rounded-lg border border-border p-4 cursor-pointer transition-colors hover:bg-accent/50 ${!hasPlan ? "opacity-50 pointer-events-none" : ""}`}>
              <RadioGroupItem value="plan" id="mode-plan" disabled={!hasPlan} className="mt-0.5" />
              <div>
                <Label htmlFor="mode-plan" className="font-medium cursor-pointer">Podle návrhu</Label>
                <p className="text-xs text-muted-foreground mt-0.5">Karel tě provede připraveným plánem fázi po fázi</p>
              </div>
            </label>
            <label className={`flex items-start gap-3 rounded-lg border border-border p-4 cursor-pointer transition-colors hover:bg-accent/50 ${!hasPlan ? "opacity-50 pointer-events-none" : ""}`}>
              <RadioGroupItem value="modify" id="mode-modify" disabled={!hasPlan} className="mt-0.5" />
              <div className="flex-1">
                <Label htmlFor="mode-modify" className="font-medium cursor-pointer">Upravit návrh</Label>
                <p className="text-xs text-muted-foreground mt-0.5">Plán jako základ, ale s tvými úpravami</p>
              </div>
            </label>
            <label className="flex items-start gap-3 rounded-lg border border-border p-4 cursor-pointer transition-colors hover:bg-accent/50">
              <RadioGroupItem value="custom" id="mode-custom" className="mt-0.5" />
              <div>
                <Label htmlFor="mode-custom" className="font-medium cursor-pointer">Vlastní téma</Label>
                <p className="text-xs text-muted-foreground mt-0.5">Zadej téma, na které se chceš zaměřit</p>
              </div>
            </label>
            <label className="flex items-start gap-3 rounded-lg border border-border p-4 cursor-pointer transition-colors hover:bg-accent/50">
              <RadioGroupItem value="free" id="mode-free" className="mt-0.5" />
              <div>
                <Label htmlFor="mode-free" className="font-medium cursor-pointer">Volná asistence</Label>
                <p className="text-xs text-muted-foreground mt-0.5">Karel reaguje na to, co přijde</p>
              </div>
            </label>
          </RadioGroup>
          {sessionMode && (sessionMode === "modify" || sessionMode === "custom") && (
            <Textarea
              value={customTopic}
              onChange={e => setCustomTopic(e.target.value)}
              placeholder={sessionMode === "modify" ? "Jak chceš plán upravit?" : "Na co se chceš zaměřit?"}
              className="min-h-[80px] text-sm"
            />
          )}
          <Button
            className="w-full"
            disabled={!sessionMode || ((sessionMode === "modify" || sessionMode === "custom") && !customTopic.trim())}
            onClick={handleConfirm}
          >
            Začít sezení
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border bg-card/50">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
              <span className="text-sm">🎯</span>
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-foreground">Karel – live sezení</h3>
              <p className="text-xs text-muted-foreground truncate">{clientName}</p>
            </div>
          </div>
          <Button
            variant="destructive"
            size="sm"
            onClick={handleEndSession}
            disabled={isFinishing || messages.length < 2}
            className="gap-1.5 text-xs h-9 shrink-0"
          >
            {isFinishing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <StopCircle className="w-3.5 h-3.5" />}
            <span className="hidden sm:inline">Ukončit a zpracovat</span>
            <span className="sm:hidden">Ukončit</span>
          </Button>
        </div>

        {/* Audio recorder strip */}
        <div className="mt-3 flex items-center gap-2 flex-wrap">
          {recorder.state === "idle" && (
            <Button variant="outline" size="sm" onClick={recorder.startRecording} className="gap-1.5 h-8 text-xs">
              <Mic className="w-3.5 h-3.5" /> Nahrávat
            </Button>
          )}
          {recorder.state === "recording" && (
            <div className="flex items-center gap-2 bg-destructive/5 rounded-lg px-3 py-1.5">
              <div className="w-2 h-2 rounded-full bg-destructive animate-pulse shrink-0" />
              <span className="text-xs font-medium text-destructive tabular-nums">{formatDuration(recorder.duration)}</span>
              <Progress value={Math.min((recorder.duration / recorder.maxDuration) * 100, 100)} className="h-1.5 w-20" />
              <Button variant="ghost" size="sm" onClick={recorder.pauseRecording} className="h-7 w-7 p-0">
                <Pause className="w-3.5 h-3.5" />
              </Button>
              <Button variant="ghost" size="sm" onClick={recorder.stopRecording} className="h-7 w-7 p-0">
                <Square className="w-3 h-3" />
              </Button>
            </div>
          )}
          {recorder.state === "paused" && (
            <div className="flex items-center gap-2 bg-muted/50 rounded-lg px-3 py-1.5">
              <span className="text-xs text-muted-foreground">⏸ {formatDuration(recorder.duration)}</span>
              <Button variant="ghost" size="sm" onClick={recorder.resumeRecording} className="h-7 w-7 p-0">
                <Play className="w-3.5 h-3.5" />
              </Button>
              <Button variant="ghost" size="sm" onClick={recorder.stopRecording} className="h-7 w-7 p-0">
                <Square className="w-3 h-3" />
              </Button>
            </div>
          )}
          {recorder.state === "recorded" && (
            <div className="flex items-center gap-2 flex-wrap">
              {recorder.audioUrl && <audio src={recorder.audioUrl} controls className="h-8 max-w-[180px]" />}
              <Button size="sm" onClick={handleAudioSegmentAnalysis} disabled={isAudioAnalyzing} className="h-8 text-xs gap-1.5">
                {isAudioAnalyzing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                Analyzovat
              </Button>
              <Button variant="ghost" size="sm" onClick={recorder.discardRecording} className="h-8 text-xs">
                Zahodit
              </Button>
            </div>
          )}
          {isAudioAnalyzing && (
            <span className="text-xs text-muted-foreground flex items-center gap-1.5">
              <Loader2 className="w-3 h-3 animate-spin" /> Karel analyzuje…
            </span>
          )}

          {/* Image analysis */}
          <div className="flex items-center gap-2 ml-auto">
            <Select value={imageAnalysisType} onValueChange={setImageAnalysisType}>
              <SelectTrigger className="h-8 w-[140px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="Kresba klienta">Kresba klienta</SelectItem>
                <SelectItem value="Rukopis klienta">Rukopis klienta</SelectItem>
                <SelectItem value="Foto výrazu">Foto výrazu</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              onClick={openFilePicker}
              disabled={isImageAnalyzing}
              className="gap-1.5 h-8 text-xs"
            >
              {isImageAnalyzing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ImagePlus className="w-3.5 h-3.5" />}
              Foto
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              className="hidden"
              onChange={async (e) => {
                handleFileChange(e);
                const file = e.target.files?.[0];
                if (!file) return;
                setIsImageAnalyzing(true);
                try {
                  const reader = new FileReader();
                  const dataUrl = await new Promise<string>((resolve) => {
                    reader.onload = () => resolve(reader.result as string);
                    reader.readAsDataURL(file);
                  });

                  const chatContext = messages.slice(-10).map(m =>
                    `${m.role === "user" ? "TERAPEUT" : "KAREL"}: ${typeof m.content === "string" ? m.content : "(multimodal)"}`
                  ).join("\n");

                  const headers = await getAuthHeaders();
                  const res = await fetch(
                    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-analyze-file`,
                    {
                      method: "POST",
                      headers,
                      body: JSON.stringify({
                        attachments: [{ name: file.name, type: file.type, data: dataUrl }],
                        mode: "supervision",
                        chatContext,
                        userPrompt: `Toto je ${imageAnalysisType} KLIENTA (ne terapeuta). Analyzuj v kontextu live sezení.`,
                      }),
                    }
                  );

                  if (!res.ok) throw new Error("Chyba při analýze");
                  const data = await res.json();
                  const analysis = data.analysis || data.response || "";
                  if (!analysis) throw new Error("Prázdná analýza");

                  const updatedMsgs = [
                    ...messages,
                    { role: "user" as const, content: `🖼️ *[${imageAnalysisType}: ${file.name}]*` },
                    { role: "assistant" as const, content: analysis },
                  ];
                  updateChatMessages(activeSessionId!, updatedMsgs);
                  clearImages();
                  toast.success(`${imageAnalysisType} analyzována`);
                } catch (err) {
                  console.error("Image analysis error:", err);
                  toast.error("Chyba při analýze obrázku");
                } finally {
                  setIsImageAnalyzing(false);
                }
              }}
            />
          </div>
        </div>
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1 px-2 sm:px-4" ref={scrollRef}>
        <div className="max-w-3xl mx-auto py-4 space-y-3">
          {messages.map((msg, i) => (
            <ChatMessage key={i} message={msg} />
          ))}
          {isLoading && messages[messages.length - 1]?.role === "user" && (
            <div className="flex justify-start">
              <div className="chat-message-assistant">
                <Loader2 className="w-4 h-4 animate-spin text-primary" />
              </div>
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Input */}
      <div className="border-t border-border bg-card/50 backdrop-blur-sm">
        <div className="max-w-3xl mx-auto px-3 sm:px-4 py-3">
          <div className="flex gap-2 items-end">
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendMessage();
                }
              }}
              placeholder="Co klient říká / dělá..."
              className="flex-1 min-w-0 min-h-[44px] max-h-[120px] resize-none text-sm"
              disabled={isLoading || isFinishing}
            />
            <Button
              size="icon"
              onClick={sendMessage}
              disabled={!input.trim() || isLoading || isFinishing}
              className="h-[44px] w-[44px] shrink-0"
            >
              {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </Button>
          </div>
        </div>
      </div>

      {isFinishing && (
        <div className="absolute inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="text-center space-y-4 p-8 max-w-sm">
            <Loader2 className="w-10 h-10 animate-spin text-primary mx-auto" />
            <div>
              <p className="text-sm font-semibold text-foreground">Karel zpracovává sezení…</p>
              <p className="text-xs text-muted-foreground mt-1">Generuji profesionální zápis, návrh na příští sezení a doporučení.</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default LiveSessionPanel;

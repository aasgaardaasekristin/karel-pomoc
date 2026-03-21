import { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Send, Loader2, Square, Mic, Pause, Play, StopCircle, ArrowLeft, Camera, X } from "lucide-react";
import { getAuthHeaders } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import ChatMessage from "@/components/ChatMessage";
import { useSessionAudioRecorder } from "@/hooks/useSessionAudioRecorder";
import { useImageUpload } from "@/hooks/useImageUpload";
import { Progress } from "@/components/ui/progress";

type Message = { role: "user" | "assistant"; content: string };

const formatDuration = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
};

interface DidLiveSessionPanelProps {
  partName: string;
  therapistName: string; // "Hanka" or "Káťa"
  contextBrief?: string;
  onEnd: (summary: string) => void;
  onBack: () => void;
}

/**
 * Live DID Session Panel
 * Karel advises the therapist in real-time during work with a DID part.
 * Similar to LiveSessionPanel but with DID-specific context and prompts.
 */
const DidLiveSessionPanel = ({ partName, therapistName, contextBrief, onEnd, onBack }: DidLiveSessionPanelProps) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isFinishing, setIsFinishing] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const recorder = useSessionAudioRecorder();
  const imageUpload = useImageUpload();
  const [isAudioAnalyzing, setIsAudioAnalyzing] = useState(false);
  const [isImageAnalyzing, setIsImageAnalyzing] = useState(false);
  const audioSegmentCountRef = useRef(0);
  const imageSegmentCountRef = useRef(0);

  // Auto-greet
  useEffect(() => {
    if (messages.length === 0) {
      const greeting = `${therapistName === "Káťa" ? "Káťo" : "Hani"}, jsem tu s tebou na živém sezení s **${partName}**. 🎯

Piš mi, co ${partName} říká nebo dělá, a já ti v reálném čase poradím jak reagovat. Můžeš také:
- 🎙️ **Nahrát audio** — analyzuji tón, emoce, switching
- 📷 **Vyfotit obrázek** — kresbu, výraz, situaci — okamžitě zanalyzuji

${contextBrief ? `📋 *Mám nastudovaný kontext – vím, kde jsme naposledy skončili.*` : ""}

*Začni kdykoliv – jsem připravený.*`;
      setMessages([{ role: "assistant", content: greeting }]);
    }
  }, []);

  // Scroll to bottom
  useEffect(() => {
    const viewport = scrollRef.current?.querySelector("[data-radix-scroll-area-viewport]") as HTMLDivElement | null;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [messages]);

  const buildContext = useCallback(() => {
    return `═══ LIVE DID SEZENÍ ═══
Část: ${partName}
Terapeutka: ${therapistName}
Čas: ${new Date().toISOString()}

${contextBrief ? `KONTEXT Z KARTOTÉKY:\n${contextBrief.slice(0, 3000)}\n` : ""}
═══ INSTRUKCE ═══
- Jsi Karel, kognitivní agent PŘÍTOMNÝ na živém sezení s DID částí "${partName}".
- ${therapistName} ti píše, co ${partName} říká/dělá, nebo posílá audio segmenty.
- Odpovídej OKAMŽITĚ a STRUČNĚ (3-5 řádků max):
  🎯 Co říct ${partName} (přesná věta, respektuj jazyk a věk části)
  👀 Na co si dát pozor (neverbální signály, switching, disociace)
  ⚠️ Rizika/varování (trigger, freeze, regrese)
  🎮 Další krok (technika, aktivita, uklidnění)
- Pokud dostaneš audio analýzu, reaguj na zjištění z hlasu (tenze, emoce, switching).
- Buď direktivní a konkrétní. Žádné filozofování.
- Respektuj věk a vývojovou úroveň části.
- Při známkách distresu nebo switchingu OKAMŽITĚ upozorni.`;
  }, [partName, therapistName, contextBrief]);

  const sendMessage = async () => {
    if (!input.trim() || isLoading) return;
    const userMessage = input.trim();
    setInput("");

    const updatedMessages = [...messages, { role: "user" as const, content: userMessage }];
    setMessages(updatedMessages);
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
      setMessages([...updatedMessages, { role: "assistant", content: "" }]);

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
              setMessages([...updatedMessages, { role: "assistant", content: assistantContent }]);
            }
          } catch {
            buffer = line + "\n" + buffer;
            break;
          }
        }
      }
    } catch (error) {
      console.error("DID Live session error:", error);
      toast.error("Chyba při komunikaci s Karlem");
      if (!assistantContent) setMessages(messages);
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
            mode: "did-live-session",
            chatContext,
            clientName: partName,
            extraContext: `DID část: ${partName}, Terapeutka: ${therapistName}`,
          }),
        }
      );

      if (!response.ok) throw new Error("Chyba při analýze");
      const { analysis } = await response.json();
      if (!analysis) throw new Error("Prázdná analýza");

      setMessages(prev => [
        ...prev,
        { role: "user", content: `🎙️ *[Audio segment #${segNum} – ${formatDuration(recorder.duration)}]*` },
        { role: "assistant", content: analysis },
      ]);
      recorder.reset();
      toast.success(`Audio segment #${segNum} analyzován`);
    } catch (error) {
      console.error("Audio analysis error:", error);
      toast.error("Chyba při analýze audia");
    } finally {
      setIsAudioAnalyzing(false);
    }
  };

  // Image analysis
  const handleImageAnalysis = async () => {
    if (isImageAnalyzing || imageUpload.pendingImages.length === 0) return;
    setIsImageAnalyzing(true);
    try {
      const img = imageUpload.pendingImages[0];
      imageSegmentCountRef.current += 1;
      const segNum = imageSegmentCountRef.current;

      const chatContext = messages.slice(-6).map(m =>
        `${m.role === "user" ? "TERAPEUT" : "KAREL"}: ${typeof m.content === "string" ? m.content.slice(0, 200) : "(multimodal)"}`
      ).join("\n");

      const headers = await getAuthHeaders();
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-analyze-file`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            fileBase64: img.dataUrl,
            fileName: img.name,
            mode: "did-live-session",
            chatContext,
            extraContext: `DID část: ${partName}, Terapeutka: ${therapistName}. Analyzuj obrázek v kontextu živého sezení — zaměř se na emoční výraz, kresbu, neverbální signály, známky distresu nebo switchingu.`,
          }),
        }
      );

      if (!response.ok) throw new Error("Chyba při analýze obrázku");
      const { analysis } = await response.json();
      if (!analysis) throw new Error("Prázdná analýza");

      setMessages(prev => [
        ...prev,
        { role: "user", content: `📷 *[Obrázek #${segNum}: ${img.name}]*` },
        { role: "assistant", content: analysis },
      ]);
      imageUpload.clearImages();
      toast.success(`Obrázek #${segNum} analyzován`);
    } catch (error) {
      console.error("Image analysis error:", error);
      toast.error("Chyba při analýze obrázku");
    } finally {
      setIsImageAnalyzing(false);
    }
  };

  // End session — generate analysis + save to did_part_sessions
  const handleEndSession = async () => {
    if (messages.length < 2) {
      toast.error("Sezení je prázdné.");
      return;
    }
    setIsFinishing(true);
    try {
      const headers = await getAuthHeaders();

      // Collect all audio analysis messages
      const audioAnalyses = messages
        .filter(m => m.role === "assistant" && messages[messages.indexOf(m) - 1]?.content?.includes("🎙️"))
        .map(m => m.content);

      // Build finalization prompt
      const finalizationPrompt = `Sezení s částí "${partName}" (terapeutka: ${therapistName}) právě skončilo. 

CELÝ PRŮBĚH SEZENÍ:
${messages.map(m => `${m.role === "user" ? "TERAPEUT" : "KAREL"}: ${m.content}`).join("\n")}

${audioAnalyses.length > 0 ? `AUDIO ANALÝZY ZE SEZENÍ:\n${audioAnalyses.join("\n---\n")}` : ""}

VYGENERUJ STRUKTUROVANOU ANALÝZU v tomto formátu:

## ZÁPIS_SEZENÍ
Profesionální klinický zápis (co se dělo, jak část reagovala, klíčové momenty).

## STAV_ČÁSTI
Jak na tom část byla — emoční stav, ochota spolupracovat, případná regrese nebo posun.

## POUŽITÉ_METODY
Seznam metod/technik které se během sezení použily (každá na řádek).

## EFEKTIVITA_METOD
Pro každou metodu: fungovala (✅), částečně (⚠️), nefungovala (❌) + krátké vysvětlení.

## FEEDBACK_TERAPEUT
Karlovo hodnocení práce ${therapistName} — co udělala dobře, co příště zlepšit, konkrétní rady.

## ÚKOLY
Konkrétní úkoly pro tým (kdo, co, kdy):
- Pro ${therapistName}: ...
- Pro druhou terapeutku: ...
- Pro Karla: ...

## DOPORUČENÍ_PŘÍŠTĚ
Co dělat na příštím sezení, jaké metody zkusit, na co si dát pozor.

Piš jako Karel — osobně, angažovaně, profesionálně. Buď konkrétní.`;

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-chat`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            messages: [
              ...messages,
              { role: "user", content: finalizationPrompt },
            ],
            mode: "supervision",
            didInitialContext: buildContext(),
          }),
        }
      );

      if (!response.ok || !response.body) throw new Error("Chyba");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let report = "";

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
            if (content) report += content;
          } catch {
            buffer = line + "\n" + buffer;
            break;
          }
        }
      }

      // Parse methods from report
      const methodsMatch = report.match(/## POUŽITÉ_METODY\n([\s\S]*?)(?=\n## |$)/);
      const methodsUsed = methodsMatch
        ? methodsMatch[1].split("\n").map(l => l.replace(/^[-•*]\s*/, "").trim()).filter(Boolean)
        : [];

      // Parse effectiveness
      const effMatch = report.match(/## EFEKTIVITA_METOD\n([\s\S]*?)(?=\n## |$)/);
      const effectiveness: Record<string, string> = {};
      if (effMatch) {
        effMatch[1].split("\n").filter(l => l.trim()).forEach(l => {
          const clean = l.replace(/^[-•*]\s*/, "").trim();
          if (clean.includes("✅")) effectiveness[clean.split("✅")[0].trim()] = "effective";
          else if (clean.includes("⚠️")) effectiveness[clean.split("⚠️")[0].trim()] = "partial";
          else if (clean.includes("❌")) effectiveness[clean.split("❌")[0].trim()] = "ineffective";
        });
      }

      // Parse therapist feedback
      const feedbackMatch = report.match(/## FEEDBACK_TERAPEUT\n([\s\S]*?)(?=\n## |$)/);
      const therapistFeedback = feedbackMatch ? feedbackMatch[1].trim() : "";

      // Parse tasks
      const tasksMatch = report.match(/## ÚKOLY\n([\s\S]*?)(?=\n## |$)/);
      const tasksText = tasksMatch ? tasksMatch[1].trim() : "";
      const tasksList = tasksText.split("\n").map(l => l.replace(/^[-•*]\s*/, "").trim()).filter(Boolean);

      // Save to did_part_sessions
      try {
        await supabase.from("did_part_sessions").insert({
          part_name: partName,
          therapist: therapistName,
          session_type: "live",
          ai_analysis: report,
          methods_used: methodsUsed,
          methods_effectiveness: effectiveness,
          tasks_assigned: tasksList,
          audio_analysis: audioAnalyses.join("\n---\n") || "",
          karel_notes: report,
          karel_therapist_feedback: therapistFeedback,
        });
        console.log("Session saved to did_part_sessions");
      } catch (saveErr) {
        console.error("Failed to save session:", saveErr);
      }

      // Update part registry with latest contact
      try {
        await supabase.from("did_part_registry").update({
          last_seen_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq("part_name", partName);
      } catch {}

      toast.success("Sezení uloženo a analyzováno");
      onEnd(report || "Zápis nebyl vygenerován.");
    } catch (error) {
      console.error("DID Live session finalize error:", error);
      toast.error("Chyba při zpracování sezení");
    } finally {
      setIsFinishing(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border bg-card/50">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <Button variant="ghost" size="icon" onClick={onBack} className="h-8 w-8 shrink-0">
              <ArrowLeft className="w-4 h-4" />
            </Button>
            <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
              <span className="text-sm">🧩</span>
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-foreground">Live DID sezení</h3>
              <p className="text-xs text-muted-foreground truncate">{partName} • {therapistName}</p>
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
            <span className="hidden sm:inline">Ukončit a analyzovat</span>
            <span className="sm:hidden">Ukončit</span>
          </Button>
        </div>

        {/* Audio & Image tools strip */}
        <div className="mt-3 flex items-center gap-2 flex-wrap">
          {/* Camera button */}
          <Button variant="outline" size="sm" onClick={imageUpload.openFilePicker} className="gap-1.5 h-8 text-xs">
            <Camera className="w-3.5 h-3.5" /> Fotka
          </Button>
          <input
            ref={imageUpload.fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            multiple
            onChange={imageUpload.handleFileChange}
            className="hidden"
          />

          {/* Audio recorder */}
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
              <Loader2 className="w-3 h-3 animate-spin" /> Karel analyzuje audio…
            </span>
          )}
          {isImageAnalyzing && (
            <span className="text-xs text-muted-foreground flex items-center gap-1.5">
              <Loader2 className="w-3 h-3 animate-spin" /> Karel analyzuje obrázek…
            </span>
          )}
        </div>

        {/* Image preview strip */}
        {imageUpload.pendingImages.length > 0 && (
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            {imageUpload.pendingImages.map((img, i) => (
              <div key={i} className="relative group">
                <img src={img.dataUrl} alt={img.name} className="h-16 w-16 object-cover rounded-md border border-border" />
                <button
                  onClick={() => imageUpload.removeImage(i)}
                  className="absolute -top-1.5 -right-1.5 bg-destructive text-destructive-foreground rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
            <Button size="sm" onClick={handleImageAnalysis} disabled={isImageAnalyzing} className="h-8 text-xs gap-1.5">
              {isImageAnalyzing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
              Analyzovat obrázek
            </Button>
            <Button variant="ghost" size="sm" onClick={imageUpload.clearImages} className="h-8 text-xs">
              Zahodit
            </Button>
          </div>
        )}
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
              placeholder={`Co ${partName} říká / dělá...`}
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
              <p className="text-sm font-semibold text-foreground">Karel analyzuje sezení a ukládá do karty…</p>
              <p className="text-xs text-muted-foreground mt-1">Generuji klinický zápis, hodnotím metody, zapisuji úkoly a zpětnou vazbu pro {therapistName}.</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default DidLiveSessionPanel;

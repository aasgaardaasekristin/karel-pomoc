import { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Send, Loader2, MessageSquareMore, FileText } from "lucide-react";
import { useUniversalUpload, buildAttachmentContent } from "@/hooks/useUniversalUpload";
import UniversalAttachmentBar from "@/components/UniversalAttachmentBar";
import GoogleDrivePickerDialog from "@/components/GoogleDrivePickerDialog";
import { useAudioRecorder } from "@/hooks/useAudioRecorder";
import AudioRecordButton from "@/components/AudioRecordButton";
import { getAuthHeaders } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useActiveSessions } from "@/contexts/ActiveSessionsContext";
import ChatMessage from "@/components/ChatMessage";

type Message = { role: "user" | "assistant"; content: string };

/** Build a snapshot string from current form data */
const buildFormSnapshot = (fd: any, clientName: string) => {
  const name = fd.isMinor
    ? (fd.childFullName || fd.contactFullName || clientName)
    : (fd.contactFullName || clientName);
  const age = fd.clientAge || "neuvedeno";

  return [
    `Jméno klienta: ${name}`,
    `Věk: ${age}`,
    `Nezletilý: ${fd.isMinor ? "ano" : "ne"}`,
    fd.contactFullName && `Kontakt: ${fd.contactFullName}`,
    fd.contactEmail && `Email: ${fd.contactEmail}`,
    fd.contactPhone && `Telefon: ${fd.contactPhone}`,
    fd.isMinor && fd.childFullName && `Dítě: ${fd.childFullName}`,
    fd.isMinor && fd.guardianFullName && `Zákonný zástupce: ${fd.guardianFullName}`,
    fd.context && `Kontext: ${fd.context}`,
    fd.keyTheme && `Téma: ${fd.keyTheme}`,
    fd.risks?.length > 0 && `Rizika: ${fd.risks.join(", ")}${fd.risksOther ? `, ${fd.risksOther}` : ""}`,
    fd.therapistEmotions?.length > 0 && `Emoce terapeuta: ${fd.therapistEmotions.join(", ")}${fd.therapistEmotionsOther ? `, ${fd.therapistEmotionsOther}` : ""}`,
    fd.transference && `Přenos: ${fd.transference}`,
    fd.missingData && `Ověřit: ${fd.missingData}`,
    fd.interventionsTried && `Intervence: ${fd.interventionsTried}`,
    fd.nextSessionGoal && `Cíl: ${fd.nextSessionGoal}`,
  ].filter(Boolean).join("\n");
};

/** Build the runtime context sent as didInitialContext */
const buildRuntimeContext = (fd: any, clientName: string, deepMode: boolean) => {
  const snapshot = buildFormSnapshot(fd, clientName);

  if (deepMode) {
    return `═══ HLOUBKOVÁ REFLEXE PO SEZENÍ ═══

Čas: ${new Date().toISOString()}

📋 FORM SNAPSHOT:
${snapshot || "(prázdný)"}

═══ INSTRUKCE (HLOUBKOVÝ REŽIM) ═══
- Nyní jsi supervizor v režimu post-session reflexe.
- Odpovídej podrobněji: diagnózy, diferenciální diagnostika, terapeutické hypotézy, doporučené metody, co příště jinak.
- Piš 5–10 vět, používej odstavce. Můžeš klást doplňující otázky.
- Stále čti formulář jako zdroj pravdy (jméno, věk, kontext).`;
  }

  return `═══ LIVE SUPERVIZE – RUNTIME KONTEXT ═══

Čas: ${new Date().toISOString()}

🔒 ZDROJ PRAVDY = FORMULÁŘ. Ignoruj starší text v konfliktu s formulářem.
🔒 NIKDY nevymýšlej jiné jméno ani věk. Když chybí, napiš "není ve formuláři".

📋 FORM SNAPSHOT:
${snapshot || "(formulář je zatím prázdný)"}

═══ INSTRUKCE (PŘÍSNÉ) ═══
- Jsi praktický klinický supervizor BĚHEM probíhajícího sezení.
- Odpověz 3–4 krátkými řádky, emoji: 🎯 🎮 ⚠️ 👀
- Každý řádek max 14 slov.
- Dávej PŘESNOU větu k použití + konkrétní činnost + pokyn k neverbálu.
- Pokud vidíš nový údaj ve formuláři, okamžitě reaguj: co dál dělat, říct, pozorovat.
- Žádné analýzy, žádné filozofie. Pouze akční pokyny.`;
};

const SupervisionChat = () => {
  const {
    activeSession,
    activeSessionId,
    updateChatMessages,
    removeSession,
  } = useActiveSessions();

  const [input, setInput] = useState("");
  const { attachments, fileInputRef, openFilePicker, handleFileChange, removeAttachment, clearAttachments, captureScreenshot, addAttachment, processFile } = useUniversalUpload();
  const [driveOpen, setDriveOpen] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const audioRecorder = useAudioRecorder();
  const [isAudioAnalyzing, setIsAudioAnalyzing] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isGeneratingReport, setIsGeneratingReport] = useState(false);
  const [deepMode, setDeepMode] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const formSnapshotRef = useRef<string>("");
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isLoadingRef = useRef(false);

  // Keep isLoadingRef in sync
  useEffect(() => { isLoadingRef.current = isLoading; }, [isLoading]);

  const messages = activeSession?.chatMessages ?? [];

  // Scroll to bottom on new messages
  useEffect(() => {
    const viewport = scrollRef.current?.querySelector("[data-radix-scroll-area-viewport]") as HTMLDivElement | null;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [messages]);

  // Auto-greet
  useEffect(() => {
    if (activeSession && messages.length === 0) {
      const greeting = `Hani, jedeme supervizi pro **${activeSession.clientName}**.\n\nVyplňuj formulář vlevo – čtu ho v reálném čase a hned reaguji. Začni psát a já ti řeknu co dál.`;
      updateChatMessages(activeSession.id, [{ role: "assistant", content: greeting }]);
    }
  }, [activeSession?.id]);

  // ──────────────────────────────────────────────
  // AUTO-REACT TO FORM CHANGES (debounced 1.5s)
  // ──────────────────────────────────────────────
  const sendFormUpdate = useCallback(async (currentMessages: Message[], fd: any, clientName: string, sessionId: string) => {
    if (isLoadingRef.current) return;

    const snapshot = buildFormSnapshot(fd, clientName);
    // Skip if snapshot hasn't meaningfully changed
    if (snapshot === formSnapshotRef.current) return;
    // Skip if form is essentially empty
    const nonEmpty = [fd.contactFullName, fd.childFullName, fd.clientAge, fd.context, fd.keyTheme].filter(Boolean);
    if (nonEmpty.length === 0) return;

    formSnapshotRef.current = snapshot;
    isLoadingRef.current = true;

    // Add a system-like user message that Karel sees as form update
    const formUpdateMsg: Message = {
      role: "user",
      content: `[FORMULÁŘ AKTUALIZOVÁN]\n${snapshot}`,
    };
    const updatedMessages = [...currentMessages, formUpdateMsg];
    updateChatMessages(sessionId, updatedMessages);

    let assistantContent = "";
    try {
      const headers = await getAuthHeaders();
      const context = buildRuntimeContext(fd, clientName, false);

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-chat`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            messages: updatedMessages,
            mode: "supervision",
            didInitialContext: context,
          }),
        }
      );

      if (!response.ok || !response.body) throw new Error("Chyba");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const withAssistant = [...updatedMessages, { role: "assistant" as const, content: "" }];
      updateChatMessages(sessionId, withAssistant);

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
              updateChatMessages(sessionId, [...updatedMessages, { role: "assistant" as const, content: assistantContent }]);
            }
          } catch {
            buffer = line + "\n" + buffer;
            break;
          }
        }
      }
    } catch (error) {
      console.error("Form auto-react error:", error);
      if (!assistantContent) {
        updateChatMessages(sessionId, currentMessages);
      }
    } finally {
      isLoadingRef.current = false;
    }
  }, [updateChatMessages]);

  // Watch form data changes and auto-trigger Karel
  useEffect(() => {
    if (!activeSession || !activeSessionId) return;
    if (messages.length === 0) return; // wait for greeting first

    const newSnapshot = buildFormSnapshot(activeSession.formData, activeSession.clientName);
    if (newSnapshot === formSnapshotRef.current) return;

    // Debounce: wait 1.5s after last change before sending
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      sendFormUpdate(messages, activeSession.formData, activeSession.clientName, activeSessionId);
    }, 1500);

    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [activeSession?.formData, activeSessionId, messages, sendFormUpdate]);

  // Initialize snapshot ref on session load
  useEffect(() => {
    if (activeSession) {
      formSnapshotRef.current = buildFormSnapshot(activeSession.formData, activeSession.clientName);
    }
  }, [activeSession?.id]);

  if (!activeSession || !activeSessionId) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm p-8 text-center">
        <div>
          <p className="text-lg mb-2">👈</p>
          <p>Vyber nebo zahaj sezení v postranním panelu.</p>
        </div>
      </div>
    );
  }

  // ──────────────────────────────────────────────
  // MANUAL SEND (chat input)
  // ──────────────────────────────────────────────
  const sendMessage = async () => {
    if ((!input.trim() && attachments.length === 0) || isLoading) return;

    const userMessage = input.trim();
    const currentAttachments = [...attachments];
    setInput("");
    clearAttachments();

    const userContent = buildAttachmentContent(userMessage, currentAttachments);
    const updatedMessages = [...messages, { role: "user" as const, content: userContent as any }];
    updateChatMessages(activeSessionId, updatedMessages);
    setIsLoading(true);

    let assistantContent = "";

    try {
      const headers = await getAuthHeaders();
      const context = buildRuntimeContext(activeSession.formData, activeSession.clientName, deepMode);

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-chat`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            messages: updatedMessages,
            mode: "supervision",
            didInitialContext: context,
          }),
        }
      );

      if (!response.ok || !response.body) throw new Error("Chyba komunikace");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const withAssistant = [...updatedMessages, { role: "assistant" as const, content: "" }];
      updateChatMessages(activeSessionId, withAssistant);

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
              updateChatMessages(activeSessionId, [...updatedMessages, { role: "assistant" as const, content: assistantContent }]);
            }
          } catch {
            buffer = line + "\n" + buffer;
            break;
          }
        }
      }
    } catch (error) {
      console.error("Supervision chat error:", error);
      toast.error("Chyba při komunikaci s Karlem");
      if (!assistantContent) {
        updateChatMessages(activeSessionId, messages);
      }
    } finally {
      setIsLoading(false);
      textareaRef.current?.focus();
    }
  };

  // ──────────────────────────────────────────────
  // ARCHIVE TO KARTOTÉKA
  // ──────────────────────────────────────────────
  const handleGenerateAndArchive = async () => {
    if (messages.length < 2) {
      toast.error("Chat je prázdný – nejdřív veď supervizi.");
      return;
    }

    setIsGeneratingReport(true);
    try {
      const headers = await getAuthHeaders();

      // Step 1: Generate comprehensive report via AI
      const reportResponse = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-session-report`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            chatMessages: messages,
            formData: activeSession.formData,
            clientName: activeSession.clientName,
          }),
        }
      );

      if (!reportResponse.ok) throw new Error("Chyba při generování reportu");
      const { report } = await reportResponse.json();

      if (!report) throw new Error("Report je prázdný");

      // Step 2: Save to kartoteka
      const { count } = await supabase
        .from("client_sessions")
        .select("id", { count: "exact", head: true })
        .eq("client_id", activeSession.clientId);

      const fd = activeSession.formData;
      const chatTranscript = messages
        .map(m => `${m.role === "user" ? "TERAPEUT" : "KAREL"}: ${m.content}`)
        .join("\n\n");

      const { error } = await supabase
        .from("client_sessions")
        .insert({
          client_id: activeSession.clientId,
          session_number: (count ?? 0) + 1,
          report_context: fd.context,
          report_key_theme: fd.keyTheme,
          report_therapist_emotions: fd.therapistEmotions,
          report_transference: fd.transference,
          report_risks: fd.risks,
          report_missing_data: fd.missingData,
          report_interventions_tried: fd.interventionsTried,
          report_next_session_goal: fd.nextSessionGoal,
          ai_analysis: report,
          ai_hypotheses: chatTranscript,
          notes: [
            fd.contactFullName && `Kontakt: ${fd.contactFullName}`,
            fd.contactEmail && `Email: ${fd.contactEmail}`,
            fd.contactPhone && `Tel: ${fd.contactPhone}`,
            fd.isMinor && fd.childFullName && `Dítě: ${fd.childFullName}`,
            fd.isMinor && fd.guardianFullName && `Zástupce: ${fd.guardianFullName}`,
          ].filter(Boolean).join("\n"),
        });

      if (error) throw error;

      toast.success(`Komplexní report uložen do kartotéky: ${activeSession.clientName}`);
      removeSession(activeSessionId);
    } catch (error) {
      console.error("Generate & archive error:", error);
      toast.error("Nepodařilo se vygenerovat/uložit report");
    } finally {
      setIsGeneratingReport(false);
    }
  };

  const handleAudioAnalysis = async () => {
    if (isAudioAnalyzing || !activeSessionId) return;
    setIsAudioAnalyzing(true);
    try {
      const base64 = await audioRecorder.getBase64();
      if (!base64) throw new Error("Žádná nahrávka");

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
            mode: "supervision",
            chatContext: messages.length > 0 ? chatContext : undefined,
          }),
        }
      );

      if (!response.ok) throw new Error("Chyba při analýze");
      const { analysis } = await response.json();
      if (!analysis) throw new Error("Prázdná analýza");

      const updatedMessages = [
        ...messages,
        { role: "user" as const, content: "🎙️ *[Audio nahrávka odeslána k analýze]*" },
        { role: "assistant" as const, content: analysis },
      ];
      updateChatMessages(activeSessionId, updatedMessages);
      audioRecorder.discardRecording();
      toast.success("Audio analýza dokončena");
    } catch (error) {
      console.error("Audio analysis error:", error);
      toast.error(error instanceof Error ? error.message : "Chyba při analýze audia");
    } finally {
      setIsAudioAnalyzing(false);
    }
  };

  const handleAutoAnalyze = async () => {
    if (attachments.length === 0 || isAnalyzing) return;
    setIsAnalyzing(true);
    try {
      const headers = await getAuthHeaders();
      const fileDescriptions = attachments.map(a =>
        `${a.name} (${a.type}, ${a.category})${a.storagePath ? ` [storage:${a.storagePath}]` : ""}${a.dataUrl ? " [inline]" : ""}`
      ).join(", ");

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-analyze-file`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            attachments: attachments.map(a => ({
              name: a.name,
              type: a.type,
              category: a.category,
              size: a.size,
              dataUrl: a.dataUrl,
              storagePath: a.storagePath,
              driveFileId: a.driveFileId,
            })),
            mode: "supervision",
            chatContext: messages.slice(-6).map(m =>
              `${m.role === "user" ? "TERAPEUT" : "KAREL"}: ${typeof m.content === "string" ? m.content.slice(0, 200) : "(multimodal)"}`
            ).join("\n"),
          }),
        }
      );

      if (!response.ok) throw new Error("Chyba při analýze");
      const { analysis } = await response.json();
      if (!analysis) throw new Error("Prázdná analýza");

      const updatedMessages = [
        ...messages,
        { role: "user" as const, content: `📎 *[Auto-analýza: ${fileDescriptions}]*` },
        { role: "assistant" as const, content: analysis },
      ];
      updateChatMessages(activeSessionId, updatedMessages);
      clearAttachments();
      toast.success("Analýza dokončena");
    } catch (error) {
      console.error("Auto-analyze error:", error);
      toast.error("Chyba při automatické analýze");
    } finally {
      setIsAnalyzing(false);
    }
  };

  const toggleDeepMode = () => {
    setDeepMode(prev => {
      const next = !prev;
      if (next) {
        toast.info("🔬 Hloubkový režim zapnut – Karel bude odpovídat podrobněji");
      } else {
        toast.info("⚡ Rychlý supervizní režim – stručné akční pokyny");
      }
      return next;
    });
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="p-2 md:p-3 border-b border-border bg-card/30">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h3 className="text-xs md:text-sm font-semibold text-foreground truncate">
              Karel – {deepMode ? "🔬 reflexe" : "⚡ supervize"}
            </h3>
            <p className="text-[10px] md:text-xs text-muted-foreground truncate">{activeSession.clientName}</p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <Button
              size="sm"
              variant={deepMode ? "default" : "outline"}
              onClick={toggleDeepMode}
              className="gap-1 text-[10px] md:text-xs h-7 md:h-8 px-2 md:px-3"
              title={deepMode ? "Přepnout na rychlou supervizi" : "Probrat detailněji – diagnózy, metody, reflexe"}
            >
              <MessageSquareMore className="w-3 h-3" />
              <span className="hidden sm:inline">{deepMode ? "Rychle" : "Detailně"}</span>
            </Button>
          </div>
        </div>
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1" ref={scrollRef}>
        <div className="p-3 space-y-3">
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

          {/* Generate comprehensive report button - shown after some chat */}
          {messages.length >= 3 && !isGeneratingReport && (
            <div className="flex justify-center pt-4 pb-2">
              <Button
                onClick={handleGenerateAndArchive}
                disabled={isGeneratingReport || isLoading}
                className="gap-2 text-xs md:text-sm"
                size="sm"
              >
                <FileText className="w-4 h-4" />
                📋 Komplexní report → Kartotéka
              </Button>
            </div>
          )}
          {isGeneratingReport && (
            <div className="flex justify-center pt-4 pb-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground bg-secondary/50 rounded-lg px-4 py-3">
                <Loader2 className="w-4 h-4 animate-spin text-primary" />
                Generuji komplexní report a ukládám do kartotéky...
              </div>
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Input */}
      <div className="p-3 border-t border-border">
        {/* Row 1: Text input + send */}
        <div className="flex gap-2 items-end relative">
          <UniversalAttachmentBar
            attachments={attachments}
            onRemove={removeAttachment}
            onOpenFilePicker={openFilePicker}
            onCaptureScreenshot={captureScreenshot}
            onOpenDrivePicker={() => setDriveOpen(true)}
            onAutoAnalyze={handleAutoAnalyze}
            disabled={isLoading}
            fileInputRef={fileInputRef as React.RefObject<HTMLInputElement>}
            onFileChange={handleFileChange}
            isAnalyzing={isAnalyzing}
          />
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
            placeholder={deepMode ? "Zeptej se Karla na diagnózu, metody, reflexi..." : "Napiš co klient říká / dělá..."}
            className="flex-1 min-w-0 min-h-[40px] max-h-[100px] resize-none text-sm"
            disabled={isLoading}
          />
          <Button
            size="icon"
            onClick={sendMessage}
            disabled={(!input.trim() && attachments.length === 0) || isLoading}
            className="h-[40px] w-[40px] shrink-0"
          >
            {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </Button>
        </div>
        {/* Row 2: Audio */}
        <div className="flex items-center gap-2 flex-wrap mt-2">
          <AudioRecordButton
            state={audioRecorder.state}
            duration={audioRecorder.duration}
            maxDuration={audioRecorder.maxDuration}
            audioUrl={audioRecorder.audioUrl}
            isAnalyzing={isAudioAnalyzing}
            onStart={audioRecorder.startRecording}
            onStop={audioRecorder.stopRecording}
            onDiscard={audioRecorder.discardRecording}
            onSend={handleAudioAnalysis}
            disabled={isLoading}
          />
        </div>
      </div>
      <GoogleDrivePickerDialog
        open={driveOpen}
        onClose={() => setDriveOpen(false)}
        onFileSelected={(file) => {
          addAttachment(file);
          setDriveOpen(false);
        }}
      />
    </div>
  );
};

export default SupervisionChat;

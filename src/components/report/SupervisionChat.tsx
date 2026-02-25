import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Send, Loader2, Archive, CheckCircle } from "lucide-react";
import { getAuthHeaders } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useActiveSessions } from "@/contexts/ActiveSessionsContext";
import ChatMessage from "@/components/ChatMessage";
import ReactMarkdown from "react-markdown";

const SupervisionChat = () => {
  const {
    activeSession,
    activeSessionId,
    updateChatMessages,
    updateStatus,
    removeSession,
  } = useActiveSessions();

  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const messages = activeSession?.chatMessages ?? [];

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Auto-greet when session starts with no messages
  useEffect(() => {
    if (activeSession && messages.length === 0) {
      const greeting = `Hani, jsem připravený. Pracujeme na sezení s klientem **${activeSession.clientName}**.\n\nMůžeš začít vyplňovat formulář vlevo – já tě budu průběžně vést. Napiš mi cokoliv, co tě napadne, a já navrhnu otázky, techniky nebo hry pro sezení. 🎯`;
      updateChatMessages(activeSession.id, [{ role: "assistant", content: greeting }]);
    }
  }, [activeSession?.id]);

  if (!activeSession || !activeSessionId) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm p-8 text-center">
        <div>
          <p className="text-lg mb-2">👈</p>
          <p>Vyber nebo zahaj sezení v postranním panelu.</p>
          <p className="text-xs mt-1">Karel bude připravený supervizně vést sezení.</p>
        </div>
      </div>
    );
  }

  const sendMessage = async () => {
    if (!input.trim() || isLoading) return;

    const userMessage = input.trim();
    setInput("");

    const updatedMessages = [...messages, { role: "user" as const, content: userMessage }];
    updateChatMessages(activeSessionId, updatedMessages);
    setIsLoading(true);

    let assistantContent = "";

    try {
      const headers = await getAuthHeaders();

      // Build context from form data
      const formContext = activeSession.formData;
      const formSummary = [
        formContext.context && `Kontext: ${formContext.context}`,
        formContext.keyTheme && `Téma: ${formContext.keyTheme}`,
        formContext.therapistEmotions.length > 0 && `Emoce: ${formContext.therapistEmotions.join(", ")}`,
        formContext.transference && `Přenos: ${formContext.transference}`,
        formContext.risks.length > 0 && `Rizika: ${formContext.risks.join(", ")}`,
        formContext.interventionsTried && `Intervence: ${formContext.interventionsTried}`,
      ].filter(Boolean).join("\n");

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-chat`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            messages: updatedMessages,
            mode: "kartoteka",
            didInitialContext: `═══ ŽIVÁ SUPERVIZE BĚHEM SEZENÍ ═══\nKlient: ${activeSession.clientName}\n\nAktuální formulář:\n${formSummary}\n\n${activeSession.reportText ? `Vygenerovaný report:\n${activeSession.reportText}` : ""}\n\nKarel je v režimu živé supervize – navrhuje otázky, hry, techniky, diagnostické metody. Je kreativní, neotřelý, vždy půl kroku napřed.`,
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
              const updated = [...updatedMessages, { role: "assistant" as const, content: assistantContent }];
              updateChatMessages(activeSessionId, updated);
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

  const handleArchive = async () => {
    if (!activeSession.reportText) {
      toast.error("Nejdřív vygeneruj report.");
      return;
    }

    setIsSaving(true);
    try {
      // Count sessions
      const { count } = await supabase
        .from("client_sessions")
        .select("id", { count: "exact", head: true })
        .eq("client_id", activeSession.clientId);

      const fd = activeSession.formData;
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
          ai_analysis: activeSession.reportText,
          notes: [
            fd.contactFullName && `Kontakt: ${fd.contactFullName}`,
            fd.contactEmail && `Email: ${fd.contactEmail}`,
            fd.contactPhone && `Tel: ${fd.contactPhone}`,
            fd.isMinor && fd.childFullName && `Dítě: ${fd.childFullName}`,
            fd.isMinor && fd.guardianFullName && `Zástupce: ${fd.guardianFullName}`,
          ].filter(Boolean).join("\n"),
        });

      if (error) throw error;

      toast.success(`Záznam odeslán do kartotéky klienta ${activeSession.clientName}`);
      removeSession(activeSessionId);
    } catch (error) {
      console.error("Archive error:", error);
      toast.error("Nepodařilo se uložit do kartotéky");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="p-3 border-b border-border bg-card/30">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Karel – živá supervize</h3>
            <p className="text-xs text-muted-foreground">{activeSession.clientName}</p>
          </div>
          {activeSession.reportText && (
            <Button
              size="sm"
              variant="default"
              onClick={handleArchive}
              disabled={isSaving}
              className="gap-1.5 text-xs"
            >
              {isSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Archive className="w-3 h-3" />}
              Odeslat do kartotéky
            </Button>
          )}
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
        </div>
      </ScrollArea>

      {/* Report preview if exists */}
      {activeSession.reportText && (
        <div className="border-t border-border p-3 bg-primary/5 max-h-32 overflow-y-auto">
          <div className="flex items-center gap-2 mb-1">
            <CheckCircle className="w-3.5 h-3.5 text-primary" />
            <span className="text-xs font-medium text-foreground">Report vygenerován</span>
          </div>
          <p className="text-xs text-muted-foreground line-clamp-3">
            {activeSession.reportText.slice(0, 200)}...
          </p>
        </div>
      )}

      {/* Input */}
      <div className="p-3 border-t border-border">
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
            placeholder="Napiš Karlovi..."
            className="min-h-[40px] max-h-[100px] resize-none text-sm"
            disabled={isLoading}
          />
          <Button
            size="icon"
            onClick={sendMessage}
            disabled={!input.trim() || isLoading}
            className="h-[40px] w-[40px] shrink-0"
          >
            {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default SupervisionChat;

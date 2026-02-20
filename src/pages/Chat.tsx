import { useState, useRef, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Send, LogOut, Loader2, FileText, Leaf } from "lucide-react";
import { toast } from "sonner";
import ModeSelector from "@/components/ModeSelector";
import MainModeToggle from "@/components/MainModeToggle";
import ChatMessage from "@/components/ChatMessage";
import ReportForm from "@/components/ReportForm";
import CrisisBriefPanel from "@/components/CrisisBriefPanel";
import DidSubModeSelector, { type DidSubMode } from "@/components/did/DidSubModeSelector";
import DidOrientationForm from "@/components/did/DidOrientationForm";
import DidFreeTextEntry from "@/components/did/DidFreeTextEntry";
import { useChatContext } from "@/contexts/ChatContext";

type ConversationMode = "debrief" | "supervision" | "safety" | "childcare";

// localStorage helpers
const STORAGE_KEY_PREFIX = "karel_chat_";
const saveMessages = (mode: string, messages: { role: string; content: string }[]) => {
  try {
    localStorage.setItem(`${STORAGE_KEY_PREFIX}${mode}`, JSON.stringify(messages));
  } catch { /* quota exceeded – silently ignore */ }
};
const loadMessages = (mode: string) => {
  try {
    const raw = localStorage.getItem(`${STORAGE_KEY_PREFIX}${mode}`);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
};
const clearMessages = (mode: string) => {
  localStorage.removeItem(`${STORAGE_KEY_PREFIX}${mode}`);
};

const handleApiError = (response: Response) => {
  if (response.status === 429) {
    throw new Error("Karel je momentálně přetížený. Zkus to prosím za chvilku.");
  }
  if (response.status === 402) {
    throw new Error("Karel je momentálně nedostupný – pravděpodobně došly AI kredity. Zkontroluj Cloud & AI balance v nastavení.");
  }
  throw new Error("Něco se pokazilo. Zkus to znovu.");
};

const Chat = () => {
  const { 
    messages, 
    setMessages, 
    mode, 
    setMode,
    mainMode,
    setMainMode,
    setReportDraft,
    pendingHandoffToChat,
    setPendingHandoffToChat,
    lastReportText,
    didSubMode,
    setDidSubMode,
    didInitialContext,
    setDidInitialContext,
  } = useChatContext();
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSoapLoading, setIsSoapLoading] = useState(false);
  const [notebookProject, setNotebookProject] = useState(() => {
    try { return localStorage.getItem("karel_notebook_project") || "DID – vnitřní mapa systému (pracovní)"; } catch { return "DID – vnitřní mapa systému (pracovní)"; }
  });

  // Persist notebook project name
  useEffect(() => {
    try { localStorage.setItem("karel_notebook_project", notebookProject); } catch {}
  }, [notebookProject]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const navigate = useNavigate();

  // Check authentication
  useEffect(() => {
    const isAuthenticated = sessionStorage.getItem("authenticated");
    if (!isAuthenticated) {
      navigate("/");
    }
  }, [navigate]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Persist messages to localStorage on change
  useEffect(() => {
    if (messages.length > 0) {
      saveMessages(mode, messages);
    }
  }, [messages, mode]);

  // Welcome message when mode changes
  useEffect(() => {
    const welcomeMessages: Record<ConversationMode, string> = {
      debrief: "Hani, jsem tady. Pojď, sedni si ke mně k ohni. Pracovní den končí a já ti držím prostor, abys mohla odložit vše, co v tobě zůstalo. Jak se právě teď cítíš?",
      supervision: "Haničko, jsem připraven s tebou pracovat. Která postava z tvé praxe tě teď zaměstnává? Můžeme reflektovat, trénovat, nebo ti nabídnu strukturovaný zápis - co potřebuješ?",
      safety: "Hani, pojďme společně a věcně projít to, co tě znepokojuje. Jsem tu jako tvůj partner - projdeme hranice, postup i dokumentaci. Na čem pracujeme?",
      childcare: "Haničko, jsem tady s tebou. Vím, jak náročná je péče o tvé dítě s DID. Pojďme spolu projít, co se děje - ať už potřebuješ porozumět nějakému alteru, zpracovat náročnou situaci, nebo jen sdílet. Co teď nejvíc potřebuješ?",
    };

    // Reset DID sub-mode when switching away from childcare
    if (mode !== "childcare") {
      setDidSubMode(null);
      setDidInitialContext("");
    }

    // For childcare mode, don't set welcome message until sub-mode is selected
    if (mode === "childcare") {
      return;
    }

    // Only reset messages if not coming from report handoff
    if (!pendingHandoffToChat) {
      // Try to restore from localStorage first
      const saved = loadMessages(mode);
      if (saved && saved.length > 0) {
        setMessages(saved);
      } else {
        setMessages([{ role: "assistant", content: welcomeMessages[mode] }]);
      }
    }
  }, [mode, setMessages, pendingHandoffToChat, setDidSubMode, setDidInitialContext]);

  // Handle handoff from Report to Chat
  useEffect(() => {
    if (pendingHandoffToChat && mainMode === "chat") {
      const handoffMessage = lastReportText 
        ? "Haničko… to, co jsi teď sepsala, je hodně náročné.\n\nNež půjdeme do detailů – co z toho zápisu v tobě teď nejvíc rezonuje?"
        : "Haničko, jsem připraven s tebou probrat, co tě zaměstnává. Co teď nejvíc potřebuješ?";
      
      setMessages(prev => [...prev, { role: "assistant", content: handoffMessage }]);
      setPendingHandoffToChat(false);
    }
  }, [pendingHandoffToChat, mainMode, lastReportText, setMessages, setPendingHandoffToChat]);

  const handleLogout = () => {
    sessionStorage.removeItem("authenticated");
    navigate("/");
  };

  const handleNewConversation = useCallback(() => {
    clearMessages(mode);
    setDidSubMode(null);
    setDidInitialContext("");
    setMessages([]);
  }, [mode, setMessages, setDidSubMode, setDidInitialContext]);

  const handleDidBack = useCallback(() => {
    setDidSubMode(null);
    setDidInitialContext("");
    setMessages([]);
  }, [setDidSubMode, setDidInitialContext, setMessages]);

  const handleSoapHandoff = async () => {
    if (messages.length < 2 || isSoapLoading) return;
    
    setIsSoapLoading(true);
    
    try {
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-soap`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
          },
          body: JSON.stringify({
            messages: messages.slice(-40),
            mode,
          }),
        }
      );

      if (!response.ok) {
        handleApiError(response);
      }

      const soapData = await response.json();
      
      setReportDraft({
        context: soapData.context || "",
        keyTheme: soapData.keyTheme || "",
        therapistEmotions: soapData.therapistEmotions || [],
        transference: soapData.transference || "",
        risks: soapData.risks || [],
        missingData: soapData.missingData || "",
        interventionsTried: soapData.interventionsTried || "",
        nextSessionGoal: soapData.nextSessionGoal || "",
      });
      
      setMainMode("report");
      toast.success("Zápis připraven, formulář předvyplněn");
    } catch (error) {
      console.error("SOAP error:", error);
      toast.error(error instanceof Error ? error.message : "Chyba při vytváření zápisu");
    } finally {
      setIsSoapLoading(false);
    }
  };

  // DID sub-mode handlers
  const handleDidSubModeSelect = (subMode: DidSubMode) => {
    setDidSubMode(subMode);
    if (subMode === "general") {
      setDidInitialContext(`NotebookLM projekt: ${notebookProject}`);
      setMessages([{ role: "assistant", content: `Haničko, jsem tady s tebou. Můžeš se ptát na metody, ale také mi popsat konkrétní situaci. Pokud chceš, vlož výňatek z NotebookLM s hlavičkou:\n\n\`[NotebookLM: ${notebookProject} | Dokument: název_dokumentu]\`\n\nJá ti nabídnu 2–3 varianty postupu, věty které říct, a návrh co uložit do NotebookLM.\n\n📓 **NotebookLM** je paměť a databáze. Karel nemá automatický přístup. Pokud chceš, vlož sem výňatek (max 10 řádků). Ty rozhoduješ, co se předá.\n\n📓 **Aktuální projekt:** ${notebookProject}` }]);
    }
  };

  const handleDidFormSubmit = (context: string) => {
    setDidInitialContext(context);
    setDidSubMode("form");
    setMessages([{ role: "user", content: context }]);
    triggerDidFirstResponse(context);
  };

  const handleDidFreeTextSubmit = (context: string) => {
    setDidInitialContext(context);
    setDidSubMode("freetext");
    setMessages([{ role: "user", content: context }]);
    triggerDidFirstResponse(context);
  };

  const triggerDidFirstResponse = async (context: string) => {
    setIsLoading(true);
    let assistantContent = "";
    try {
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-chat`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
          },
          body: JSON.stringify({
            messages: [{ role: "user", content: context }],
            mode,
            didInitialContext: context,
          }),
        }
      );
      if (!response.ok) handleApiError(response);
      if (!response.body) throw new Error("Žádná odpověď");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
          let line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (line.startsWith(":") || line.trim() === "") continue;
          if (!line.startsWith("data: ")) continue;
          const jsonStr = line.slice(6).trim();
          if (jsonStr === "[DONE]") break;
          try {
            const parsed = JSON.parse(jsonStr);
            const content = parsed.choices?.[0]?.delta?.content as string | undefined;
            if (content) {
              assistantContent += content;
              setMessages((prev) => {
                const newMessages = [...prev];
                const lastIndex = newMessages.length - 1;
                if (newMessages[lastIndex]?.role === "assistant") {
                  newMessages[lastIndex] = { ...newMessages[lastIndex], content: assistantContent };
                }
                return newMessages;
              });
            }
          } catch {
            buffer = line + "\n" + buffer;
            break;
          }
        }
      }
    } catch (error) {
      console.error("DID first response error:", error);
      toast.error(error instanceof Error ? error.message : "Chyba při komunikaci s Karlem");
      if (!assistantContent) {
        setMessages((prev) => prev.slice(0, -1));
      }
    } finally {
      setIsLoading(false);
    }
  };

  const sendMessage = async () => {
    if (!input.trim() || isLoading) return;

    const userMessage = input.trim();
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: userMessage }]);
    setIsLoading(true);

    let assistantContent = "";

    try {
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-chat`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
          },
          body: JSON.stringify({
            messages: [...messages, { role: "user", content: userMessage }],
            mode,
            ...(mode === "childcare" && didInitialContext ? { didInitialContext } : {}),
          }),
        }
      );

      if (!response.ok) handleApiError(response);
      if (!response.body) throw new Error("Žádná odpověď");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
          let line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);

          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (line.startsWith(":") || line.trim() === "") continue;
          if (!line.startsWith("data: ")) continue;

          const jsonStr = line.slice(6).trim();
          if (jsonStr === "[DONE]") break;

          try {
            const parsed = JSON.parse(jsonStr);
            const content = parsed.choices?.[0]?.delta?.content as string | undefined;
            if (content) {
              assistantContent += content;
              setMessages((prev) => {
                const newMessages = [...prev];
                const lastIndex = newMessages.length - 1;
                if (newMessages[lastIndex]?.role === "assistant") {
                  newMessages[lastIndex] = {
                    ...newMessages[lastIndex],
                    content: assistantContent,
                  };
                }
                return newMessages;
              });
            }
          } catch {
            buffer = line + "\n" + buffer;
            break;
          }
        }
      }
    } catch (error) {
      console.error("Chat error:", error);
      toast.error(error instanceof Error ? error.message : "Chyba při komunikaci");
      if (!assistantContent) {
        setMessages((prev) => prev.slice(0, -1));
      }
    } finally {
      setIsLoading(false);
      textareaRef.current?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  // Loading skeleton component
  const LoadingSkeleton = () => (
    <div className="flex justify-start">
      <div className="chat-message-assistant">
        <div className="flex items-center gap-3">
          <div className="relative">
            <Loader2 className="w-5 h-5 animate-spin text-primary" />
          </div>
          <div className="space-y-2 flex-1">
            <div className="h-3 bg-muted rounded animate-pulse w-48" />
            <div className="h-3 bg-muted rounded animate-pulse w-32" />
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-3 sm:px-4 py-2.5 sm:py-4 flex items-center justify-between">
          <div className="min-w-0">
            <h1 className="text-base sm:text-xl font-serif font-semibold text-foreground truncate">Carl Gustav Jung</h1>
            <p className="text-xs sm:text-sm text-muted-foreground hidden sm:block">Tvůj partner a supervizní mentor</p>
          </div>
          <div className="flex items-center gap-1 sm:gap-2 shrink-0">
            <Button variant="outline" size="sm" onClick={() => navigate("/calm")} className="h-8 px-2 sm:px-3">
              <Leaf className="w-4 h-4 sm:mr-2" />
              <span className="hidden sm:inline">Zklidnění</span>
            </Button>
            <Button variant="ghost" size="sm" onClick={handleLogout} className="h-8 px-2 sm:px-3">
              <LogOut className="w-4 h-4 sm:mr-2" />
              <span className="hidden sm:inline">Odejít</span>
            </Button>
          </div>
        </div>
      </header>

      {/* Main Mode Toggle */}
      <div className="border-b border-border bg-card/30">
        <div className="max-w-4xl mx-auto px-4 py-3">
          <MainModeToggle currentMode={mainMode} onModeChange={setMainMode} />
        </div>
      </div>

      {mainMode === "chat" ? (
        <>
          {/* Crisis Brief Panel */}
          <CrisisBriefPanel />
          {/* Chat Mode Selector */}
          <div className="border-b border-border bg-card/30">
            <div className="max-w-4xl mx-auto px-4 py-3">
              <ModeSelector currentMode={mode} onModeChange={(newMode) => {
                if (newMode === "childcare") {
                  setDidSubMode(null);
                  setDidInitialContext("");
                  setMessages([]);
                }
                setMode(newMode);
              }} />
            </div>
          </div>

          {/* DID Sub-mode flow when childcare is active */}
          {mode === "childcare" && !didSubMode ? (
            <ScrollArea className="flex-1">
              <DidSubModeSelector onSelect={handleDidSubModeSelect} onBack={() => setMode("debrief")} />
            </ScrollArea>
          ) : mode === "childcare" && didSubMode === "form" && messages.length === 0 ? (
            <ScrollArea className="flex-1">
              <DidOrientationForm onSubmit={handleDidFormSubmit} onBack={handleDidBack} notebookProject={notebookProject} onNotebookProjectChange={setNotebookProject} />
            </ScrollArea>
          ) : mode === "childcare" && didSubMode === "freetext" && messages.length === 0 ? (
            <ScrollArea className="flex-1">
              <DidFreeTextEntry onSubmit={handleDidFreeTextSubmit} onBack={handleDidBack} notebookProject={notebookProject} onNotebookProjectChange={setNotebookProject} />
            </ScrollArea>
          ) : (
            <>
              {/* Chat Messages */}
              <ScrollArea className="flex-1 px-2 sm:px-4" ref={scrollRef}>
                <div className="max-w-4xl mx-auto py-3 sm:py-6 space-y-3 sm:space-y-4">
                  {messages.map((message, index) => (
                    <ChatMessage key={index} message={message} />
                  ))}
                  {isLoading && messages[messages.length - 1]?.role === "user" && (
                    <LoadingSkeleton />
                  )}
                </div>
              </ScrollArea>

              {/* Input Area */}
              <div className="border-t border-border bg-card/50 backdrop-blur-sm">
                <div className="max-w-4xl mx-auto px-2 sm:px-4 py-2 sm:py-4">
                  <div className="flex gap-2 sm:gap-3 items-end">
                    <Textarea
                      ref={textareaRef}
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={handleKeyDown}
                      placeholder="Napiš svou zprávu..."
                      className="min-h-[44px] sm:min-h-[56px] max-h-[150px] sm:max-h-[200px] resize-none text-sm sm:text-base"
                      disabled={isLoading || isSoapLoading}
                    />
                    <Button
                      onClick={sendMessage}
                      disabled={!input.trim() || isLoading || isSoapLoading}
                      size="icon"
                      className="h-[44px] w-[44px] sm:h-[56px] sm:w-[56px] shrink-0"
                    >
                      {isLoading ? (
                        <Loader2 className="w-4 h-4 sm:w-5 sm:h-5 animate-spin" />
                      ) : (
                        <Send className="w-4 h-4 sm:w-5 sm:h-5" />
                      )}
                    </Button>
                    {messages.length > 1 && (
                      <Button
                        variant="outline"
                        onClick={handleSoapHandoff}
                        disabled={isLoading || isSoapLoading}
                        className="h-[44px] sm:h-[56px] shrink-0 px-2 sm:px-4"
                      >
                        {isSoapLoading ? (
                          <Loader2 className="w-4 h-4 sm:mr-2 animate-spin" />
                        ) : (
                          <FileText className="w-4 h-4 sm:mr-2" />
                        )}
                        <span className="hidden sm:inline">Pořídit zápis</span>
                      </Button>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1.5 sm:mt-2 text-center">
                    Soukromé temenos. Konverzace zůstává jen v tvém prohlížeči.
                  </p>
                </div>
              </div>
            </>
          )}
        </>
      ) : (
        <>
          {/* Report Mode */}
          <ScrollArea className="flex-1">
            <ReportForm />
          </ScrollArea>
          
          {/* Footer for Report Mode */}
          <div className="border-t border-border bg-card/50 backdrop-blur-sm py-2">
            <p className="text-xs text-muted-foreground text-center">
              Soukromé temenos. Žádná data se neukládají.
            </p>
          </div>
        </>
      )}
    </div>
  );
};

export default Chat;
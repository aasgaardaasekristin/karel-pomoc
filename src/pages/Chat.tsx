import { useState, useRef, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Send, LogOut, Loader2, FileText, Leaf, RotateCcw, FolderOpen } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { getAuthHeaders } from "@/lib/auth";
import { toast } from "sonner";
import ModeSelector from "@/components/ModeSelector";
import MainModeToggle from "@/components/MainModeToggle";
import ChatMessage from "@/components/ChatMessage";
import ReportForm from "@/components/ReportForm";
import SessionSidebar from "@/components/report/SessionSidebar";
import SessionReportForm from "@/components/report/SessionReportForm";
import SupervisionChat from "@/components/report/SupervisionChat";
import CrisisBriefPanel from "@/components/CrisisBriefPanel";
import DidSubModeSelector from "@/components/did/DidSubModeSelector";
import DidConversationHistory from "@/components/did/DidConversationHistory";
import DidDocumentGate from "@/components/did/DidDocumentGate";
import type { DidSubMode } from "@/components/did/DidSubModeSelector";
import { useChatContext } from "@/contexts/ChatContext";
import { useConversationHistory } from "@/hooks/useConversationHistory";

type ConversationMode = "debrief" | "supervision" | "safety" | "childcare" | "kartoteka";

// localStorage helpers
const STORAGE_KEY_PREFIX = "karel_chat_";
const ACTIVE_MODE_KEY = "karel_active_mode";
const DID_DOCS_LOADED_KEY = "karel_did_docs_loaded";
const DID_SESSION_ID_KEY = "karel_did_session_id";
const LAST_CAST_GREETING_INDEX_KEY = "karel_last_cast_greeting_index";

const CAST_GREETINGS = [
  "Hejky! 😊 Já jsem Karel. Co dneska podnikáš?",
  "Ahoj ahoj! Já jsem Karel. Jakou náladu máš právě teď?",
  "Čau! Karel tady. Co se ti dneska honí hlavou?",
  "Nazdar! 😄 Já jsem Karel. Co hezkého nebo těžkého dneska přišlo?",
  "Jé, ahoj! Já jsem Karel. Chceš mi říct, jak se teď máš?",
  "Ahoj! 🌟 Karel tady. Co bys dneska potřeboval/a, aby bylo líp?",
  "Hezky tě vítám, já jsem Karel. Na co máš teď chuť si povídat?",
];

const getRandomCastGreeting = () => {
  if (CAST_GREETINGS.length === 1) return CAST_GREETINGS[0];

  try {
    const lastIndexRaw = localStorage.getItem(LAST_CAST_GREETING_INDEX_KEY);
    const lastIndex = lastIndexRaw ? Number(lastIndexRaw) : -1;
    let nextIndex = Math.floor(Math.random() * CAST_GREETINGS.length);

    if (nextIndex === lastIndex) {
      nextIndex = (nextIndex + 1) % CAST_GREETINGS.length;
    }

    localStorage.setItem(LAST_CAST_GREETING_INDEX_KEY, String(nextIndex));
    return CAST_GREETINGS[nextIndex];
  } catch {
    return CAST_GREETINGS[Math.floor(Math.random() * CAST_GREETINGS.length)];
  }
};

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
  const [didDocsLoaded, setDidDocsLoaded] = useState(false);
  const [isSoapLoading, setIsSoapLoading] = useState(false);
  const [notebookProject, setNotebookProject] = useState(() => {
    try { return localStorage.getItem("karel_notebook_project") || "DID – vnitřní mapa systému (pracovní)"; } catch { return "DID – vnitřní mapa systému (pracovní)"; }
  });
  const [didSessionId, setDidSessionId] = useState<string | null>(() => {
    try { return localStorage.getItem(DID_SESSION_ID_KEY); } catch { return null; }
  });
  const { history, saveConversation, loadConversation, deleteConversation, refreshHistory } = useConversationHistory();

  useEffect(() => {
    try { localStorage.setItem(ACTIVE_MODE_KEY, mode); } catch {}
  }, [mode]);

  // Persist didSubMode & didInitialContext to localStorage
  useEffect(() => {
    try {
      if (didSubMode) {
        localStorage.setItem("karel_did_submode", didSubMode);
      } else {
        localStorage.removeItem("karel_did_submode");
      }
    } catch {}
  }, [didSubMode]);

  useEffect(() => {
    try {
      if (didInitialContext) {
        localStorage.setItem("karel_did_context", didInitialContext);
      } else {
        localStorage.removeItem("karel_did_context");
      }
    } catch {}
  }, [didInitialContext]);

  useEffect(() => {
    try {
      localStorage.setItem(DID_DOCS_LOADED_KEY, didDocsLoaded ? "1" : "0");
    } catch {}
  }, [didDocsLoaded]);

  useEffect(() => {
    try {
      if (didSessionId) {
        localStorage.setItem(DID_SESSION_ID_KEY, didSessionId);
      } else {
        localStorage.removeItem(DID_SESSION_ID_KEY);
      }
    } catch {}
  }, [didSessionId]);

  // Persist notebook project name
  useEffect(() => {
    try { localStorage.setItem("karel_notebook_project", notebookProject); } catch {}
  }, [notebookProject]);

  // Restore interrupted DID flow after tab/page return
  useEffect(() => {
    try {
      const savedMode = localStorage.getItem(ACTIVE_MODE_KEY) as ConversationMode | null;
      if (savedMode !== "childcare") return;

      const savedMessages = loadMessages("childcare");
      const savedSubMode = localStorage.getItem("karel_did_submode") as DidSubMode | null;
      const savedContext = localStorage.getItem("karel_did_context") || "";
      const savedDidDocsLoaded = localStorage.getItem(DID_DOCS_LOADED_KEY) === "1";
      const savedSessionId = localStorage.getItem(DID_SESSION_ID_KEY);

      setMode("childcare");
      if (savedSubMode) setDidSubMode(savedSubMode);
      setDidInitialContext(savedContext);
      setDidDocsLoaded(savedDidDocsLoaded || !!(savedMessages && savedMessages.length > 0));
      if (savedSessionId) setDidSessionId(savedSessionId);
      if (savedMessages && savedMessages.length > 0) {
        setMessages(savedMessages);
      }
    } catch {}
  }, []);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const navigate = useNavigate();

  const [authChecked, setAuthChecked] = useState(false);

  // Check authentication — block render until verified
  useEffect(() => {
    const checkAuth = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        navigate("/", { replace: true });
      } else {
        setAuthChecked(true);
      }
    };
    checkAuth();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) navigate("/", { replace: true });
    });
    return () => subscription.unsubscribe();
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

  // Periodically re-save messages to prevent loss on tab switches
  useEffect(() => {
    if (messages.length === 0) return;
    const interval = setInterval(() => {
      saveMessages(mode, messages);
      // Auto-save DID conversation to history so it's never lost
      if (mode === "childcare" && didSubMode && messages.length >= 2) {
        saveConversation(didSubMode, messages, didInitialContext, didSessionId ?? undefined);
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [messages, mode, didSubMode, didInitialContext, didSessionId, saveConversation]);

  // Save/restore when tab visibility changes
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") {
        if (messages.length > 0) {
          saveMessages(mode, messages);
        }
        if (mode === "childcare" && didSubMode && messages.length >= 2) {
          saveConversation(didSubMode, messages, didInitialContext, didSessionId ?? undefined);
        }
        return;
      }

      if (document.visibilityState === "visible") {
        if (mode === "childcare" && !didSubMode) {
          refreshHistory();
        }

        const isInDidDocumentGate = mode === "childcare" && !!didSubMode && !didDocsLoaded;
        if (!isInDidDocumentGate && messages.length === 0) {
          const saved = loadMessages(mode);
          if (saved && saved.length > 0) {
            setMessages(saved);
          }
        }
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [mode, messages, didSubMode, didDocsLoaded, didInitialContext, didSessionId, saveConversation, refreshHistory, setMessages]);

  // Save when page is being frozen/unloaded
  useEffect(() => {
    const persistNow = () => {
      if (messages.length > 0) {
        saveMessages(mode, messages);
      }
      if (mode === "childcare" && didSubMode && messages.length >= 2) {
        saveConversation(didSubMode, messages, didInitialContext, didSessionId ?? undefined);
      }
    };

    window.addEventListener("beforeunload", persistNow);
    window.addEventListener("pagehide", persistNow);
    return () => {
      window.removeEventListener("beforeunload", persistNow);
      window.removeEventListener("pagehide", persistNow);
    };
  }, [messages, mode, didSubMode, didInitialContext, didSessionId, saveConversation]);

  // Welcome message when mode changes
  useEffect(() => {
    const welcomeMessages: Record<ConversationMode, string> = {
      debrief: "Hani, jsem tady. Pojď, sedni si ke mně k ohni. Pracovní den končí a já ti držím prostor, abys mohla odložit vše, co v tobě zůstalo. Jak se právě teď cítíš?",
      supervision: "Haničko, jsem připraven s tebou pracovat. Která postava z tvé praxe tě teď zaměstnává? Můžeme reflektovat, trénovat, nebo ti nabídnu strukturovaný zápis - co potřebuješ?",
      safety: "Hani, pojďme společně a věcně projít to, co tě znepokojuje. Jsem tu jako tvůj partner - projdeme hranice, postup i dokumentaci. Na čem pracujeme?",
      childcare: "Haničko, jsem tady s tebou. Vím, jak náročná je péče o tvé dítě s DID. Pojďme spolu projít, co se děje - ať už potřebuješ porozumět nějakému alteru, zpracovat náročnou situaci, nebo jen sdílet. Co teď nejvíc potřebuješ?",
      kartoteka: "Haničko, jsem připraven pracovat na kartotéce. O jakém klientovi chceš dnes mluvit? Pokud má klient kartu, vlož mi prosím jeho údaje – kartu, záznamy ze sezení a aktuální úkoly. Pokud je to nový klient, pomůžu ti založit kartu.",
    };

    // Reset DID sub-mode when switching away from childcare
    if (mode !== "childcare") {
      setDidSubMode(null);
      setDidInitialContext("");
    }

    // For childcare mode, don't set welcome message until sub-mode is selected
    if (mode === "childcare") {
      refreshHistory();
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

  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate("/");
  };

  const handleNewConversation = useCallback(() => {
    // Save current conversation to history before clearing
    if (didSubMode && messages.length >= 2) {
      saveConversation(didSubMode, messages, didInitialContext, didSessionId ?? undefined);
    }
    clearMessages(mode);
    setDidSubMode(null);
    setDidInitialContext("");
    setDidDocsLoaded(false);
    setDidSessionId(null);
    setMessages([]);
    refreshHistory();
  }, [mode, messages, didSubMode, didInitialContext, didSessionId, setMessages, setDidSubMode, setDidInitialContext, saveConversation, refreshHistory]);

  const handleDidBack = useCallback(() => {
    // Save current conversation to history before going back
    if (didSubMode && messages.length >= 2) {
      saveConversation(didSubMode, messages, didInitialContext, didSessionId ?? undefined);
    }
    setDidSubMode(null);
    setDidInitialContext("");
    setDidDocsLoaded(false);
    setDidSessionId(null);
    setMessages([]);
    refreshHistory();
  }, [didSubMode, messages, didInitialContext, didSessionId, setDidSubMode, setDidInitialContext, setMessages, saveConversation, refreshHistory]);

  const handleRestoreConversation = useCallback(async (id: string) => {
    const conv = await loadConversation(id);
    if (!conv) return;
    setDidSubMode(conv.subMode as DidSubMode);
    setDidInitialContext(conv.didInitialContext);
    setDidDocsLoaded(true);
    setDidSessionId(conv.id);
    setMessages(conv.messages as any);
    saveMessages(mode, conv.messages);
  }, [loadConversation, setDidSubMode, setDidInitialContext, setMessages, mode]);

  // Don't render anything until auth is confirmed
  if (!authChecked) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const handleSoapHandoff = async () => {
    if (messages.length < 2 || isSoapLoading) return;
    
    setIsSoapLoading(true);
    
    try {
      const headers = await getAuthHeaders();
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-soap`,
        {
          method: "POST",
          headers,
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
    setDidSessionId(null);
    setDidDocsLoaded(false);
    // Don't start chat yet — DidDocumentGate will appear first
  };

  const handleDidDocsSubmit = (docs: { seznam: string; mapa: string }) => {
    setDidDocsLoaded(true);
    const newSessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setDidSessionId(newSessionId);
    const docsContext = `[NotebookLM: ${notebookProject} | Dokument: 00_Seznam_částí]\n${docs.seznam}\n\n[NotebookLM: ${notebookProject} | Dokument: 01_Hlavní_mapa_systému]\n${docs.mapa}`;

    if (didSubMode === "mamka") {
      setDidInitialContext(docsContext);
      setMessages([{ role: "assistant", content: `Haničko, jsem tady s tebou. Díky za dokumenty – mám přehled o systému.\n\nPověz mi, co se děje.\n\nPokud chceš, vlož další výňatek z NotebookLM (5–15 řádků) s hlavičkou:\n\n\`[NotebookLM: ${notebookProject} | Dokument: název_dokumentu]\`\n\n📓 **Aktuální projekt:** ${notebookProject}` }]);
    } else if (didSubMode === "cast") {
      setDidInitialContext(docsContext);
      setMessages([{ role: "assistant", content: getRandomCastGreeting() }]);
    } else if (didSubMode === "general") {
      setDidInitialContext(docsContext);
      setMessages([{ role: "assistant", content: `Haničko, jsem tady s tebou. Díky za dokumenty – mám přehled o systému.\n\nMůžeš se ptát na metody, ale také mi popsat konkrétní situaci. Pokud chceš, vlož další výňatek z NotebookLM s hlavičkou:\n\n\`[NotebookLM: ${notebookProject} | Dokument: název_dokumentu]\`\n\n📓 **Aktuální projekt:** ${notebookProject}` }]);
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
      const headers = await getAuthHeaders();
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-chat`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            messages: [...messages, { role: "user", content: userMessage }],
            mode,
            ...(mode === "childcare" && didInitialContext ? { didInitialContext } : {}),
            ...(mode === "childcare" && didSubMode ? { didSubMode } : {}),
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
            <Button variant="outline" size="sm" onClick={() => navigate("/kartoteka")} className="h-8 px-2 sm:px-3">
              <FolderOpen className="w-4 h-4 sm:mr-2" />
              <span className="hidden sm:inline">Kartotéka</span>
            </Button>
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
                  setDidDocsLoaded(false);
                  setDidSessionId(null);
                  setMessages([]);
                }
                setMode(newMode);
              }} />
            </div>
          </div>

          {/* DID Sub-mode flow when childcare is active */}
          {mode === "childcare" && !didSubMode ? (
            <ScrollArea className="flex-1">
              <DidConversationHistory
                conversations={history}
                onLoad={handleRestoreConversation}
                onDelete={(id) => {
                  deleteConversation(id);
                  refreshHistory();
                }}
              />
              <DidSubModeSelector onSelect={handleDidSubModeSelect} onBack={() => setMode("debrief")} />
            </ScrollArea>
          ) : mode === "childcare" && didSubMode && !didDocsLoaded && messages.length === 0 ? (
            <ScrollArea className="flex-1">
              <DidDocumentGate
                subMode={didSubMode}
                onSubmit={handleDidDocsSubmit}
                onBack={() => { setDidSubMode(null); setDidDocsLoaded(false); setDidSessionId(null); }}
              />
            </ScrollArea>
          ) : (
            <>
              {/* Chat Messages */}
              <ScrollArea className="flex-1 px-2 sm:px-4" ref={scrollRef}>
                <div className="max-w-4xl mx-auto py-3 sm:py-6 space-y-3 sm:space-y-4">
              {messages.map((message, index) => (
                    <ChatMessage 
                      key={index} 
                      message={message} 
                    />
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
                  {mode === "childcare" && didSubMode && messages.length > 1 && (
                    <div className="flex justify-center mt-2">
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={handleNewConversation}
                        className="text-xs gap-1.5"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        Ukončit tento rozhovor
                      </Button>
                    </div>
                  )}
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
          {/* Report Mode — Responsive Split Layout */}
          <div className="flex-1 flex flex-col sm:flex-row min-h-0 overflow-hidden">
            {/* Sidebar - always visible */}
            <SessionSidebar />
            {/* Form + Chat: stack on mobile, side-by-side on desktop */}
            <div className="flex-1 min-w-0 flex flex-col md:flex-row min-h-0 overflow-hidden">
              {/* Form */}
              <div className="flex-1 min-w-0 border-b md:border-b-0 md:border-r border-border min-h-[40vh] md:min-h-0">
                <SessionReportForm />
              </div>
              {/* Supervision Chat */}
              <div className="flex-1 min-w-0 flex flex-col min-h-[40vh] md:min-h-0">
                <SupervisionChat />
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default Chat;
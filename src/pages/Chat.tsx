import { useState, useRef, useEffect, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Send, LogOut, Loader2, FileText, RotateCcw, FolderOpen, GraduationCap, RefreshCw } from "lucide-react";
import { useUniversalUpload, buildAttachmentContent } from "@/hooks/useUniversalUpload";
import { useAudioRecorder } from "@/hooks/useAudioRecorder";
import UniversalAttachmentBar from "@/components/UniversalAttachmentBar";
import GoogleDrivePickerDialog from "@/components/GoogleDrivePickerDialog";
import AudioRecordButton from "@/components/AudioRecordButton";
import { supabase } from "@/integrations/supabase/client";
import { getAuthHeaders } from "@/lib/auth";
import { toast } from "sonner";
import ModeSelector from "@/components/ModeSelector";
import MainModeToggle from "@/components/MainModeToggle";
import ChatMessage from "@/components/ChatMessage";
import ReportForm from "@/components/ReportForm";
import SessionSidebar from "@/components/report/SessionSidebar";
import { useActiveSessions } from "@/contexts/ActiveSessionsContext";
import SessionReportForm from "@/components/report/SessionReportForm";
import SupervisionChat from "@/components/report/SupervisionChat";
import CrisisBriefPanel from "@/components/CrisisBriefPanel";
import DidSubModeSelector from "@/components/did/DidSubModeSelector";
import DidEntryScreen from "@/components/did/DidEntryScreen";
import DidPinEntry from "@/components/did/DidPinEntry";
import DidTherapistThreads from "@/components/did/DidTherapistThreads";
import DidConversationHistory from "@/components/did/DidConversationHistory";
import DidActionButtons from "@/components/did/DidActionButtons";
import DidDashboard from "@/components/did/DidDashboard";
import DidThreadList from "@/components/did/DidThreadList";
import DidPartIdentifier from "@/components/did/DidPartIdentifier";
import type { DidSubMode } from "@/components/did/DidSubModeSelector";
import { useChatContext } from "@/contexts/ChatContext";
import { useConversationHistory } from "@/hooks/useConversationHistory";
import { useDidThreads, type DidThread } from "@/hooks/useDidThreads";
import { useDidContextPrime } from "@/hooks/useDidContextPrime";
import StudyMaterialPanel from "@/components/StudyMaterialPanel";
import HanaChat from "@/components/hana/HanaChat";
import ClientSummaryCard from "@/components/report/ClientSummaryCard";
import LiveSessionPanel from "@/components/report/LiveSessionPanel";
import PostSessionTools from "@/components/report/PostSessionTools";
import ResearchThreadList from "@/components/research/ResearchThreadList";
import ResearchNewTopicDialog from "@/components/research/ResearchNewTopicDialog";
import { useResearchThreads, type ResearchThread } from "@/hooks/useResearchThreads";
import DidMeetingPanel from "@/components/did/DidMeetingPanel";

type ConversationMode = "debrief" | "supervision" | "safety" | "childcare" | "research";
type HubSection = "did" | "hana" | "research" | null;

// localStorage helpers
const STORAGE_KEY_PREFIX = "karel_chat_";
const ACTIVE_MODE_KEY = "karel_active_mode";
const DID_DOCS_LOADED_KEY = "karel_did_docs_loaded";
const DID_SESSION_ID_KEY = "karel_did_session_id";
const LAST_CAST_GREETING_INDEX_KEY = "karel_last_cast_greeting_index";

const CAST_GREETINGS = [
  "Hej! 😊 Jak se dneska máš? Co nového?",
  "Čau! Co se ti dneska honí hlavou?",
  "Ahoj! 🌟 Povídej, na co máš teď chuť?",
  "Jé, ahoj! Jak se ti daří? Co bys dneska chtěl/a?",
  "Hezky, že jsi tady! Jakou náladu máš právě teď?",
  "Ahoj ahoj! Co hezkého nebo těžkého dneska přišlo?",
  "Čau! Už jsem se těšil/a, až si zase popovídáme. Co je nového?",
];

const getRandomCastGreeting = () => {
  if (CAST_GREETINGS.length === 1) return CAST_GREETINGS[0];
  try {
    const lastIndexRaw = localStorage.getItem(LAST_CAST_GREETING_INDEX_KEY);
    const lastIndex = lastIndexRaw ? Number(lastIndexRaw) : -1;
    let nextIndex = Math.floor(Math.random() * CAST_GREETINGS.length);
    if (nextIndex === lastIndex) nextIndex = (nextIndex + 1) % CAST_GREETINGS.length;
    localStorage.setItem(LAST_CAST_GREETING_INDEX_KEY, String(nextIndex));
    return CAST_GREETINGS[nextIndex];
  } catch {
    return CAST_GREETINGS[Math.floor(Math.random() * CAST_GREETINGS.length)];
  }
};

const saveMessages = (mode: string, messages: { role: string; content: string }[]) => {
  try {
    localStorage.setItem(`${STORAGE_KEY_PREFIX}${mode}`, JSON.stringify({ _mode: mode, messages }));
  } catch {}
};
const loadMessages = (mode: string) => {
  try {
    const raw = localStorage.getItem(`${STORAGE_KEY_PREFIX}${mode}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "_mode" in parsed) {
      if (parsed._mode !== mode) {
        localStorage.removeItem(`${STORAGE_KEY_PREFIX}${mode}`);
        return null;
      }
      return parsed.messages;
    }
    localStorage.removeItem(`${STORAGE_KEY_PREFIX}${mode}`);
    return null;
  } catch { return null; }
};
const clearMessages = (mode: string) => {
  localStorage.removeItem(`${STORAGE_KEY_PREFIX}${mode}`);
};

const handleApiError = (response: Response) => {
  if (response.status === 429) throw new Error("Karel je momentálně přetížený. Zkus to prosím za chvilku.");
  if (response.status === 402) throw new Error("Karel je momentálně nedostupný – pravděpodobně došly AI kredity.");
  throw new Error("Něco se pokazilo. Zkus to znovu.");
};

// DID flow states
type DidFlowState = "entry" | "terapeut" | "pin-entry" | "therapist-threads" | "dashboard" | "submode-select" | "thread-list" | "part-identify" | "chat" | "loading" | "meeting";

const HANA_PIN_KEY = "karel_hana_pin_verified";

const Chat = () => {
  const {
    messages, setMessages, mode, setMode, mainMode, setMainMode,
    setReportDraft, pendingHandoffToChat, setPendingHandoffToChat, lastReportText,
    didSubMode, setDidSubMode, didInitialContext, setDidInitialContext,
  } = useChatContext();
  const { activeSession, activeSessionId, clearActiveSession } = useActiveSessions();
  const [liveSessionStarted, setLiveSessionStarted] = useState(false);
  const [sessionReport, setSessionReport] = useState<string | null>(null);
  const [clientCaseSummary, setClientCaseSummary] = useState<string | null>(null);
  const didContextPrime = useDidContextPrime();

  // Reset live session state when switching clients
  useEffect(() => {
    setLiveSessionStarted(false);
    setSessionReport(null);
    setClientCaseSummary(null);
  }, [activeSessionId]);

  // When switching to PRACOVNÍ mode, always show client selection first
  useEffect(() => {
    if (mainMode === "report") {
      clearActiveSession();
      setLiveSessionStarted(false);
      setSessionReport(null);
      setClientCaseSummary(null);
    }
  }, [mainMode]);

  // Determine hub section from sessionStorage
  const [hubSection] = useState<HubSection>(() => {
    try {
      const section = sessionStorage.getItem("karel_hub_section") as HubSection;
      return section || null;
    } catch { return null; }
  });

  const [input, setInput] = useState("");
  const { attachments, fileInputRef, openFilePicker, handleFileChange, captureScreenshot, removeAttachment, clearAttachments, addAttachment } = useUniversalUpload();
  const [isLoading, setIsLoading] = useState(false);
  const [didDocsLoaded, setDidDocsLoaded] = useState(false);
  const [isDriveLoading, setIsDriveLoading] = useState(false);
  const [isSoapLoading, setIsSoapLoading] = useState(false);
  const [studyMaterial, setStudyMaterial] = useState<string | null>(null);
  const [isStudyLoading, setIsStudyLoading] = useState(false);
  const audioRecorder = useAudioRecorder();
  const [isAudioAnalyzing, setIsAudioAnalyzing] = useState(false);
  const [isFileAnalyzing, setIsFileAnalyzing] = useState(false);
  const [isDidResearchLoading, setIsDidResearchLoading] = useState(false);
  const [isManualUpdateLoading, setIsManualUpdateLoading] = useState(false);
  const [syncProgress, setSyncProgress] = useState<{ current: number; total: number; currentName: string } | null>(null);
  const [isHandbookLoading, setIsHandbookLoading] = useState(false);
  const [isResearchHandbookLoading, setIsResearchHandbookLoading] = useState(false);
  const [isReformatting, setIsReformatting] = useState(false);
  const [reformatProgress, setReformatProgress] = useState<{ current: number; total: number; currentName: string } | null>(null);
  const [drivePickerOpen, setDrivePickerOpen] = useState(false);
  // Research thread state
  type ResearchFlowState = "thread-list" | "new-topic" | "chat";
  const [researchFlowState, setResearchFlowState] = useState<ResearchFlowState>("thread-list");
  const [activeResearchThread, setActiveResearchThread] = useState<ResearchThread | null>(null);
  const researchThreads = useResearchThreads();
  const [notebookProject, setNotebookProject] = useState(() => {
    try { return localStorage.getItem("karel_notebook_project") || "DID – vnitřní mapa systému (pracovní)"; } catch { return "DID – vnitřní mapa systému (pracovní)"; }
  });
  const [didSessionId, setDidSessionId] = useState<string | null>(() => {
    try { return localStorage.getItem(DID_SESSION_ID_KEY); } catch { return null; }
  });

  // DID thread architecture
  const [didFlowState, setDidFlowState] = useState<DidFlowState>("entry");
  const [activeThread, setActiveThread] = useState<DidThread | null>(null);
  const [knownParts, setKnownParts] = useState<string[]>([]);
  const didThreads = useDidThreads();
  const basicDocsRef = useRef<string>("");
  const [isEnrichingContext, setIsEnrichingContext] = useState(false);
  const [meetingIdFromUrl, setMeetingIdFromUrl] = useState<string | null>(null);
  const [meetingTherapist, setMeetingTherapist] = useState<"hanka" | "kata">("hanka");
  const [searchParams, setSearchParams] = useSearchParams();

  const { history, saveConversation, loadConversation, deleteConversation, refreshHistory } = useConversationHistory();

  useEffect(() => {
    try { localStorage.setItem(ACTIVE_MODE_KEY, mode); } catch {}
  }, [mode]);

  useEffect(() => {
    try {
      if (didSubMode) localStorage.setItem("karel_did_submode", didSubMode);
      else localStorage.removeItem("karel_did_submode");
    } catch {}
  }, [didSubMode]);

  useEffect(() => {
    try {
      if (didInitialContext) localStorage.setItem("karel_did_context", didInitialContext);
      else localStorage.removeItem("karel_did_context");
    } catch {}
  }, [didInitialContext]);

  useEffect(() => {
    try { localStorage.setItem(DID_DOCS_LOADED_KEY, didDocsLoaded ? "1" : "0"); } catch {}
  }, [didDocsLoaded]);

  useEffect(() => {
    try {
      if (didSessionId) localStorage.setItem(DID_SESSION_ID_KEY, didSessionId);
      else localStorage.removeItem(DID_SESSION_ID_KEY);
    } catch {}
  }, [didSessionId]);

  useEffect(() => {
    try { localStorage.setItem("karel_notebook_project", notebookProject); } catch {}
  }, [notebookProject]);

  // One-time cleanup
  useEffect(() => {
    try {
      const modes: ConversationMode[] = ["debrief", "supervision", "safety", "research"];
      const contents = modes.map(m => localStorage.getItem(`${STORAGE_KEY_PREFIX}${m}`));
      const nonNull = contents.filter(Boolean);
      if (nonNull.length >= 2 && new Set(nonNull).size === 1) {
        modes.forEach(m => localStorage.removeItem(`${STORAGE_KEY_PREFIX}${m}`));
      }
    } catch {}
  }, []);

  // Restore interrupted DID flow
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
      if (savedSubMode) {
        setDidSubMode(savedSubMode);
        if (savedMessages && savedMessages.length > 0) {
          setDidFlowState("chat");
        } else {
          setDidFlowState("entry");
        }
      }
      setDidInitialContext(savedContext);
      setDidDocsLoaded(savedDidDocsLoaded || !!(savedMessages && savedMessages.length > 0));
      if (savedSessionId) setDidSessionId(savedSessionId);
      if (savedMessages && savedMessages.length > 0) setMessages(savedMessages);
    } catch {}
  }, []);

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const navigate = useNavigate();
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    const checkAuth = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) navigate("/", { replace: true });
      else {
        // Redirect to hub if no section selected
        if (!hubSection) {
          navigate("/hub", { replace: true });
          return;
        }
        // For Hana section, verify PIN
        if (hubSection === "hana") {
          try {
            if (sessionStorage.getItem(HANA_PIN_KEY) !== "1") {
              navigate("/hub", { replace: true });
              return;
            }
          } catch {
            navigate("/hub", { replace: true });
            return;
          }
        }
        // Auto-set mode based on hub section
        if (hubSection === "did" && mode !== "childcare") {
          setMode("childcare");
        } else if (hubSection === "research") {
          if (mode !== "research") setMode("research");
          // Always load research threads when entering research section
          researchThreads.fetchThreads();
        } else if (hubSection === "hana" && mode === "childcare") {
          setMode("debrief");
        }
        setAuthChecked(true);
      }
    };
    checkAuth();
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) navigate("/", { replace: true });
    });
    return () => subscription.unsubscribe();
  }, [navigate]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  const prevModeRef = useRef(mode);

  useEffect(() => {
    if (messages.length > 0 && prevModeRef.current === mode) saveMessages(mode, messages);
  }, [messages, mode]);

  // Auto-save research threads
  useEffect(() => {
    if (messages.length === 0 || !activeResearchThread) return;
    const interval = setInterval(() => {
      researchThreads.updateMessages(activeResearchThread.id, messages);
    }, 5000);
    return () => clearInterval(interval);
  }, [messages, activeResearchThread]);

  // Auto-save threads to DB (DID)
  useEffect(() => {
    if (messages.length === 0 || !activeThread) return;
    const interval = setInterval(() => {
      didThreads.updateThreadMessages(activeThread.id, messages);
    }, 5000);
    return () => clearInterval(interval);
  }, [messages, activeThread]);

  // Periodical save for non-thread modes
  useEffect(() => {
    if (messages.length === 0 || activeThread || activeResearchThread) return;
    const interval = setInterval(() => {
      saveMessages(mode, messages);
      if (mode === "childcare" && didSubMode && didSubMode !== "cast" && messages.length >= 2) {
        saveConversation(didSubMode, messages, didInitialContext, didSessionId ?? undefined);
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [messages, mode, didSubMode, didInitialContext, didSessionId, saveConversation, activeThread, activeResearchThread]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") {
        if (messages.length > 0) {
          saveMessages(mode, messages);
          if (activeThread) didThreads.updateThreadMessages(activeThread.id, messages);
          if (activeResearchThread) researchThreads.updateMessages(activeResearchThread.id, messages);
        }
        if (mode === "childcare" && didSubMode && didSubMode !== "cast" && messages.length >= 2) {
          saveConversation(didSubMode, messages, didInitialContext, didSessionId ?? undefined);
        }
      }
      if (document.visibilityState === "visible" && mode === "childcare" && !didSubMode) {
        refreshHistory();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [mode, messages, didSubMode, didInitialContext, didSessionId, saveConversation, refreshHistory, activeThread, activeResearchThread]);

  useEffect(() => {
    const persistNow = () => {
      if (messages.length > 0) {
        saveMessages(mode, messages);
        if (activeThread) didThreads.updateThreadMessages(activeThread.id, messages);
        if (activeResearchThread) researchThreads.updateMessages(activeResearchThread.id, messages);
      }
    };
    window.addEventListener("beforeunload", persistNow);
    window.addEventListener("pagehide", persistNow);
    return () => {
      window.removeEventListener("beforeunload", persistNow);
      window.removeEventListener("pagehide", persistNow);
    };
  }, [messages, mode, activeThread, activeResearchThread]);

  // Welcome message when mode changes
  useEffect(() => {
    const welcomeMessages: Record<ConversationMode, string> = {
      debrief: "Hani, jsem tady. Pojď, sedni si ke mně k ohni. Pracovní den končí a já ti držím prostor, abys mohla odložit vše, co v tobě zůstalo. Jak se právě teď cítíš?",
      supervision: "Haničko, jsem připraven s tebou pracovat. Která postava z tvé praxe tě teď zaměstnává? Můžeme reflektovat, trénovat, nebo ti nabídnu strukturovaný zápis - co potřebuješ?",
      safety: "Hani, pojďme společně a věcně projít to, co tě znepokojuje. Jsem tu jako tvůj partner - projdeme hranice, postup i dokumentaci. Na čem pracujeme?",
      childcare: "",
      research: "🔬 Haničko, jsem připraven prohledat internet pro tebe. Řekni mi, co tě zajímá – nové metody, testy, odborné články, trendy v psychoterapii, techniky pro práci s dětmi... Stačí popsat téma nebo situaci a já najdu relevantní zdroje.",
    };

    if (mode !== "childcare") {
      setDidSubMode(null);
      setDidInitialContext("");
      setDidFlowState("entry");
      setActiveThread(null);
    }

    if (mode === "childcare") {
      if (prevModeRef.current !== mode) {
        setMessages([]);
        setDidFlowState("entry");
        setActiveThread(null);
        // Pre-load basic docs from 00_CENTRUM in background
        (async () => {
          try {
            const headers = await getAuthHeaders();
            // Load key documents from 00_CENTRUM subfolder
            const response = await fetch(
              `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-drive-read`,
              { method: "POST", headers, body: JSON.stringify({ 
                documents: ["01_Index_Vsech_Casti", "00_Aktualni_Dashboard", "Mapa_Vztahu_a_Vazeb", "03_Vnitrni_Svet_Geografie", "05_Operativni_Plan", "06_Strategicky_Vyhled"],
                subFolder: "00_CENTRUM",
                allowGlobalSearch: false,
              }) }
            );
            if (response.ok) {
              const data = await response.json();
              const docs = data.documents || {};
              basicDocsRef.current = Object.entries(docs)
                .filter(([, val]) => typeof val === "string" && !val.startsWith("[Dokument"))
                .map(([key, val]) => `[Kartoteka_DID/00_CENTRUM: ${key}]\n${val}`)
                .join("\n\n");
              setDidInitialContext(basicDocsRef.current);
              // Extract known parts from index
              const indexDoc = docs["01_Index_Vsech_Casti"] || "";
              const names = indexDoc.split("\n")
                .map((l: string) => l.replace(/^[-*•\d_.]\s*/g, "").replace(/^\d+_?/, "").trim())
                .filter((l: string) => l.length > 1 && l.length < 30 && !l.startsWith("["));
              setKnownParts(names.slice(0, 30));
            }
          } catch (e) { console.warn("Basic DID docs preload failed:", e); }
        })();
      }
      prevModeRef.current = mode;
      refreshHistory();
      return;
    }

    if (!pendingHandoffToChat) {
      const saved = loadMessages(mode);
      if (saved && saved.length > 0) setMessages(saved);
      else setMessages([{ role: "assistant", content: welcomeMessages[mode] }]);
    }
    prevModeRef.current = mode;
  }, [mode, setMessages, pendingHandoffToChat, setDidSubMode, setDidInitialContext]);

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
    if (activeThread && messages.length >= 2) {
      didThreads.updateThreadMessages(activeThread.id, messages);
    } else if (didSubMode && messages.length >= 2) {
      saveConversation(didSubMode, messages, didInitialContext, didSessionId ?? undefined);
    }
    clearMessages(mode);
    setDidSubMode(null);
    setDidInitialContext("");
    setDidDocsLoaded(false);
    setDidSessionId(null);
    setActiveThread(null);
    setMessages([]);
    setDidFlowState("entry");
    refreshHistory();
  }, [mode, messages, didSubMode, didInitialContext, didSessionId, activeThread]);

  const handleDidBack = useCallback(() => {
    if (activeThread && messages.length >= 2) {
      didThreads.updateThreadMessages(activeThread.id, messages);
    } else if (didSubMode && messages.length >= 2) {
      saveConversation(didSubMode, messages, didInitialContext, didSessionId ?? undefined);
    }
    setDidSubMode(null);
    setDidInitialContext("");
    setDidDocsLoaded(false);
    setDidSessionId(null);
    setActiveThread(null);
    setMessages([]);
    setDidFlowState("entry");
    refreshHistory();
  }, [didSubMode, messages, didInitialContext, didSessionId, activeThread]);

  const handleRestoreConversation = useCallback(async (id: string) => {
    const conv = await loadConversation(id);
    if (!conv) return;
    setDidSubMode(conv.subMode as DidSubMode);
    setDidInitialContext(conv.didInitialContext);
    setDidDocsLoaded(true);
    setDidSessionId(conv.id);
    setMessages(conv.messages as any);
    setDidFlowState("chat");
    saveMessages(mode, conv.messages);
  }, [loadConversation, setDidSubMode, setDidInitialContext, setMessages, mode]);
  // Thread management for "cast" mode (hooks must be before early return)
  const handleSelectThread = useCallback(async (thread: DidThread) => {
    setActiveThread(thread);
    setMessages(thread.messages as { role: "user" | "assistant"; content: string }[]);
    setDidFlowState("chat");
    // Load part-specific docs in BACKGROUND
    (async () => {
      try {
        const headers = await getAuthHeaders();
        const response = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-drive-read`,
          { method: "POST", headers, body: JSON.stringify({ documents: [`Karta_${thread.partName.replace(/\s+/g, "_")}`] }) }
        );
        if (response.ok) {
          const data = await response.json();
          const docs = data.documents || {};
           const partDocs = Object.entries(docs).map(([key, val]) => `[Kartoteka_DID: ${key}]\n${val}`).join("\n\n");
            setDidInitialContext(basicDocsRef.current + "\n\n" + partDocs);
        }
      } catch {}
    })();
  }, [setMessages, setDidInitialContext]);

  const handleNewCastThread = useCallback(() => {
    setDidFlowState("part-identify");
  }, []);

  const [isPartSelecting, setIsPartSelecting] = useState(false);
  const handlePartSelected = useCallback(async (partName: string) => {
    if (isPartSelecting) return; // Prevent double-click race condition
    setIsPartSelecting(true);
    try {
    // Check for existing thread first (quick DB query)
    const existing = await didThreads.getThreadByPart(partName, "cast");
    if (existing) {
      setActiveThread(existing);
      setMessages(existing.messages as { role: "user" | "assistant"; content: string }[]);
      setDidFlowState("chat");
      toast.info(`Pokračuješ ve vláknu s ${partName}`);
      // Auto-prime with specific part context
      didContextPrime.runPrime(partName, "cast");
      // Load fresh part docs in background
      (async () => {
        try {
          const headers = await getAuthHeaders();
          const response = await fetch(
            `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-drive-read`,
            { method: "POST", headers, body: JSON.stringify({ documents: [`Karta_${partName.replace(/\s+/g, "_")}`] }) }
          );
          if (response.ok) {
            const data = await response.json();
            const docs = data.documents || {};
            const partDocs = Object.entries(docs).map(([key, val]) => `[Kartoteka_DID: ${key}]\n${val}`).join("\n\n");
             setDidInitialContext(basicDocsRef.current + "\n\n" + partDocs);
          }
        } catch {}
      })();
      return;
    }

    // Start chat IMMEDIATELY with familiar greeting — no waiting for docs
    const greeting = getRandomCastGreeting();
    const initialMessages = [{ role: "assistant" as const, content: greeting }];
    
    let partLanguage = "cs";
    const basicCtx = basicDocsRef.current || didInitialContext;
    if (basicCtx.toLowerCase().includes("norsky") || basicCtx.toLowerCase().includes("norština")) partLanguage = "no";
    if (basicCtx.toLowerCase().includes("anglicky") || basicCtx.toLowerCase().includes("english")) partLanguage = "en";

    const thread = await didThreads.createThread(partName, "cast", partLanguage, initialMessages as any);
    if (thread) {
      setActiveThread(thread);
      setMessages(initialMessages as { role: "user" | "assistant"; content: string }[]);
      setDidFlowState("chat");
      // Auto-prime with specific part context
      didContextPrime.runPrime(partName, "cast");
      // Load part-specific docs in BACKGROUND — don't block conversation
      (async () => {
        try {
          const headers = await getAuthHeaders();
          const response = await fetch(
            `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-drive-read`,
            { method: "POST", headers, body: JSON.stringify({ documents: [`Karta_${partName.replace(/\s+/g, "_")}`] }) }
          );
          if (response.ok) {
            const data = await response.json();
            const docs = data.documents || {};
            const partDocs = Object.entries(docs).map(([key, val]) => `[Kartoteka_DID: ${key}]\n${val}`).join("\n\n");
             setDidInitialContext(basicDocsRef.current + "\n\n" + partDocs);
            setDidDocsLoaded(true);
          }
        } catch {}
      })();
    } else {
      toast.error("Nepodařilo se vytvořit vlákno");
      setDidFlowState("thread-list");
    }
    } finally {
      setIsPartSelecting(false);
    }
  }, [didInitialContext, setDidInitialContext, setMessages, isPartSelecting]);

  // ═══ DID Episode Generation — fire-and-forget after thread end ═══
  const triggerEpisodeGeneration = useCallback(async (threadId: string) => {
    try {
      const headers = await getAuthHeaders();
      fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-episode-generate`, {
        method: "POST", headers,
        body: JSON.stringify({ threadId, crossModeScan: true }),
      }).then(res => {
        if (res.ok) console.log("[DID] Episode generation triggered for thread", threadId);
        else console.warn("[DID] Episode generation failed:", res.status);
      }).catch(e => console.warn("[DID] Episode generation error:", e));
    } catch {}
  }, []);

  const handleLeaveThread = useCallback(async () => {
    const threadToProcess = activeThread;
    if (activeThread && messages.length >= 2) {
      await didThreads.updateThreadMessages(activeThread.id, messages);
      // Trigger episode generation in background
      triggerEpisodeGeneration(activeThread.id);
    }
    setActiveThread(null);
    setMessages([]);
    if (didSubMode === "mamka" || didSubMode === "kata") {
      setDidFlowState("therapist-threads");
      didThreads.fetchAllThreads(didSubMode);
    } else {
      setDidFlowState("thread-list");
      didThreads.fetchActiveThreads("cast");
    }
  }, [activeThread, messages, setMessages, didSubMode, triggerEpisodeGeneration]);

  // Quick thread entry from dashboard — load thread directly by ID
  const handleQuickThread = useCallback(async (threadId: string, partName: string) => {
    setDidSubMode("cast");
    setDidFlowState("loading");
    
    // Fetch the thread from DB
    const { data, error } = await supabase
      .from("did_threads")
      .select("*")
      .eq("id", threadId)
      .maybeSingle();
    
    if (error || !data) {
      toast.error("Vlákno nenalezeno");
      setDidFlowState("entry");
      return;
    }
    
    const thread = {
      id: data.id,
      partName: data.part_name,
      partLanguage: data.part_language || "cs",
      subMode: data.sub_mode,
      messages: (data.messages ?? []) as { role: string; content: string }[],
      startedAt: data.started_at,
      lastActivityAt: data.last_activity_at,
      isProcessed: data.is_processed,
    };
    
    setActiveThread(thread);
    setMessages(thread.messages as { role: "user" | "assistant"; content: string }[]);
    setDidFlowState("chat");
    
    // Load part docs in background
    (async () => {
      try {
        const headers = await getAuthHeaders();
        const response = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-drive-read`,
          { method: "POST", headers, body: JSON.stringify({ documents: [`Karta_${partName.replace(/\s+/g, "_")}`] }) }
        );
        if (response.ok) {
          const docData = await response.json();
          const docs = docData.documents || {};
          const partDocs = Object.entries(docs).map(([key, val]) => `[Kartoteka_DID: ${key}]\n${val}`).join("\n\n");
           setDidInitialContext(basicDocsRef.current + "\n\n" + partDocs);
        }
      } catch {}
    })();
    
    toast.info(`Navazuješ na rozhovor s ${partName}`);
  }, [setDidSubMode, setMessages, setDidInitialContext]);

  // Handle ?meeting=<id> URL parameter
  useEffect(() => {
    const meetingParam = searchParams.get("meeting");
    if (meetingParam && hubSection === "did") {
      setMeetingIdFromUrl(meetingParam);
      setMode("childcare");
      setDidFlowState("meeting");
      searchParams.delete("meeting");
      setSearchParams(searchParams, { replace: true });
    }
  }, [searchParams, hubSection]);

  if (!authChecked) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // ── DID-specific handlers ──

  const loadDriveContext = async (): Promise<string> => {
    try {
      const headers = await getAuthHeaders();
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-drive-read`,
        { method: "POST", headers, body: JSON.stringify({ 
          documents: ["01_Index_Vsech_Casti", "00_Aktualni_Dashboard", "Mapa_Vztahu_a_Vazeb", "05_Operativni_Plan", "06_Strategicky_Vyhled"],
          subFolder: "00_CENTRUM",
          allowGlobalSearch: false,
        }) }
      );
      if (response.ok) {
        const data = await response.json();
        const docs = data.documents || {};
        return Object.entries(docs)
          .filter(([, val]) => typeof val === "string" && !val.startsWith("[Dokument"))
          .map(([key, val]) => `[Kartoteka_DID/00_CENTRUM: ${key}]\n${val}`)
          .join("\n\n");
      }
    } catch (e) {
      console.warn("Failed to load DID docs from Drive:", e);
    }
    return "";
  };

  const loadKnownParts = async () => {
    try {
      const headers = await getAuthHeaders();
      // List all files in 01_AKTIVNI_FRAGMENTY to get part names
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-drive-read`,
        { method: "POST", headers, body: JSON.stringify({ listAll: true, subFolder: "01_AKTIVNI_FRAGMENTY" }) }
      );
      if (response.ok) {
        const data = await response.json();
        const files = data.files || [];
        const names = files
          .filter((f: any) => f.mimeType !== "application/vnd.google-apps.folder")
          .map((f: any) => f.name.replace(/^\d+_/, "").replace(/\.(txt|md|doc|docx)$/i, ""));
        setKnownParts(names.slice(0, 30));
      }
    } catch {}
  };

  const handleDidSubModeSelect = async (subMode: DidSubMode) => {
    setDidSubMode(subMode);
    setDidSessionId(null);
    setDidDocsLoaded(false);
    setActiveThread(null);

    if (subMode === "cast") {
      // Use pre-loaded basic docs, just fetch threads
      setDidFlowState("loading");
      await didThreads.fetchActiveThreads("cast");
      // knownParts already loaded during dashboard pre-load
      if (basicDocsRef.current) {
        setDidInitialContext(basicDocsRef.current);
      }
      setDidFlowState("thread-list");
      return;
    }

    if (subMode === "research") {
      // Use pre-loaded basic docs, go straight to chat
      if (basicDocsRef.current) setDidInitialContext(basicDocsRef.current);
      setDidDocsLoaded(true);
      setDidFlowState("chat");
      setMessages([{ role: "assistant", content: "🔬 Jsem připraven prohledat odborné zdroje pro DID systém. Řekni mi téma, metodu nebo situaci – a já najdu relevantní výzkumy a terapeutické přístupy." }]);
      return;
    }

    // mamka / kata / general — DON'T load full docs yet
    // Just start conversation and ask what to discuss
    const newSessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setDidSessionId(newSessionId);
    if (basicDocsRef.current) setDidInitialContext(basicDocsRef.current);
    setDidFlowState("chat");

    const greetings: Record<string, string> = {
      mamka: `Haničko, jsem tady s tebou. Mám přehled o systému.\n\nCo teď potřebuješ? Můžeme řešit:\n- 🧩 **Konkrétní část** nebo klastr\n- 🔥 **Akutní situaci**, kterou potřebuješ probrat\n- 💡 **Obecnou radu** k přístupu nebo metodám\n\nPověz mi, co se děje.`,
      kata: `Ahoj Káťo! 😊 Mám přehled o aktuálním stavu systému.\n\nCo potřebuješ?\n- 🧩 Poradit se ohledně **konkrétní části**?\n- 🔥 Probrat **situaci**, která nastala?\n- 💡 Obecnou **radu** jak reagovat?\n\nŘekni mi, co řešíš.`,
      general: `Haničko, jsem připraven na poradu o DID.\n\nCo bys chtěla probrat?\n- 🧩 **Konkrétní část** nebo klastr\n- 📋 **Strategii** nebo metodu\n- 🔥 **Situaci**, co se stala\n\nPověz mi téma a já si k němu dostuduju potřebné materiály.`,
    };
    setMessages([{ role: "assistant", content: greetings[subMode] || greetings.general }]);
  };

  // Enrich context for mamka/kata/general after their first message
  const enrichContextForSubMode = async (userMessage: string) => {
    if (isEnrichingContext) return;
    setIsEnrichingContext(true);
    try {
      // 1. Detect which parts/topics are mentioned — try to load their specific cards
      const basicCtx = basicDocsRef.current || didInitialContext;
      const mentionedParts = knownParts.filter(p => 
        userMessage.toLowerCase().includes(p.toLowerCase())
      );
      
      // 2. Load specific part cards from Drive
      if (mentionedParts.length > 0) {
        try {
          const headers = await getAuthHeaders();
          const docNames = mentionedParts.map(p => `Karta_${p.replace(/\s+/g, "_")}`);
          const response = await fetch(
            `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-drive-read`,
            { method: "POST", headers, body: JSON.stringify({ documents: docNames }) }
          );
          if (response.ok) {
            const data = await response.json();
            const docs = data.documents || {};
            const partDocs = Object.entries(docs)
              .filter(([, val]) => typeof val === "string" && !val.startsWith("[Dokument"))
              .map(([key, val]) => `[Kartoteka_DID: ${key}]\n${val}`)
              .join("\n\n");
            if (partDocs) {
              setDidInitialContext(prev => prev + "\n\n" + partDocs);
            }
          }
        } catch {}
      }

      // 3. Quick Perplexity pre-research on the topic (non-blocking)
      try {
        const headers = await getAuthHeaders();
        const searchQuery = mentionedParts.length > 0
          ? `DID terapeutické metody pro práci s částí "${mentionedParts[0]}" - ${userMessage.slice(0, 100)}`
          : `DID terapeutické přístupy - ${userMessage.slice(0, 150)}`;
        
        const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-research`, {
          method: "POST", headers,
          body: JSON.stringify({
            query: searchQuery,
            partName: mentionedParts[0] || undefined,
            conversationContext: userMessage,
          }),
        });
        
        if (response.ok && response.body) {
          // Read the streamed response to completion to extract research context
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let researchContent = "";
          let buffer = "";
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
              const jsonStr = line.slice(6).trim();
              if (jsonStr === "[DONE]") break;
              try {
                const parsed = JSON.parse(jsonStr);
                const content = parsed.choices?.[0]?.delta?.content;
                if (content) researchContent += content;
              } catch {}
            }
          }
          if (researchContent) {
            setDidInitialContext(prev => prev + "\n\n[Předběžný výzkum k tématu]\n" + researchContent.slice(0, 3000));
          }
        }
      } catch (e) { console.warn("Pre-research failed:", e); }

      setDidDocsLoaded(true);
    } finally {
      setIsEnrichingContext(false);
    }
  };

  // ── Common handlers (unchanged logic, cleaned up) ──

  const handleSoapHandoff = async () => {
    if (messages.length < 2 || isSoapLoading) return;
    setIsSoapLoading(true);
    try {
      const headers = await getAuthHeaders();
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-soap`, {
        method: "POST", headers,
        body: JSON.stringify({ messages: messages.slice(-40), mode }),
      });
      if (!response.ok) handleApiError(response);
      const soapData = await response.json();
      setReportDraft({
        context: soapData.context || "", keyTheme: soapData.keyTheme || "",
        therapistEmotions: soapData.therapistEmotions || [], transference: soapData.transference || "",
        risks: soapData.risks || [], missingData: soapData.missingData || "",
        interventionsTried: soapData.interventionsTried || "", nextSessionGoal: soapData.nextSessionGoal || "",
      });
      setMainMode("report");
      toast.success("Zápis připraven, formulář předvyplněn");
    } catch (error) {
      console.error("SOAP error:", error);
      toast.error(error instanceof Error ? error.message : "Chyba při vytváření zápisu");
    } finally { setIsSoapLoading(false); }
  };

  const handleStudyMaterial = async () => {
    if (messages.length < 2 || isStudyLoading) return;
    setIsStudyLoading(true);
    try {
      const headers = await getAuthHeaders();
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-study-material`, {
        method: "POST", headers, body: JSON.stringify({ messages: messages.slice(-60) }),
      });
      if (!response.ok) handleApiError(response);
      const { material } = await response.json();
      if (!material) throw new Error("Prázdná odpověď");
      setStudyMaterial(material);
      toast.success("Učební materiál vygenerován");
    } catch (error) {
      console.error("Study material error:", error);
      toast.error(error instanceof Error ? error.message : "Chyba při generování materiálu");
    } finally { setIsStudyLoading(false); }
  };

  const handleAudioAnalysis = async () => {
    if (isAudioAnalyzing) return;
    setIsAudioAnalyzing(true);
    try {
      const base64 = await audioRecorder.getBase64();
      if (!base64) throw new Error("Žádná nahrávka");
      const chatContext = messages.slice(-10).map(m =>
        `${m.role === "user" ? "TERAPEUT" : "KAREL"}: ${typeof m.content === "string" ? m.content : "(multimodal)"}`
      ).join("\n");
      const headers = await getAuthHeaders();
      
      // Build DID-specific context for audio analysis
      const didContext = mode === "childcare" ? {
        didMode: true,
        partName: activeThread?.partName || undefined,
        didSubMode,
        systemContext: didInitialContext ? didInitialContext.slice(0, 2000) : undefined,
      } : undefined;

      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-audio-analysis`, {
        method: "POST", headers,
        body: JSON.stringify({ 
          audioBase64: base64, mode, 
          chatContext: messages.length > 0 ? chatContext : undefined,
          ...didContext,
        }),
      });
      if (!response.ok) handleApiError(response);
      const { analysis } = await response.json();
      if (!analysis) throw new Error("Prázdná analýza");
      setMessages(prev => [...prev,
        { role: "user", content: `🎙️ *[Audio nahrávka${activeThread ? ` – tandem s ${activeThread.partName}` : ""} odeslána k analýze]*` },
        { role: "assistant", content: analysis },
      ]);
      audioRecorder.discardRecording();
      toast.success("Audio analýza dokončena");
    } catch (error) {
      console.error("Audio analysis error:", error);
      toast.error(error instanceof Error ? error.message : "Chyba při analýze audia");
    } finally { setIsAudioAnalyzing(false); }
  };

  const handleAutoAnalyze = async () => {
    if (isFileAnalyzing || attachments.length === 0 || attachments.some(a => a.uploading)) return;
    setIsFileAnalyzing(true);
    try {
      const chatContext = messages.slice(-10).map(m =>
        `${m.role === "user" ? "TERAPEUT" : "KAREL"}: ${typeof m.content === "string" ? m.content : "(multimodal)"}`
      ).join("\n");
      const attSummary = attachments.map(a => `📎 ${a.name}`).join(", ");
      setMessages(prev => [...prev, { role: "user", content: `🔍 *[Analýza příloh: ${attSummary}]*` }]);
      const headers = await getAuthHeaders();
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-analyze-file`, {
        method: "POST", headers,
        body: JSON.stringify({
          attachments: attachments.map(a => ({
            name: a.name, type: a.type, size: a.size, category: a.category,
            dataUrl: a.dataUrl, storagePath: a.storagePath, driveFileId: a.driveFileId,
          })),
          mode, chatContext: messages.length > 0 ? chatContext : undefined,
        }),
      });
      if (!response.ok) handleApiError(response);
      const { analysis } = await response.json();
      if (!analysis) throw new Error("Prázdná analýza");
      setMessages(prev => [...prev, { role: "assistant", content: analysis }]);
      clearAttachments();
      toast.success("Analýza souborů dokončena");
    } catch (error) {
      console.error("File analysis error:", error);
      toast.error(error instanceof Error ? error.message : "Chyba při analýze souborů");
    } finally { setIsFileAnalyzing(false); }
  };


  // 📓 Zapsat do deníku — Karel připraví zápis, část ho odsouhlasí
  const handleWriteDiary = () => {
    if (!activeThread || isLoading) return;
    const diaryPrompt = `📓 Připrav zápis do deníku z našeho dnešního rozhovoru. Shrň co jsme probírali, jakou náladu jsem měl/a a co by stálo za zapamatování. Ukaž mi to – můžu to upravit než to uložíš.`;
    setInput(diaryPrompt);
    // Auto-send
    setTimeout(() => {
      const btn = document.querySelector('[data-send-btn]') as HTMLButtonElement;
      if (btn) btn.click();
    }, 100);
  };

  // (triggerEpisodeGeneration defined above, near handleLeaveThread)

  const handleDidEndCall = async () => {
    const threadToProcess = activeThread;
    if (activeThread && messages.length >= 2) {
      await didThreads.updateThreadMessages(activeThread.id, messages);
    } else if (didSubMode && messages.length >= 2) {
      saveConversation(didSubMode, messages, didInitialContext, didSessionId ?? undefined);
    }

    // Trigger episode generation in background
    if (threadToProcess && messages.length >= 2) {
      triggerEpisodeGeneration(threadToProcess.id);
    }

    toast.info("Vlákno uloženo. Epizoda se generuje na pozadí.");

    const endedPartName = activeThread?.partName || "";
    clearMessages(mode);
    setActiveThread(null);
    const postCallSessionId = `postcall-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setDidSubMode("mamka");
    setDidSessionId(postCallSessionId);
    setDidFlowState("chat");
    setMessages([{ role: "assistant", content: `Haničko, právě skončil rozhovor${endedPartName ? ` s částí ${endedPartName}` : ""}.

Vlákno je uložené a epizoda se právě generuje. Karty i souhrnný report se zpracují při nejbližší automatické nebo manuální aktualizaci kartotéky.` }]);
  };

  const handleDidResearch = async () => {
    if (isDidResearchLoading) return;
    const lastUserMsg = [...messages].reverse().find(m => m.role === "user");
    const searchContext = messages.slice(-10).map(m =>
      `${m.role === "user" ? "UŽIVATEL" : "KAREL"}: ${typeof m.content === "string" ? m.content.slice(0, 200) : "(multimodal)"}`
    ).join("\n");
    setMessages(prev => [...prev, { role: "user", content: "🔬 Hledej terapeutické metody a výzkumy relevantní pro naši situaci" }]);
    setIsDidResearchLoading(true);
    let assistantContent = "";
    try {
      const headers = await getAuthHeaders();
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-research`, {
        method: "POST", headers,
        body: JSON.stringify({
          query: lastUserMsg ? (typeof lastUserMsg.content === "string" ? lastUserMsg.content : "DID terapeutické metody") : "DID terapeutické metody",
          partName: activeThread?.partName || undefined,
          conversationContext: searchContext,
        }),
      });
      if (!response.ok) handleApiError(response);
      if (!response.body) throw new Error("Žádná odpověď");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      setMessages(prev => [...prev, { role: "assistant", content: "" }]);
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          let line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
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
              setMessages(prev => {
                const n = [...prev];
                if (n[n.length - 1]?.role === "assistant") n[n.length - 1] = { ...n[n.length - 1], content: assistantContent };
                return n;
              });
            }
          } catch { buffer = line + "\n" + buffer; break; }
        }
      }
      toast.success("Výzkum dokončen");
    } catch (error) {
      console.error("DID Research error:", error);
      toast.error(error instanceof Error ? error.message : "Chyba při vyhledávání");
      if (!assistantContent) setMessages(prev => prev.slice(0, -1));
    } finally { setIsDidResearchLoading(false); }
  };

  const handleManualUpdate = async () => {
    if (isManualUpdateLoading) return;
    // First save ALL current data to DB before triggering cycle
    if (activeThread && messages.length >= 2) {
      await didThreads.updateThreadMessages(activeThread.id, messages);
    }
    if (didSubMode && messages.length >= 2) {
      await saveConversation(didSubMode, messages, didInitialContext, didSessionId ?? undefined);
    }
    // Small delay to ensure DB writes complete
    await new Promise(r => setTimeout(r, 500));

    setIsManualUpdateLoading(true);
    try {
      const headers = await getAuthHeaders();
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-daily-cycle`, {
        method: "POST", headers, body: JSON.stringify({}),
      });
      if (!response.ok) {
        const errorBody = await response.text();
        console.error("Manual update response:", response.status, errorBody);
        throw new Error(`Chyba ${response.status}: ${errorBody.slice(0, 200)}`);
      }
      const result = await response.json();
      const updatedCardsCount = Array.isArray(result.cardsUpdated) ? result.cardsUpdated.length : 0;
      const totalProcessed = (result.threadsProcessed || 0) + (result.conversationsProcessed || 0);
      const cardNames = Array.isArray(result.cardsUpdated) ? result.cardsUpdated.join(", ") : "";
      toast.success(`Aktualizace dokončena – ${totalProcessed} vláken, ${updatedCardsCount} karet${cardNames ? `: ${cardNames}` : ""}`);

      // Phase 2: Automatically sync registry (backfill missing columns C-F)
      try {
        toast.info("Synchronizuji registr – načítám seznam karet...");
        const syncHeaders = await getAuthHeaders();
        const listRes = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-daily-cycle`, {
          method: "POST", headers: syncHeaders,
          body: JSON.stringify({ syncRegistry: true, syncMode: "list" }),
        });
        const listData = await listRes.json();
        const entries = listData.entries || [];
        const total = entries.length;
        let synced = 0, skipped = 0, errors = 0;
        setSyncProgress({ current: 0, total, currentName: "..." });
        for (let i = 0; i < total; i++) {
          const entry = entries[i];
          const displayName = (entry.fileName || "").replace(/^\d+_/, "").replace(/\.[^.]+$/, "");
          setSyncProgress({ current: i + 1, total, currentName: displayName });
          try {
            const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-daily-cycle`, {
              method: "POST", headers: syncHeaders,
              body: JSON.stringify({ syncRegistry: true, syncMode: "process_one", fileId: entry.fileId, fileName: entry.fileName, folderLabel: entry.folderLabel }),
            });
            const data = await res.json();
            if (data.result === "skip") skipped++;
            else synced++;
          } catch { errors++; }
        }
        setSyncProgress(null);
        if (synced > 0 || skipped > 0) toast.success(`Registr: ${synced} aktualizováno, ${skipped} přeskočeno${errors ? `, ${errors} chyb` : ""}`);
      } catch (e) {
        console.warn("Registry sync failed:", e);
        setSyncProgress(null);
      }

      // Clear ALL local DID data after successful update
      setActiveThread(null);
      setMessages([]);
      setDidSubMode(null);
      setDidInitialContext("");
      setDidDocsLoaded(false);
      setDidSessionId(null);
      setDidFlowState("entry");
      clearMessages("childcare");
      try {
        localStorage.removeItem("karel_did_submode");
        localStorage.removeItem("karel_did_context");
        localStorage.removeItem(DID_DOCS_LOADED_KEY);
        localStorage.removeItem(DID_SESSION_ID_KEY);
      } catch {}
      refreshHistory();
    } catch (error) {
      console.error("Manual update error:", error);
      toast.error(error instanceof Error ? error.message : "Chyba při aktualizaci kartotéky");
    } finally { setIsManualUpdateLoading(false); }
  };

  const handleReformatCards = async () => {
    if (isReformatting) return;
    setIsReformatting(true);
    setReformatProgress(null);
    toast.info("Načítám seznam karet...");
    try {
      const headers = await getAuthHeaders();
      const listRes = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-reformat-cards`,
        { method: "POST", headers, body: JSON.stringify({ mode: "list" }) }
      );
      const listData = await listRes.json();
      if (!listRes.ok) throw new Error(listData.error);

      const entries = listData.entries || [];
      const txtContentByPart = listData.txtContentByPart || {};
      const total = entries.length;
      let reformatted = 0, notFound = 0, errors = 0;

      toast.info(`Přeformátování ${total} karet zahájeno...`);

      for (let i = 0; i < total; i++) {
        const entry = entries[i];
        setReformatProgress({ current: i + 1, total, currentName: entry.name });
        try {
          const res = await fetch(
            `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-reformat-cards`,
            { method: "POST", headers, body: JSON.stringify({ mode: "process_one", index: i, txtContentForPart: txtContentByPart[entry.name] || "" }) }
          );
          const data = await res.json();
          if (data.result === "reformatted") reformatted++;
          else if (data.result === "not_found") notFound++;
          else errors++;
        } catch (e) {
          console.error(`Card ${entry.name} failed:`, e);
          errors++;
        }
      }

      if ((listData.txtFiles || []).length > 0) {
        try {
          await fetch(
            `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-reformat-cards`,
            { method: "POST", headers, body: JSON.stringify({ mode: "cleanup_txt" }) }
          );
        } catch {}
      }

      toast.success(`Hotovo! Přeformátováno: ${reformatted}/${total}, nenalezeno: ${notFound}, chyby: ${errors}`);
    } catch (e) {
      toast.error("Přeformátování selhalo");
      console.error(e);
    } finally {
      setIsReformatting(false);
      setReformatProgress(null);
    }
  };

  const handleGenerateHandbook = async () => {
    if (isHandbookLoading) return;
    setIsHandbookLoading(true);
    try {
      const { generateKataHandbook } = await import("@/lib/didPdfExport");
      // Pass current kata conversation messages for inclusion in the handbook
      const currentMessages = (didSubMode === "kata" && messages.length >= 2) ? messages : undefined;
      await generateKataHandbook(currentMessages);
      toast.success("Příručka pro Káťu vygenerována a stažena");
    } catch (error) {
      console.error("Handbook error:", error);
      toast.error("Chyba při generování příručky");
    } finally {
      setIsHandbookLoading(false);
    }
  };

  const handleResearchHandbook = async () => {
    if (isResearchHandbookLoading || !activeResearchThread || messages.length < 2) return;
    setIsResearchHandbookLoading(true);
    try {
      const { generateResearchHandbook } = await import("@/lib/didPdfExport");
      await generateResearchHandbook(messages, activeResearchThread.topic, activeResearchThread.createdBy);
      toast.success("Příručka z profesních zdrojů vygenerována a stažena");
    } catch (error) {
      console.error("Research handbook error:", error);
      toast.error("Chyba při generování příručky");
    } finally {
      setIsResearchHandbookLoading(false);
    }
  };

  const sendMessage = async () => {
    if ((!input.trim() && attachments.length === 0) || isLoading) return;
    const userMessage = input.trim();
    const currentAttachments = [...attachments];
    setInput("");
    clearAttachments();
    const userContent = buildAttachmentContent(userMessage, currentAttachments);
    setMessages((prev) => [...prev, { role: "user", content: userContent as any }]);
    setIsLoading(true);
    let assistantContent = "";
    try {
      const headers = await getAuthHeaders();
      const isResearch = mode === "research" || (mode === "childcare" && didSubMode === "research");
      const endpoint = isResearch ? "karel-research" : "karel-chat";
      // Limit messages to last 30 and didInitialContext to 80k chars to avoid request size issues
      const recentMessages = [...messages.slice(-30), { role: "user", content: userContent }];
      const trimmedContext = didInitialContext && didInitialContext.length > 80000
        ? didInitialContext.slice(0, 80000) + "\n[...kontext zkrácen...]"
        : didInitialContext;
      const body = isResearch
        ? { query: userMessage, conversationHistory: messages.slice(-20), createdBy: activeResearchThread?.createdBy || "Hana" }
        : {
            messages: recentMessages,
            mode,
            ...(mode === "childcare" && trimmedContext ? { didInitialContext: trimmedContext } : {}),
            ...(mode === "childcare" && didSubMode ? { didSubMode } : {}),
            ...(mode === "childcare" && didContextPrime.primeCache ? { didContextPrimeCache: didContextPrime.primeCache } : {}),
            ...(mode === "childcare" && activeThread ? { didPartName: activeThread.partName } : {}),
          };
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 90000);
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${endpoint}`, {
        method: "POST", headers, body: JSON.stringify(body), signal: controller.signal,
      });
      clearTimeout(timeout);
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
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          let line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
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
                const n = [...prev];
                if (n[n.length - 1]?.role === "assistant") n[n.length - 1] = { ...n[n.length - 1], content: assistantContent };
                return n;
              });
            }
          } catch { buffer = line + "\n" + buffer; break; }
        }
      }

      // ═══ SWITCH DETECTION: If Karel detects a switch, update the thread part_name ═══
      if (activeThread && didSubMode === "cast" && assistantContent) {
        const switchMatch = assistantContent.match(/\[SWITCH:([^\]]+)\]/);
        if (switchMatch) {
          const newPartName = switchMatch[1].trim();
          if (newPartName && newPartName.toLowerCase() !== activeThread.partName.toLowerCase()) {
            console.log(`[switch-detect] Part switched from "${activeThread.partName}" to "${newPartName}"`);
            // Update thread in DB
            await supabase
              .from("did_threads")
              .update({ part_name: newPartName })
              .eq("id", activeThread.id);
            // Update local state
            setActiveThread(prev => prev ? { ...prev, partName: newPartName } : prev);
            toast.info(`Switch detekován: ${activeThread.partName} → ${newPartName}`);
          }
          // Clean the switch marker from displayed message
          assistantContent = assistantContent.replace(/\[SWITCH:[^\]]+\]/g, "").trim();
          setMessages((prev) => {
            const n = [...prev];
            if (n[n.length - 1]?.role === "assistant") n[n.length - 1] = { ...n[n.length - 1], content: assistantContent };
            return n;
          });
        }
      }

      // Detect and process [ODESLAT_VZKAZ:mamka/kata] markers for immediate email sending
      if (mode === "childcare" && assistantContent) {
        const vzkazRegex = /\[ODESLAT_VZKAZ:(mamka|kata)\]([\s\S]*?)\[\/ODESLAT_VZKAZ\]/g;
        let match;
        while ((match = vzkazRegex.exec(assistantContent)) !== null) {
          const recipient = match[1]; // "mamka" or "kata"
          const messageText = match[2].trim();
          if (messageText) {
            const recipientEmail = recipient === "kata" ? "K.CC@seznam.cz" : "mujosobniasistentnamiru@gmail.com";
            const recipientName = recipient === "kata" ? "Káťa" : "Mamka";
            // Fire-and-forget email send
            (async () => {
              try {
                const emailHeaders = await getAuthHeaders();
                const emailRes = await fetch(
                  `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-email-report`,
                  {
                    method: "POST",
                    headers: emailHeaders,
                    body: JSON.stringify({
                      reportContent: messageText,
                      partName: activeThread?.partName || "část",
                      date: new Date().toLocaleDateString("cs-CZ"),
                      type: recipient === "kata" ? "did_message_kata" : "did_message_mom",
                      recipientEmail,
                    }),
                  }
                );
                if (emailRes.ok) {
                  toast.success(`✉️ Vzkaz odeslán pro ${recipientName}`);
                } else {
                  toast.error(`Nepodařilo se odeslat vzkaz pro ${recipientName}`);
                }
              } catch (e) {
                console.error("Email send error:", e);
                toast.error(`Chyba při odesílání vzkazu pro ${recipientName}`);
              }
            })();
          }
        }

        // Clean the markers from displayed message
        const cleanedContent = assistantContent.replace(/\[ODESLAT_VZKAZ:(mamka|kata)\]([\s\S]*?)\[\/ODESLAT_VZKAZ\]/g, "").trim();
        if (cleanedContent !== assistantContent) {
          assistantContent = cleanedContent;
          setMessages((prev) => {
            const n = [...prev];
            if (n[n.length - 1]?.role === "assistant") n[n.length - 1] = { ...n[n.length - 1], content: cleanedContent };
            return n;
          });
        }
      }
      // Trigger background enrichment for mamka/kata/general on first substantive message
      if (mode === "childcare" && !didDocsLoaded && !activeThread &&
          (didSubMode === "mamka" || didSubMode === "kata" || didSubMode === "general") &&
          messages.length <= 2 && userMessage.length > 5) {
        enrichContextForSubMode(userMessage);
      }
    } catch (error) {
      console.error("Chat error:", error, "mode:", mode, "didSubMode:", didSubMode);
      const errMsg = error instanceof Error ? error.message : "Chyba při komunikaci";
      toast.error(errMsg === "Failed to fetch" ? "Spojení selhalo. Zkus to prosím znovu." : errMsg);
      if (!assistantContent) setMessages((prev) => prev.slice(0, -1));
    } finally {
      setIsLoading(false);
      textareaRef.current?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  const LoadingSkeleton = () => (
    <div className="flex justify-start">
      <div className="chat-message-assistant">
        <div className="flex items-center gap-3">
          <Loader2 className="w-5 h-5 animate-spin text-primary" />
          <div className="space-y-2 flex-1">
            <div className="h-3 bg-muted rounded animate-pulse w-48" />
            <div className="h-3 bg-muted rounded animate-pulse w-32" />
          </div>
        </div>
      </div>
    </div>
  );

  // ── Render ──

  const renderDidContent = () => {
    // Entry screen: Terapeut / Kluci
    if (didFlowState === "entry" && !didSubMode) {
      return (
        <ScrollArea className="flex-1">
           <DidEntryScreen
            onSelectTerapeut={() => {
              setDidFlowState("terapeut");
              // Auto-prime DID context in background
              didContextPrime.runPrime(undefined, "mamka");
            }}
            onSelectKluci={() => {
              setDidSubMode("cast");
              setDidFlowState("loading");
              // Auto-prime DID context in background
              didContextPrime.runPrime(undefined, "cast");
              (async () => {
                await didThreads.fetchActiveThreads("cast");
                if (basicDocsRef.current) setDidInitialContext(basicDocsRef.current);
                setDidFlowState("thread-list");
              })();
            }}
            onBack={() => navigate("/hub")}
          />
        </ScrollArea>
      );
    }

    // Terapeut view: Dashboard + Hanička/Káťa buttons
    if (didFlowState === "terapeut" && !didSubMode) {
      return (
        <ScrollArea className="flex-1">
          <DidDashboard onManualUpdate={handleManualUpdate} isUpdating={isManualUpdateLoading} syncProgress={syncProgress} onQuickSubMode={handleDidSubModeSelect} onQuickThread={handleQuickThread} contextDocs={didInitialContext || basicDocsRef.current} />
          <div className="max-w-2xl mx-auto px-3 sm:px-4 pb-6">
            <h3 className="text-sm font-medium text-foreground mb-3 text-center">Kdo mluví s Karlem?</h3>
            <div className="space-y-2">
              <button
                onClick={() => { setDidSubMode("mamka"); setDidFlowState("pin-entry"); }}
                className="w-full flex items-center gap-3 p-3 rounded-xl border-2 border-border bg-card hover:border-pink-500/50 hover:bg-card/80 transition-all text-left border-l-4 border-l-pink-500"
              >
                <span className="text-lg">💗</span>
                <div>
                  <div className="font-medium text-foreground">Hanička</div>
                  <div className="text-xs text-muted-foreground">Supervize, analýza, plánování – Karel pracuje jako tandem-terapeut</div>
                </div>
              </button>
              <button
                onClick={() => { setDidSubMode("kata"); setDidFlowState("pin-entry"); }}
                className="w-full flex items-center gap-3 p-3 rounded-xl border-2 border-border bg-card hover:border-blue-500/50 hover:bg-card/80 transition-all text-left border-l-4 border-l-blue-500"
              >
                <span className="text-lg">💙</span>
                <div>
                  <div className="font-medium text-foreground">Káťa</div>
                  <div className="text-xs text-muted-foreground">Konzultace – jak reagovat, jak oslovit části, jak podporovat systém</div>
                </div>
              </button>
              <button
                onClick={() => { setDidFlowState("meeting"); setMeetingTherapist("hanka"); }}
                className="w-full flex items-center gap-3 p-3 rounded-xl border-2 border-border bg-card hover:border-primary/50 hover:bg-card/80 transition-all text-left border-l-4 border-l-amber-500"
              >
                <span className="text-lg">📋</span>
                <div>
                  <div className="font-medium text-foreground">Porady týmu</div>
                  <div className="text-xs text-muted-foreground">Asynchronní porady – Karel moderuje, oba terapeuti přispívají</div>
                </div>
              </button>
            </div>
            <div className="flex justify-center mt-4">
              <Button variant="ghost" size="sm" onClick={() => setDidFlowState("entry")}>
                ← Zpět
              </Button>
            </div>
          </div>
        </ScrollArea>
      );
    }

    // Meeting view
    if (didFlowState === "meeting") {
      return (
        <DidMeetingPanel
          meetingId={meetingIdFromUrl}
          therapist={meetingTherapist}
          onBack={() => {
            setDidFlowState("terapeut");
            setMeetingIdFromUrl(null);
          }}
        />
      );
    }

    // PIN entry for therapists
    if (didFlowState === "pin-entry" && (didSubMode === "mamka" || didSubMode === "kata")) {
      const name = didSubMode === "mamka" ? "Hanička" : "Káťa";
      return (
        <DidPinEntry
          therapistName={name}
          onSuccess={async () => {
            setDidFlowState("loading");
            await didThreads.fetchAllThreads(didSubMode);
            if (basicDocsRef.current) setDidInitialContext(basicDocsRef.current);
            
            // AUTO-PREP: Load therapist tasks, recent threads, motivation profile
            try {
              const tn = didSubMode === "mamka" ? "hanka" : "kata";
              const [tasksRes, threadsRes, profileRes] = await Promise.all([
                supabase.from("did_therapist_tasks").select("task, assigned_to, status_hanka, status_kata, priority, due_date").neq("status", "done").order("created_at", { ascending: false }).limit(15),
                supabase.from("did_threads").select("part_name, messages, last_activity_at").eq("sub_mode", didSubMode).order("last_activity_at", { ascending: false }).limit(3),
                supabase.from("did_motivation_profiles").select("*").eq("therapist", tn).limit(1).maybeSingle(),
              ]);
              let ctx = "";
              const tasks = (tasksRes.data || []).filter((t: any) => t.assigned_to === "both" || t.assigned_to === tn);
              if (tasks.length > 0) {
                ctx += `\n\n[AUTO-PREP: Úkoly pro ${tn}]\n` + tasks.slice(0, 10).map((t: any) => {
                  const st = didSubMode === "mamka" ? t.status_hanka : t.status_kata;
                  return `- [${st}] ${t.task} (${t.priority}${t.due_date ? `, ${t.due_date}` : ""})`;
                }).join("\n");
              }
              const thr = threadsRes.data || [];
              if (thr.length > 0) {
                ctx += `\n\n[AUTO-PREP: Poslední rozhovory]\n` + thr.map((t: any) => {
                  const msgs = ((t.messages as any[]) || []).slice(-3);
                  const preview = msgs.map((m: any) => `${m.role === "user" ? "T" : "K"}: ${typeof m.content === "string" ? m.content.slice(0, 60) : ""}`).join(" | ");
                  return `- ${t.part_name}: ${preview}`;
                }).join("\n");
              }
              const p = profileRes.data;
              if (p) ctx += `\n\n[AUTO-PREP: Profil ${tn}] Styl: ${p.preferred_style}, Streak: ${p.streak_current}/${p.streak_best}, Splněno/Nesplněno: ${p.tasks_completed}/${p.tasks_missed}`;
              if (ctx) setDidInitialContext(prev => prev ? prev + ctx : ctx);
            } catch (e) { console.warn("Auto-prep failed:", e); }
            
            setDidFlowState("therapist-threads");
          }}
          onBack={() => { setDidSubMode(null); setDidFlowState("terapeut"); }}
        />
      );
    }

    // Therapist thread list (Hanička/Káťa)
    if (didFlowState === "therapist-threads" && (didSubMode === "mamka" || didSubMode === "kata")) {
      const name = didSubMode === "mamka" ? "Hanička" : "Káťa";
      return (
        <ScrollArea className="flex-1">
          <DidTherapistThreads
            therapistName={name}
            threads={didThreads.threads}
            onSelectThread={(thread) => {
              setActiveThread(thread);
              setMessages(thread.messages as { role: "user" | "assistant"; content: string }[]);
              setDidFlowState("chat");
              // Load docs in background
              (async () => {
                try {
                  const headers = await getAuthHeaders();
                  const response = await fetch(
                    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-drive-read`,
                    { method: "POST", headers, body: JSON.stringify({
                      documents: ["01_Index_Vsech_Casti", "00_Aktualni_Dashboard", "05_Operativni_Plan", "06_Strategicky_Vyhled"],
                      subFolder: "00_CENTRUM",
                      allowGlobalSearch: false,
                    }) }
                  );
                  if (response.ok) {
                    const data = await response.json();
                    const docs = data.documents || {};
                    const enriched = Object.entries(docs)
                      .filter(([, val]) => typeof val === "string" && !(val as string).startsWith("[Dokument"))
                      .map(([key, val]) => `[Kartoteka_DID/00_CENTRUM: ${key}]\n${val}`)
                      .join("\n\n");
                    setDidInitialContext(prev => prev ? prev + "\n\n" + enriched : enriched);
                  }
                } catch {}
              })();
            }}
            onDeleteThread={(id) => didThreads.deleteThread(id)}
            onNewThread={async () => {
              const greetings: Record<string, string> = {
                mamka: `Haničko, jsem tady s tebou. Mám přehled o systému.\n\nCo teď potřebuješ? Můžeme řešit:\n- 🧩 **Konkrétní část** nebo klastr\n- 🔥 **Akutní situaci**, kterou potřebuješ probrat\n- 💡 **Obecnou radu** k přístupu nebo metodám\n\nPověz mi, co se děje.`,
                kata: `Ahoj Káťo! 😊 Mám přehled o aktuálním stavu systému.\n\nCo potřebuješ?\n- 🧩 Poradit se ohledně **konkrétní části**?\n- 🔥 Probrat **situaci**, která nastala?\n- 💡 Obecnou **radu** jak reagovat?\n\nŘekni mi, co řešíš.`,
              };
              const greeting = greetings[didSubMode!] || greetings.mamka;
              const initialMsgs = [{ role: "assistant" as const, content: greeting }];
              const thread = await didThreads.createThread(name, didSubMode!, "cs", initialMsgs as any);
              if (thread) {
                setActiveThread(thread);
                setMessages(initialMsgs as { role: "user" | "assistant"; content: string }[]);
                setDidFlowState("chat");
              }
            }}
            onBack={() => { setDidSubMode(null); setDidFlowState("terapeut"); }}
          />
        </ScrollArea>
      );
    }

    if (!didSubMode) {
      // Fallback
      return (
        <ScrollArea className="flex-1">
          <DidEntryScreen
            onSelectTerapeut={() => setDidFlowState("terapeut")}
            onSelectKluci={() => {
              setDidSubMode("cast");
              setDidFlowState("thread-list");
            }}
            onBack={() => setMode("debrief")}
          />
        </ScrollArea>
      );
    }

    if (didFlowState === "loading") {
      return (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-3">
            <Loader2 className="w-8 h-8 animate-spin text-primary mx-auto" />
            <p className="text-sm text-muted-foreground">Připravuji DID režim...</p>
          </div>
        </div>
      );
    }

    if (didFlowState === "thread-list" && didSubMode === "cast") {
      return (
        <ScrollArea className="flex-1">
          <DidThreadList
            threads={didThreads.threads}
            onSelectThread={handleSelectThread}
            onDeleteThread={(id) => didThreads.deleteThread(id)}
            onNewThread={handleNewCastThread}
          />
          <div className="flex justify-center pb-4">
            <Button variant="ghost" size="sm" onClick={handleDidBack}>
              ← Zpět
            </Button>
          </div>
        </ScrollArea>
      );
    }

    if (didFlowState === "part-identify") {
      return (
        <DidPartIdentifier
          knownParts={knownParts}
          onSelectPart={handlePartSelected}
          onBack={() => setDidFlowState("thread-list")}
        />
      );
    }

    // Chat view (all DID submodes)
    return (
      <>
        {/* Chat Messages */}
        <ScrollArea className="flex-1 px-2 sm:px-4" ref={scrollRef}>
          <div className="max-w-4xl mx-auto py-3 sm:py-6 space-y-3 sm:space-y-4">
            {/* Thread indicator for cast mode */}
            {activeThread && (
              <div className="text-center text-xs text-muted-foreground bg-muted/50 rounded-lg py-2 px-3">
                Vlákno: <strong>{activeThread.partName}</strong> • {activeThread.partLanguage !== "cs" ? `jazyk: ${activeThread.partLanguage} • ` : ""}{activeThread.messages.length} zpráv
              </div>
            )}
            {messages.map((message, index) => (
              <ChatMessage key={index} message={message} />
            ))}
            {isLoading && messages[messages.length - 1]?.role === "user" && <LoadingSkeleton />}
            {isEnrichingContext && (
              <div className="text-center text-[10px] text-muted-foreground animate-pulse">
                📚 Dostudovávám materiály k tématu...
              </div>
            )}
          </div>
        </ScrollArea>

        {/* Input Area */}
        <div className="border-t border-border bg-card/50 backdrop-blur-sm">
          <div className="max-w-4xl mx-auto px-2 sm:px-4 py-2 sm:py-4">
            <div className="flex gap-2 sm:gap-3 items-end relative">
              <UniversalAttachmentBar
                attachments={attachments} onRemove={removeAttachment}
                onOpenFilePicker={openFilePicker} onCaptureScreenshot={captureScreenshot}
                onOpenDrivePicker={() => setDrivePickerOpen(true)} onAutoAnalyze={handleAutoAnalyze}
                disabled={isLoading || isSoapLoading}
                fileInputRef={fileInputRef as React.RefObject<HTMLInputElement>}
                onFileChange={handleFileChange} isAnalyzing={isFileAnalyzing}
              />
              <Textarea
                ref={textareaRef} value={input}
                onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown}
                placeholder="Napiš svou zprávu..."
                className="flex-1 min-w-0 min-h-[44px] sm:min-h-[56px] max-h-[150px] sm:max-h-[200px] resize-none text-sm sm:text-base"
                disabled={isLoading || isSoapLoading}
              />
              <Button
                onClick={sendMessage}
                disabled={(!input.trim() && attachments.length === 0) || isLoading || isSoapLoading}
                size="icon" className="h-[44px] w-[44px] sm:h-[56px] sm:w-[56px] shrink-0"
              >
                {isLoading ? <Loader2 className="w-4 h-4 sm:w-5 sm:h-5 animate-spin" /> : <Send className="w-4 h-4 sm:w-5 sm:h-5" />}
              </Button>
            </div>
            {/* Action buttons row */}
            <div className="flex items-center gap-2 flex-wrap mt-2">
              <AudioRecordButton
                state={audioRecorder.state} duration={audioRecorder.duration}
                maxDuration={audioRecorder.maxDuration} audioUrl={audioRecorder.audioUrl}
                isAnalyzing={isAudioAnalyzing} onStart={audioRecorder.startRecording}
                onStop={audioRecorder.stopRecording} onDiscard={audioRecorder.discardRecording}
                onSend={handleAudioAnalysis} disabled={isLoading || isSoapLoading}
              />
            </div>
            {messages.length > 1 && (
              <DidActionButtons
                subMode={didSubMode}
                onEndCall={handleDidEndCall}
                onManualUpdate={handleManualUpdate}
                onLeaveThread={(didSubMode === "cast" || didSubMode === "mamka" || didSubMode === "kata") && activeThread ? handleLeaveThread : undefined}
                onGenerateHandbook={didSubMode === "kata" ? handleGenerateHandbook : undefined}
                onWriteDiary={didSubMode === "cast" && activeThread ? handleWriteDiary : undefined}
                isUpdateLoading={isManualUpdateLoading}
                isHandbookLoading={isHandbookLoading}
                disabled={isLoading}
              />
            )}
            <p className="text-xs text-muted-foreground mt-1.5 sm:mt-2 text-center">
              Soukromé temenos. Konverzace zůstává jen v tvém prohlížeči.
            </p>
          </div>
        </div>
      </>
    );
  };

  // Hierarchical back logic for Hana section
  const getHanaBackAction = () => {
    if (mainMode === "report") {
      if (activeSession && (liveSessionStarted || sessionReport)) {
        return { label: "← Zpět", action: () => { setLiveSessionStarted(false); setSessionReport(null); } };
      }
      if (activeSession) {
        return { label: "← Klienti", action: () => clearActiveSession() };
      }
    }
    return { label: "← Hub", action: () => navigate("/hub") };
  };

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-3 sm:px-4 py-2.5 sm:py-4 flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <Button variant="ghost" size="sm" onClick={() => {
              // Research: if inside a thread or new-topic, go back to thread list first
              if (hubSection === "research" && researchFlowState !== "thread-list") {
                if (activeResearchThread && messages.length >= 2) {
                  researchThreads.updateMessages(activeResearchThread.id, messages);
                }
                setActiveResearchThread(null);
                setMessages([]);
                setResearchFlowState("thread-list");
                researchThreads.fetchThreads();
                return;
              }
              // DID: if not at entry, go back one level
              if (hubSection === "did" && didFlowState !== "entry") {
                handleDidBack();
                return;
              }
              // Hana: hierarchical back
              if (hubSection === "hana") {
                const back = getHanaBackAction();
                back.action();
                return;
              }
              navigate("/hub");
            }} className="h-8 px-2 shrink-0">
              {hubSection === "hana"
                ? getHanaBackAction().label
                : (hubSection === "research" && researchFlowState !== "thread-list") || (hubSection === "did" && didFlowState !== "entry")
                  ? "← Zpět"
                  : "← Hub"}
            </Button>
            <div className="min-w-0">
              <h1 className="text-base sm:text-xl font-serif font-semibold text-foreground truncate">
                {hubSection === "did" ? "DID" : hubSection === "research" ? "Profesní zdroje" : "Hana"}
              </h1>
            </div>
          </div>
          <div className="flex items-center gap-1 sm:gap-2 shrink-0">
            {hubSection === "did" ? (
              <>
                <Button variant="outline" size="sm" onClick={handleManualUpdate} disabled={isManualUpdateLoading} className="h-8 px-2 sm:px-3">
                  {isManualUpdateLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                  {syncProgress ? (
                    <span className="text-xs ml-1">{syncProgress.current}/{syncProgress.total}</span>
                  ) : (
                    <span className="hidden sm:inline ml-1">Aktual. kartotéku</span>
                  )}
                </Button>
                <Button variant="outline" size="sm" onClick={handleReformatCards} disabled={isReformatting} className="h-8 px-2 sm:px-3">
                  {isReformatting ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
                  {reformatProgress ? (
                    <span className="text-xs ml-1">{reformatProgress.current}/{reformatProgress.total}</span>
                  ) : (
                    <span className="hidden sm:inline ml-1">Přeformátovat</span>
                  )}
                </Button>
              </>
            ) : null}
            <Button variant="ghost" size="sm" onClick={handleLogout} className="h-8 px-2">
              <LogOut className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </header>

      {hubSection === "did" ? (
        /* DID Section - no mode toggle, no mode selector, straight to DID content */
        <>
          <CrisisBriefPanel />
          {renderDidContent()}
        </>
      ) : hubSection === "research" ? (
        /* Research Section - thread-based UI */
        <>
          {researchFlowState === "thread-list" ? (
            <ScrollArea className="flex-1">
              <ResearchThreadList
                threads={researchThreads.threads}
                loading={researchThreads.loading}
                onSelect={(thread) => {
                  setActiveResearchThread(thread);
                  setMessages(thread.messages as { role: "user" | "assistant"; content: string }[]);
                  setResearchFlowState("chat");
                }}
                onDelete={(id) => researchThreads.deleteThread(id)}
                onNew={() => setResearchFlowState("new-topic")}
              />
            </ScrollArea>
          ) : researchFlowState === "new-topic" ? (
            <ScrollArea className="flex-1">
              <ResearchNewTopicDialog
                onSubmit={async (topic, createdBy) => {
                  const greeting = `🔬 **${topic}**\n\nVýborně, ${createdBy}! Začínám rešerši na téma "${topic}". Řekni mi, co konkrétně tě zajímá – metody, studie, testy, trendy? Nebo mi popiš situaci a já najdu relevantní zdroje.`;
                  const initialMsgs = [{ role: "assistant" as const, content: greeting }];
                  const thread = await researchThreads.createThread(topic, createdBy, initialMsgs);
                  if (thread) {
                    setActiveResearchThread(thread);
                    setMessages(initialMsgs as { role: "user" | "assistant"; content: string }[]);
                    setResearchFlowState("chat");
                  }
                }}
                onCancel={() => setResearchFlowState("thread-list")}
              />
            </ScrollArea>
          ) : (
            <>
              {/* Thread indicator */}
              {activeResearchThread && (
                <div className="border-b border-border bg-card/30">
                  <div className="max-w-4xl mx-auto px-4 py-2 flex items-center justify-between">
                    <div className="text-sm">
                      <span className="text-muted-foreground">Téma:</span>{" "}
                      <strong className="text-foreground">{activeResearchThread.topic}</strong>
                      <span className="text-xs text-muted-foreground ml-2">({activeResearchThread.createdBy})</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleResearchHandbook}
                        disabled={isResearchHandbookLoading || messages.length < 2}
                        className="h-7 px-2 text-xs gap-1"
                      >
                        {isResearchHandbookLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <FileText className="w-3 h-3" />}
                        <span className="hidden sm:inline">Příručka (PDF)</span>
                        <span className="sm:hidden">PDF</span>
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          if (activeResearchThread && messages.length >= 2) {
                            researchThreads.updateMessages(activeResearchThread.id, messages);
                          }
                          setActiveResearchThread(null);
                          setMessages([]);
                          setResearchFlowState("thread-list");
                          researchThreads.fetchThreads();
                        }}
                        className="h-7 px-2 text-xs"
                      >
                        ← Vlákna
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              <ScrollArea className="flex-1 px-2 sm:px-4" ref={scrollRef}>
                <div className="max-w-4xl mx-auto py-3 sm:py-6 space-y-3 sm:space-y-4">
                  {messages.map((message, index) => (
                    <ChatMessage key={index} message={message} />
                  ))}
                  {isLoading && messages[messages.length - 1]?.role === "user" && <LoadingSkeleton />}
                </div>
              </ScrollArea>

              <div className="border-t border-border bg-card/50 backdrop-blur-sm">
                <div className="max-w-4xl mx-auto px-2 sm:px-4 py-2 sm:py-4">
                  <div className="flex gap-2 sm:gap-3 items-end relative">
                    <UniversalAttachmentBar
                      attachments={attachments} onRemove={removeAttachment}
                      onOpenFilePicker={openFilePicker} onCaptureScreenshot={captureScreenshot}
                      onOpenDrivePicker={() => setDrivePickerOpen(true)} onAutoAnalyze={handleAutoAnalyze}
                      disabled={isLoading || isSoapLoading}
                      fileInputRef={fileInputRef as React.RefObject<HTMLInputElement>}
                      onFileChange={handleFileChange} isAnalyzing={isFileAnalyzing}
                    />
                    <Textarea
                      ref={textareaRef} value={input}
                      onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown}
                      placeholder="Napiš svou zprávu..."
                      className="flex-1 min-w-0 min-h-[44px] sm:min-h-[56px] max-h-[150px] sm:max-h-[200px] resize-none text-sm sm:text-base"
                      disabled={isLoading || isSoapLoading}
                    />
                    <Button
                      onClick={sendMessage}
                      disabled={(!input.trim() && attachments.length === 0) || isLoading || isSoapLoading}
                      size="icon" className="h-[44px] w-[44px] sm:h-[56px] sm:w-[56px] shrink-0"
                    >
                      {isLoading ? <Loader2 className="w-4 h-4 sm:w-5 sm:h-5 animate-spin" /> : <Send className="w-4 h-4 sm:w-5 sm:h-5" />}
                    </Button>
                  </div>
                </div>
              </div>
            </>
          )}
        </>
      ) : (
        /* Hana Section - MainModeToggle (Chat uses new HanaChat, Report stays) */
        <>
          {/* Main Mode Toggle */}
          <div className="border-b border-border bg-card/30">
            <div className="max-w-4xl mx-auto px-4 py-3">
              <MainModeToggle currentMode={mainMode} onModeChange={setMainMode} />
            </div>
          </div>

          {mainMode === "chat" ? (
            <>
              <CrisisBriefPanel />
              <HanaChat />
            </>
          ) : (
            <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
              {!activeSession ? (
                <SessionSidebar />
              ) : sessionReport ? (
                <PostSessionTools
                  clientId={activeSession.clientId}
                  clientName={activeSession.clientName}
                  sessionReport={sessionReport}
                  onBack={() => {
                    setSessionReport(null);
                    setLiveSessionStarted(false);
                  }}
                />
              ) : !liveSessionStarted ? (
                <ClientSummaryCard
                  clientId={activeSession.clientId}
                  clientName={activeSession.clientName}
                  onStartLiveSession={() => setLiveSessionStarted(true)}
                  onCaseSummaryLoaded={(summary) => setClientCaseSummary(summary)}
                />
              ) : (
                <div className="flex-1 min-w-0 flex flex-col md:flex-row min-h-0 overflow-hidden">
                  <div className="flex-1 min-w-0 border-b md:border-b-0 md:border-r border-border min-h-[40vh] md:min-h-0">
                    <SessionReportForm />
                  </div>
                  <div className="flex-1 min-w-0 flex flex-col min-h-[40vh] md:min-h-0 relative">
                    <LiveSessionPanel
                      clientId={activeSession.clientId}
                      clientName={activeSession.clientName}
                      caseSummary={clientCaseSummary}
                      onEndSession={(report) => {
                        setSessionReport(report);
                        toast.success("Sezení zpracováno a uloženo do kartotéky");
                      }}
                    />
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
      {studyMaterial && <StudyMaterialPanel material={studyMaterial} onClose={() => setStudyMaterial(null)} />}
      <GoogleDrivePickerDialog open={drivePickerOpen} onClose={() => setDrivePickerOpen(false)} onFileSelected={addAttachment} />
    </div>
  );
};

export default Chat;

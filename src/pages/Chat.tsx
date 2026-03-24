import { useState, useRef, useEffect, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { LogOut, Loader2, FileText, RotateCcw, FolderOpen, GraduationCap, RefreshCw } from "lucide-react";
import ThemeQuickButton from "@/components/ThemeQuickButton";
import { useUniversalUpload, buildAttachmentContent } from "@/hooks/useUniversalUpload";
import { useAudioRecorder } from "@/hooks/useAudioRecorder";
import ChatInputArea from "@/components/chat/ChatInputArea";
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
import DidConversationHistory from "@/components/did/DidConversationHistory";
import type { DidSubMode } from "@/components/did/DidSubModeSelector";
import { useChatContext } from "@/contexts/ChatContext";
import { useConversationHistory } from "@/hooks/useConversationHistory";
import { useDidThreads, type DidThread } from "@/hooks/useDidThreads";
import { useDidContextPrime } from "@/hooks/useDidContextPrime";
import StudyMaterialPanel from "@/components/StudyMaterialPanel";
import HanaChat from "@/components/hana/HanaChat";
import ClientSummaryCard from "@/components/report/ClientSummaryCard";
import LiveSessionPanel from "@/components/report/LiveSessionPanel";
import ErrorBoundary from "@/components/ErrorBoundary";
import PostSessionTools from "@/components/report/PostSessionTools";
import ResearchThreadList from "@/components/research/ResearchThreadList";
import ResearchNewTopicDialog from "@/components/research/ResearchNewTopicDialog";
import { useResearchThreads, type ResearchThread } from "@/hooks/useResearchThreads";
import { sanitizePartName, uniqueSanitizedPartNames } from "@/lib/didPartNaming";
import { useTheme } from "@/contexts/ThemeContext";
import { useManualUpdate } from "@/hooks/useManualUpdate";
import DidContentRouter from "@/components/did/DidContentRouter";
import { ThemeStorageKeyProvider } from "@/contexts/ThemeStorageKeyContext";
import {
  type ConversationMode, type HubSection, type DidFlowState, type ResearchFlowState,
  STORAGE_KEY_PREFIX, ACTIVE_MODE_KEY, DID_DOCS_LOADED_KEY, DID_SESSION_ID_KEY, HANA_PIN_KEY,
  getRandomCastGreeting, saveMessages, loadMessages, clearMessages, handleApiError,
  parseSSEStream, WELCOME_MESSAGES,
} from "@/lib/chatHelpers";

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
  const [isHandbookLoading, setIsHandbookLoading] = useState(false);
  const [isResearchHandbookLoading, setIsResearchHandbookLoading] = useState(false);
  const [isReformatting, setIsReformatting] = useState(false);
  const [reformatProgress, setReformatProgress] = useState<{ current: number; total: number; currentName: string } | null>(null);
  const [drivePickerOpen, setDrivePickerOpen] = useState(false);
  // Research thread state
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
  const [didLiveSession, setDidLiveSession] = useState<{ partName: string; therapistName: string } | null>(null);
  const [didLiveSessionReady, setDidLiveSessionReady] = useState(false);
  const [didLivePartContext, setDidLivePartContext] = useState<string>("");
  const [searchParams, setSearchParams] = useSearchParams();

  const { history, saveConversation, loadConversation, deleteConversation, refreshHistory } = useConversationHistory();

  // Manual update hook
  const manualUpdate = useManualUpdate({
    activeThread, messages, didSubMode, didInitialContext, didSessionId,
    didThreads, saveConversation, refreshHistory,
    setActiveThread, setMessages, setDidSubMode, setDidInitialContext,
    setDidDocsLoaded, setDidSessionId, setDidFlowState,
  });

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
        if (!hubSection && !activeSession) {
          navigate("/hub", { replace: true });
          return;
        }
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
        if (hubSection === "did" && mode !== "childcare") {
          setMode("childcare");
        } else if (hubSection === "research") {
          if (mode !== "research") setMode("research");
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
    // Guard: skip re-runs caused by other deps when mode hasn't changed
    if (prevModeRef.current === mode) return;

    const welcomeMessages = WELCOME_MESSAGES;

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
            const [docsResponse, registryResponse] = await Promise.all([
              fetch(
                `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-drive-read`,
                { method: "POST", headers, body: JSON.stringify({ 
                  documents: ["01_Index_Vsech_Casti", "00_Aktualni_Dashboard", "Mapa_Vztahu_a_Vazeb", "03_Vnitrni_Svet_Geografie", "05_Operativni_Plan", "06_Strategicky_Vyhled"],
                  subFolder: "00_CENTRUM",
                  allowGlobalSearch: false,
                }) }
              ),
              supabase
                .from("did_part_registry")
                .select("part_name, display_name")
                .eq("status", "active")
                .order("updated_at", { ascending: false }),
            ]);

            if (docsResponse.ok) {
              const data = await docsResponse.json();
              const docs = data.documents || {};
              basicDocsRef.current = Object.entries(docs)
                .filter(([, val]) => typeof val === "string" && !val.startsWith("[Dokument"))
                .map(([key, val]) => `[Kartoteka_DID/00_CENTRUM: ${key}]\n${val}`)
                .join("\n\n");
              setDidInitialContext(basicDocsRef.current);
            }

            const registryParts = uniqueSanitizedPartNames(
              ((registryResponse.data as any[]) || []).flatMap((row) => [row.display_name, row.part_name]),
            );
            setKnownParts(registryParts.slice(0, 30));
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

  // ═══ Hierarchical back navigation for DID ═══
  const handleDidBackHierarchical = useCallback(() => {
    if (activeThread && messages.length >= 2) {
      didThreads.updateThreadMessages(activeThread.id, messages);
    } else if (didSubMode && messages.length >= 2 && didFlowState === "chat") {
      saveConversation(didSubMode, messages, didInitialContext, didSessionId ?? undefined);
    }

    switch (didFlowState) {
      case "chat": {
        setActiveThread(null);
        setMessages([]);
        if (didSubMode === "cast") {
          setDidFlowState("thread-list");
          didThreads.fetchActiveThreads("cast");
        } else if (didSubMode === "mamka" || didSubMode === "kata") {
          setDidFlowState("therapist-threads");
          didThreads.fetchAllThreads(didSubMode);
        } else {
          setDidSubMode(null);
          setDidFlowState("terapeut");
        }
        break;
      }
      case "thread-list":
        setDidSubMode(null);
        setActiveThread(null);
        setMessages([]);
        setDidFlowState("entry");
        break;
      case "therapist-threads":
        setDidSubMode(null);
        setActiveThread(null);
        setMessages([]);
        setDidFlowState("terapeut");
        break;
      case "pin-entry":
        setDidSubMode(null);
        setDidFlowState("terapeut");
        break;
      case "part-identify":
        setDidFlowState("thread-list");
        break;
      case "terapeut":
        setDidFlowState("entry");
        break;
      case "meeting":
        setMeetingIdFromUrl(null);
        setDidFlowState("terapeut");
        break;
      case "live-session":
        setDidLiveSession(null);
        setDidLiveSessionReady(false);
        setDidLivePartContext("");
        setDidSubMode(null);
        setDidFlowState("terapeut");
        break;
      case "did-kartoteka":
        setDidFlowState("live-session");
        break;
      case "loading":
        setDidSubMode(null);
        setDidFlowState("entry");
        break;
      case "entry":
      default:
        navigate("/hub");
        break;
    }
    refreshHistory();
  }, [didFlowState, didSubMode, activeThread, messages, didInitialContext, didSessionId, navigate]);

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

  const {
    applyPreset: applyThemePreset,
    prefs: themePrefs,
    applyTemporaryTheme,
    restoreGlobalTheme,
    getPersonaPrefs,
    setLocalMode,
  } = useTheme();

  // Compute localStorage storageKey for this screen
  const chatStorageKey = (() => {
    if (mainMode === "report") {
      return activeSession ? `theme_report_${activeSession.clientId}` : "theme_report";
    }
    if (hubSection === "research") {
      return activeResearchThread ? `theme_research_${activeResearchThread.id}` : "theme_research";
    }
    // DID and Hana manage their own storageKey in child components
    if (hubSection === "did" || hubSection === "hana") return null;
    return "theme_global";
  })();

  // Load/restore theme from localStorage for non-child-managed modes
  useEffect(() => {
    if (!chatStorageKey) return;
    setLocalMode(chatStorageKey);
    const saved = localStorage.getItem(chatStorageKey);
    if (saved) {
      try { applyTemporaryTheme(JSON.parse(saved)); } catch {}
    }
    return () => { setLocalMode(null); restoreGlobalTheme(); };
  }, [chatStorageKey]);

  const handleSelectThread = useCallback(async (thread: DidThread) => {
    setActiveThread(thread);
    setMessages(thread.messages as { role: "user" | "assistant"; content: string }[]);
    setDidFlowState("chat");

    const kluciBase = await getPersonaPrefs("kluci");
    let threadOverrides: Partial<typeof themePrefs> = {};
    if (thread.themeConfig && Object.keys(thread.themeConfig).length > 0) {
      threadOverrides = Object.fromEntries(
        Object.entries(thread.themeConfig).filter(([, v]) => v !== "" && v !== null && v !== undefined)
      ) as Partial<typeof themePrefs>;
    } else if (thread.themePreset && thread.themePreset !== "default") {
      const { KIDS_PRESETS } = await import("@/components/did/DidKidsThemeEditor");
      const preset = KIDS_PRESETS[thread.themePreset];
      if (preset) {
        threadOverrides = { primary_color: preset.primary_color, accent_color: preset.accent_color };
      }
    }
    applyTemporaryTheme({ ...kluciBase, ...threadOverrides });

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
  }, [setMessages, setDidInitialContext, applyTemporaryTheme, getPersonaPrefs]);

  const handleNewCastThread = useCallback(() => {
    setDidFlowState("part-identify");
  }, []);

  const [isPartSelecting, setIsPartSelecting] = useState(false);
  const handlePartSelected = useCallback(async (selection: import("@/components/did/DidPartIdentifier").PartSelection) => {
    if (isPartSelecting) return;

    const safePartName = sanitizePartName(selection.partName);
    if (!safePartName) {
      toast.error("Tahle část nemá platný název.");
      return;
    }

    setIsPartSelecting(true);
    try {
      const greeting = getRandomCastGreeting();
      const initialMessages = [{ role: "assistant" as const, content: greeting }];

      let partLanguage = "cs";
      const basicCtx = basicDocsRef.current || didInitialContext;
      if (basicCtx.toLowerCase().includes("norsky") || basicCtx.toLowerCase().includes("norština")) partLanguage = "no";
      if (basicCtx.toLowerCase().includes("anglicky") || basicCtx.toLowerCase().includes("english")) partLanguage = "en";

      const thread = await didThreads.createThread(safePartName, "cast", partLanguage, initialMessages as any, {
        forceNew: true,
        threadLabel: selection.threadLabel,
        enteredName: selection.raw,
      });
      if (thread) {
        setActiveThread(thread);
        setMessages(initialMessages as { role: "user" | "assistant"; content: string }[]);
        setDidFlowState("chat");
        didContextPrime.runPrime(safePartName, "cast");
        (async () => {
          try {
            const headers = await getAuthHeaders();
            const response = await fetch(
              `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-drive-read`,
              { method: "POST", headers, body: JSON.stringify({ documents: [`Karta_${safePartName.replace(/\s+/g, "_")}`] }) }
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
      triggerEpisodeGeneration(activeThread.id);
    }
    restoreGlobalTheme();
    setActiveThread(null);
    setMessages([]);
    if (didSubMode === "mamka" || didSubMode === "kata") {
      setDidFlowState("therapist-threads");
      didThreads.fetchAllThreads(didSubMode);
    } else {
      setDidFlowState("thread-list");
      didThreads.fetchActiveThreads("cast");
    }
  }, [activeThread, messages, setMessages, didSubMode, triggerEpisodeGeneration, restoreGlobalTheme]);

  // Quick thread entry from dashboard
  const handleQuickThread = useCallback(async (threadId: string, partName: string) => {
    setDidSubMode("cast");
    setDidFlowState("loading");
    
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
      themePreset: (data as any).theme_preset || "",
      themeConfig: (data as any).theme_config || {},
      threadEmoji: (data as any).thread_emoji || "",
      threadLabel: (data as any).thread_label || "",
      enteredName: (data as any).entered_name || "",
    };
    
    setActiveThread(thread);
    setMessages(thread.messages as { role: "user" | "assistant"; content: string }[]);
    setDidFlowState("chat");

    const kluciBase = await getPersonaPrefs("kluci");
    let threadOverrides: Partial<typeof themePrefs> = {};
    if (thread.themeConfig && Object.keys(thread.themeConfig).length > 0) {
      threadOverrides = Object.fromEntries(
        Object.entries(thread.themeConfig).filter(([, v]) => v !== "" && v !== null && v !== undefined)
      ) as Partial<typeof themePrefs>;
    }
    applyTemporaryTheme({ ...kluciBase, ...threadOverrides });
    
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
  }, [setDidSubMode, setMessages, setDidInitialContext, applyTemporaryTheme, getPersonaPrefs]);

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

  // authChecked guard moved after all hooks (see below line ~1317)

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
      const { data } = await supabase
        .from("did_part_registry")
        .select("part_name, display_name")
        .eq("status", "active")
        .order("updated_at", { ascending: false });

      const names = uniqueSanitizedPartNames(
        ((data as any[]) || []).flatMap((row) => [row.display_name, row.part_name]),
      );
      setKnownParts(names.slice(0, 30));
    } catch {}
  };

  const handleDidSubModeSelect = async (subMode: DidSubMode) => {
    setDidSubMode(subMode);
    setDidSessionId(null);
    setDidDocsLoaded(false);
    setActiveThread(null);

    if (subMode === "cast") {
      setDidFlowState("loading");
      await didThreads.fetchActiveThreads("cast");
      if (basicDocsRef.current) {
        setDidInitialContext(basicDocsRef.current);
      }
      setDidFlowState("thread-list");
      return;
    }

    if (subMode === "research") {
      if (basicDocsRef.current) setDidInitialContext(basicDocsRef.current);
      setDidDocsLoaded(true);
      setDidFlowState("chat");
      setMessages([{ role: "assistant", content: "🔬 Jsem připraven prohledat odborné zdroje pro DID systém. Řekni mi téma, metodu nebo situaci – a já najdu relevantní výzkumy a terapeutické přístupy." }]);
      return;
    }

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
      const basicCtx = basicDocsRef.current || didInitialContext;
      const mentionedParts = knownParts.filter(p => 
        userMessage.toLowerCase().includes(p.toLowerCase())
      );
      
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
          const researchContent = await parseSSEStream(response.body, () => {});
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

  // ── Common handlers ──

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

  const handleWriteDiary = useCallback(() => {
    if (!activeThread || isLoading) return;
    const diaryPrompt = `📓 Připrav zápis do deníku z našeho dnešního rozhovoru. Shrň co jsme probírali, jakou náladu jsem měl/a a co by stálo za zapamatování. Ukaž mi to – můžu to upravit než to uložíš.`;
    setInput(diaryPrompt);
    setTimeout(() => {
      const btn = document.querySelector('[data-send-btn]') as HTMLButtonElement;
      if (btn) btn.click();
    }, 100);
  }, [activeThread, isLoading]);

  const handleDidEndCall = useCallback(async () => {
    const threadToProcess = activeThread;
    if (activeThread && messages.length >= 2) {
      await didThreads.updateThreadMessages(activeThread.id, messages);
    } else if (didSubMode && messages.length >= 2) {
      saveConversation(didSubMode, messages, didInitialContext, didSessionId ?? undefined);
    }

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
  }, [activeThread, messages, didSubMode, didInitialContext, didSessionId, mode, triggerEpisodeGeneration]);

  const handleDidResearch = useCallback(async () => {
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
      setMessages(prev => [...prev, { role: "assistant", content: "" }]);
      assistantContent = await parseSSEStream(response.body, (content) => {
        setMessages(prev => {
          const n = [...prev];
          if (n[n.length - 1]?.role === "assistant") n[n.length - 1] = { ...n[n.length - 1], content };
          return n;
        });
      });
      toast.success("Výzkum dokončen");
    } catch (error) {
      console.error("DID Research error:", error);
      toast.error(error instanceof Error ? error.message : "Chyba při vyhledávání");
      if (!assistantContent) setMessages(prev => prev.slice(0, -1));
    } finally { setIsDidResearchLoading(false); }
  }, [isDidResearchLoading, messages, activeThread]);

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

  const handleGenerateHandbook = useCallback(async () => {
    if (isHandbookLoading) return;
    setIsHandbookLoading(true);
    try {
      const { generateKataHandbook } = await import("@/lib/didPdfExport");
      const currentMessages = (didSubMode === "kata" && messages.length >= 2) ? messages : undefined;
      await generateKataHandbook(currentMessages);
      toast.success("Příručka pro Káťu vygenerována a stažena");
    } catch (error) {
      console.error("Handbook error:", error);
      toast.error("Chyba při generování příručky");
    } finally {
      setIsHandbookLoading(false);
    }
  }, [isHandbookLoading, didSubMode, messages]);

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
      const recentMessages = [...messages.slice(-20), { role: "user", content: userContent }];
      const trimmedContext = didInitialContext && didInitialContext.length > 8000
        ? didInitialContext.slice(-8000)
        : didInitialContext;
      const trimmedPrimeCache = didContextPrime.primeCache && didContextPrime.primeCache.length > 2000
        ? didContextPrime.primeCache.slice(-2000)
        : didContextPrime.primeCache;
      const body = isResearch
        ? { query: userMessage, conversationHistory: messages.slice(-20), createdBy: activeResearchThread?.createdBy || "Hana" }
        : {
            messages: recentMessages,
            mode,
            ...(mode === "childcare" && trimmedContext ? { didInitialContext: trimmedContext } : {}),
            ...(mode === "childcare" && didSubMode ? { didSubMode } : {}),
            ...(mode === "childcare" && trimmedPrimeCache ? { didContextPrimeCache: trimmedPrimeCache } : {}),
            ...(mode === "childcare" && activeThread ? { didPartName: activeThread.partName, didThreadLabel: activeThread.threadLabel, didEnteredName: activeThread.enteredName } : {}),
          };
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 90000);
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${endpoint}`, {
        method: "POST", headers, body: JSON.stringify(body), signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!response.ok) handleApiError(response);
      if (!response.body) throw new Error("Žádná odpověď");
      setMessages((prev) => [...prev, { role: "assistant", content: "" }]);
      assistantContent = await parseSSEStream(response.body, (content) => {
        setMessages((prev) => {
          const n = [...prev];
          if (n[n.length - 1]?.role === "assistant") n[n.length - 1] = { ...n[n.length - 1], content };
          return n;
        });
      });

      // ═══ SWITCH DETECTION ═══
      if (activeThread && didSubMode === "cast" && assistantContent) {
        const switchMatch = assistantContent.match(/\[SWITCH:([^\]]+)\]/);
        if (switchMatch) {
          const newPartName = switchMatch[1].trim();
          if (newPartName && newPartName.toLowerCase() !== activeThread.partName.toLowerCase()) {
            console.log(`[switch-detect] Part switched from "${activeThread.partName}" to "${newPartName}"`);
            await supabase
              .from("did_threads")
              .update({ part_name: newPartName })
              .eq("id", activeThread.id);
            setActiveThread(prev => prev ? { ...prev, partName: newPartName } : prev);
            toast.info(`Switch detekován: ${activeThread.partName} → ${newPartName}`);
          }
          assistantContent = assistantContent.replace(/\[SWITCH:[^\]]+\]/g, "").trim();
          setMessages((prev) => {
            const n = [...prev];
            if (n[n.length - 1]?.role === "assistant") n[n.length - 1] = { ...n[n.length - 1], content: assistantContent };
            return n;
          });
        }
      }

      // Detect [ODESLAT_VZKAZ:mamka/kata] markers
      if (mode === "childcare" && assistantContent) {
        const vzkazRegex = /\[ODESLAT_VZKAZ:(mamka|kata)\]([\s\S]*?)\[\/ODESLAT_VZKAZ\]/g;
        let match;
        while ((match = vzkazRegex.exec(assistantContent)) !== null) {
          const recipient = match[1];
          const messageText = match[2].trim();
          if (messageText) {
            const recipientEmail = recipient === "kata" ? "K.CC@seznam.cz" : "mujosobniasistentnamiru@gmail.com";
            const recipientName = recipient === "kata" ? "Káťa" : "Mamka";
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
      // Trigger background enrichment
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

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  }, [sendMessage]);

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

  if (!authChecked) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-transparent">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <ThemeStorageKeyProvider value={chatStorageKey || undefined}>
    <div className="min-h-screen flex flex-col bg-transparent">
      {/* Header */}
      <header className="border-b border-border/70 bg-card/36 backdrop-blur-md sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-3 sm:px-4 py-2.5 sm:py-4 flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <Button
              variant="ghost"
              size="sm"
              data-swipe-back="true"
              onClick={() => {
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
                if (hubSection === "did" && didFlowState !== "entry") {
                  handleDidBackHierarchical();
                  return;
                }
                if (hubSection === "hana") {
                  const back = getHanaBackAction();
                  back.action();
                  return;
                }
                navigate("/hub");
              }}
              className="h-8 px-2 shrink-0"
            >
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
            <ThemeQuickButton storageKey={chatStorageKey || undefined} />
            <Button variant="ghost" size="sm" onClick={handleLogout} className="h-8 px-2">
              <LogOut className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </header>

      {hubSection === "did" ? (
        <>
          <CrisisBriefPanel />
          <DidContentRouter
            didFlowState={didFlowState}
            setDidFlowState={setDidFlowState}
            didSubMode={didSubMode}
            setDidSubMode={setDidSubMode}
            activeThread={activeThread}
            setActiveThread={setActiveThread}
            messages={messages}
            setMessages={setMessages}
            knownParts={knownParts}
            didInitialContext={didInitialContext}
            setDidInitialContext={setDidInitialContext}
            didDocsLoaded={didDocsLoaded}
            didSessionId={didSessionId}
            basicDocsRef={basicDocsRef}
            didContextPrime={didContextPrime}
            didThreads={didThreads}
            onManualUpdate={manualUpdate.run}
            isManualUpdateLoading={manualUpdate.isLoading}
            syncProgress={manualUpdate.syncProgress}
            handleDidSubModeSelect={handleDidSubModeSelect}
            handleQuickThread={handleQuickThread}
            handleSelectThread={handleSelectThread}
            handleNewCastThread={handleNewCastThread}
            handlePartSelected={handlePartSelected}
            handleLeaveThread={handleLeaveThread}
            handleDidEndCall={handleDidEndCall}
            handleDidBackHierarchical={handleDidBackHierarchical}
            handleGenerateHandbook={handleGenerateHandbook}
            handleWriteDiary={handleWriteDiary}
            handleAudioAnalysis={handleAudioAnalysis}
            handleAutoAnalyze={handleAutoAnalyze}
            handleDidResearch={handleDidResearch}
            isDidResearchLoading={isDidResearchLoading}
            sendMessage={sendMessage}
            handleKeyDown={handleKeyDown}
            input={input}
            setInput={setInput}
            isLoading={isLoading}
            isSoapLoading={isSoapLoading}
            isEnrichingContext={isEnrichingContext}
            isAudioAnalyzing={isAudioAnalyzing}
            isFileAnalyzing={isFileAnalyzing}
            isHandbookLoading={isHandbookLoading}
            audioRecorder={audioRecorder}
            attachments={attachments}
            removeAttachment={removeAttachment}
            openFilePicker={openFilePicker}
            captureScreenshot={captureScreenshot}
            handleFileChange={handleFileChange}
            fileInputRef={fileInputRef as React.RefObject<HTMLInputElement>}
            textareaRef={textareaRef}
            scrollRef={scrollRef}
            drivePickerOpen={drivePickerOpen}
            setDrivePickerOpen={setDrivePickerOpen}
            didLiveSession={didLiveSession}
            setDidLiveSession={setDidLiveSession}
            didLiveSessionReady={didLiveSessionReady}
            setDidLiveSessionReady={setDidLiveSessionReady}
            didLivePartContext={didLivePartContext}
            setDidLivePartContext={setDidLivePartContext}
            navigate={navigate}
            meetingIdFromUrl={meetingIdFromUrl}
            setMeetingIdFromUrl={setMeetingIdFromUrl}
            meetingTherapist={meetingTherapist}
            setMeetingTherapist={setMeetingTherapist}
            mode={mode}
            setMode={setMode}
          />
        </>
      ) : hubSection === "research" ? (
        <>
          {researchFlowState === "thread-list" ? (
            <ScrollArea className="flex-1">
              <div className="max-w-2xl mx-auto px-3 sm:px-4 pt-3 flex justify-end">
                <ThemeQuickButton storageKey={chatStorageKey || undefined} />
              </div>
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
              {activeResearchThread && (
                <div className="border-b border-border bg-card/30">
                  <div className="max-w-4xl mx-auto px-4 py-2 flex items-center justify-between">
                    <div className="text-sm">
                      <span className="text-muted-foreground">Téma:</span>{" "}
                      <strong className="text-foreground">{activeResearchThread.topic}</strong>
                      <span className="text-xs text-muted-foreground ml-2">({activeResearchThread.createdBy})</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <ThemeQuickButton storageKey={chatStorageKey || undefined} />
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

              <ChatInputArea
                input={input} setInput={setInput}
                onSend={sendMessage} onKeyDown={handleKeyDown}
                isLoading={isLoading} disabled={isSoapLoading}
                isAnalyzing={isFileAnalyzing}
                attachments={attachments}
                onRemoveAttachment={removeAttachment}
                onOpenFilePicker={openFilePicker}
                onCaptureScreenshot={captureScreenshot}
                onOpenDrivePicker={() => setDrivePickerOpen(true)}
                onAutoAnalyze={handleAutoAnalyze}
                fileInputRef={fileInputRef as React.RefObject<HTMLInputElement>}
                onFileChange={handleFileChange}
                textareaRef={textareaRef}
              />
            </>
          )}
        </>
      ) : (
        <>
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
    </ThemeStorageKeyProvider>
  );
};

export default Chat;

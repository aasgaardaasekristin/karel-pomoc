import React, { useEffect, useRef, useState } from "react";
import ThemeQuickButton from "@/components/ThemeQuickButton";
import { useTheme } from "@/contexts/ThemeContext";
import { ThemeStorageKeyProvider } from "@/contexts/ThemeStorageKeyContext";
import { Loader2 } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { getAuthHeaders } from "@/lib/auth";
import ErrorBoundary from "@/components/ErrorBoundary";
import DidEntryScreen from "@/components/did/DidEntryScreen";
import DidDashboard from "@/components/did/DidDashboard";
import KarelOverviewPanel from "@/components/did/KarelOverviewPanel";
import DidMeetingPanel from "@/components/did/DidMeetingPanel";
import DidRegistryOverview from "@/components/did/DidRegistryOverview";
import DidPartSelector from "@/components/did/DidPartSelector";
import DidPartCard from "@/components/did/DidPartCard";
import DidLiveSessionPanel from "@/components/did/DidLiveSessionPanel";
import DidPinEntry from "@/components/did/DidPinEntry";
import DidTherapistThreadsContainer from "@/components/did/DidTherapistThreadsContainer";
import DidThreadList from "@/components/did/DidThreadList";
import DidPartIdentifier from "@/components/did/DidPartIdentifier";
import DidKidsThemeEditor from "@/components/did/DidKidsThemeEditor";
import DidActionButtons from "@/components/did/DidActionButtons";
import QuickNoteDialog from "@/components/did/QuickNoteDialog";
import ChatInputArea from "@/components/chat/ChatInputArea";
import AudioRecordButton from "@/components/AudioRecordButton";
import ChatMessage from "@/components/ChatMessage";
import type { DidThread } from "@/hooks/useDidThreads";
import type { DidFlowState } from "@/lib/chatHelpers";
import type { SyncProgress } from "@/hooks/useManualUpdate";
import { useCrisisOperationalState } from "@/hooks/useCrisisOperationalState";

type DidSubMode = "mamka" | "cast" | "kata" | "form" | "freetext" | "general" | "research" | null;
import type { ConversationMode } from "@/lib/chatHelpers";

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

export interface DidContentRouterProps {
  // Flow
  didFlowState: DidFlowState;
  setDidFlowState: React.Dispatch<React.SetStateAction<DidFlowState>>;
  didSubMode: DidSubMode;
  setDidSubMode: React.Dispatch<React.SetStateAction<any>>;

  // Data
  activeThread: DidThread | null;
  setActiveThread: React.Dispatch<React.SetStateAction<DidThread | null>>;
  messages: { role: "user" | "assistant"; content: string }[];
  setMessages: React.Dispatch<React.SetStateAction<{ role: "user" | "assistant"; content: string }[]>>;
  knownParts: string[];
  didInitialContext: string;
  setDidInitialContext: React.Dispatch<React.SetStateAction<string>>;
  didDocsLoaded: boolean;
  didSessionId: string | null;
  basicDocsRef: React.MutableRefObject<string>;
  didContextPrime: { runPrime: (partName?: string, subMode?: string) => void; primeCache: string | null; isPriming: boolean };
  didThreads: {
    threads: DidThread[];
    fetchActiveThreads: (subMode?: string) => Promise<void>;
    fetchAllThreads: (subMode: string) => Promise<void>;
    deleteThread: (id: string) => Promise<void>;
    createThread: (partName: string, subMode: string, partLanguage?: string, initialMessages?: any[], options?: any) => Promise<DidThread | null>;
    updateThreadThemeConfig: (threadId: string, themePreset: string, themeConfig: Record<string, any>) => Promise<void>;
  };

  // Manual update
  onManualUpdate: () => Promise<void>;
  isManualUpdateLoading: boolean;
  syncProgress: SyncProgress | null;

  // Handlers (all useCallback-wrapped)
  handleDidSubModeSelect: (subMode: any) => void;
  handleQuickThread: (threadId: string, partName: string) => Promise<void>;
  handleSelectThread: (thread: DidThread) => Promise<void>;
  handleNewCastThread: () => void;
  handlePartSelected: (selection: import("@/components/did/DidPartIdentifier").PartSelection) => Promise<void>;
  handleLeaveThread: () => Promise<void>;
  handleDidEndCall: () => Promise<void>;
  handleDidBackHierarchical: () => void;
  handleGenerateHandbook: () => Promise<void>;
  handleWriteDiary: () => void;
  handleAudioAnalysis: () => Promise<void>;
  handleAutoAnalyze: () => Promise<void>;
  handleDidResearch: () => Promise<void>;
  isDidResearchLoading: boolean;
  sendMessage: () => Promise<void>;
  handleKeyDown: (e: React.KeyboardEvent) => void;

  // Input/UI
  input: string;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  isLoading: boolean;
  isSoapLoading: boolean;
  isEnrichingContext: boolean;
  isAudioAnalyzing: boolean;
  isFileAnalyzing: boolean;
  isHandbookLoading: boolean;
  audioRecorder: any;
  attachments: any[];
  removeAttachment: (id: string) => void;
  openFilePicker: () => void;
  captureScreenshot: () => void;
  handleFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  fileInputRef: React.RefObject<HTMLInputElement>;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  scrollRef: React.RefObject<HTMLDivElement>;
  drivePickerOpen: boolean;
  setDrivePickerOpen: React.Dispatch<React.SetStateAction<boolean>>;

  // Live session
  didLiveSession: { partName: string; therapistName: string } | null;
  setDidLiveSession: React.Dispatch<React.SetStateAction<{ partName: string; therapistName: string } | null>>;
  didLiveSessionReady: boolean;
  setDidLiveSessionReady: React.Dispatch<React.SetStateAction<boolean>>;
  didLivePartContext: string;
  setDidLivePartContext: React.Dispatch<React.SetStateAction<string>>;

  // Navigation
  navigate: (path: string) => void;
  meetingIdFromUrl: string | null;
  setMeetingIdFromUrl: React.Dispatch<React.SetStateAction<string | null>>;
  /** FÁZE 3C: canonical did_daily_session_plans.id — pokud meeting/CTA vznikl z dnešního plánu. */
  dailyPlanIdFromUrl?: string | null;
  meetingTherapist: "hanka" | "kata";
  setMeetingTherapist: React.Dispatch<React.SetStateAction<"hanka" | "kata">>;
  mode: ConversationMode;
  setMode: React.Dispatch<React.SetStateAction<ConversationMode>>;
}

const DidContentRouterInner: React.FC<DidContentRouterProps> = (props) => {
  const { applyTemporaryTheme, restoreGlobalTheme, setLocalMode } = useTheme();
  const {
    didFlowState, setDidFlowState, didSubMode, setDidSubMode,
    activeThread, setActiveThread, messages, setMessages,
    knownParts, didInitialContext, setDidInitialContext,
    didDocsLoaded, didSessionId, basicDocsRef, didContextPrime, didThreads,
    onManualUpdate, isManualUpdateLoading, syncProgress,
    handleDidSubModeSelect, handleQuickThread, handleSelectThread,
    handleNewCastThread, handlePartSelected, handleLeaveThread,
    handleDidEndCall, handleDidBackHierarchical, handleGenerateHandbook,
    handleWriteDiary, handleAudioAnalysis, handleAutoAnalyze,
    handleDidResearch, isDidResearchLoading, sendMessage, handleKeyDown,
    input, setInput, isLoading, isSoapLoading, isEnrichingContext,
    isAudioAnalyzing, isFileAnalyzing, isHandbookLoading,
    audioRecorder, attachments, removeAttachment, openFilePicker,
    captureScreenshot, handleFileChange, fileInputRef, textareaRef, scrollRef,
    drivePickerOpen, setDrivePickerOpen,
    didLiveSession, setDidLiveSession, didLiveSessionReady, setDidLiveSessionReady,
    didLivePartContext, setDidLivePartContext,
    navigate, meetingIdFromUrl, setMeetingIdFromUrl, dailyPlanIdFromUrl,
    meetingTherapist, setMeetingTherapist, mode, setMode,
  } = props;

  // Use didStorageKey from outer wrapper (passed via ThemeStorageKeyContext)
  const didStorageKey = (() => {
    if (didSubMode === "mamka") return "theme_did_mamka";
    if (didSubMode === "kata") return "theme_did_kata";
    if (didSubMode === "cast" && activeThread) return `theme_did_kids_${activeThread.id}`;
    if (didSubMode === "cast") return "theme_did_kids";
    return "theme_did_entry";
  })();

  // Track whether this component is truly unmounting vs just changing key
  const isUnmountingRef = useRef(false);
  useEffect(() => { return () => { isUnmountingRef.current = true; }; }, []);

  // ── Jung Study theme vars (applied directly on root to override ThemeContext inline styles) ──
  const JUNG_STUDY_VARS: Record<string, string> = {
    "--background": "34 28% 94%",
    "--foreground": "28 18% 18%",
    "--card": "36 24% 91%",
    "--card-foreground": "28 18% 18%",
    "--popover": "36 24% 91%",
    "--popover-foreground": "28 18% 18%",
    "--primary": "28 32% 38%",
    "--primary-foreground": "36 30% 96%",
    "--secondary": "34 20% 86%",
    "--secondary-foreground": "28 16% 24%",
    "--muted": "34 18% 88%",
    "--muted-foreground": "28 12% 46%",
    "--accent": "24 26% 48%",
    "--accent-foreground": "36 30% 96%",
    "--destructive": "9 52% 48%",
    "--destructive-foreground": "36 30% 98%",
    "--border": "34 18% 82%",
    "--input": "34 18% 82%",
    "--ring": "28 32% 38%",
    "--theme-surface": "34 22% 90%",
    "--theme-soft": "34 20% 84%",
    "--theme-glow": "28 28% 76%",
    "--theme-glow-strong": "24 22% 72%",
    "--theme-noise-opacity": "0.04",
    "--chat-user": "34 22% 86%",
    "--chat-assistant": "34 18% 88%",
    "--chat-border": "34 14% 78%",
    "--surface-primary": "34 22% 92%",
    "--surface-secondary": "34 18% 94%",
    "--surface-tertiary": "34 14% 96%",
    "--surface-elevated": "36 20% 97%",
    "--text-primary": "28 18% 18%",
    "--text-secondary": "28 12% 40%",
    "--text-tertiary": "28 8% 56%",
    "--sidebar-background": "34 20% 90%",
    "--sidebar-foreground": "28 16% 22%",
    "--sidebar-primary": "28 32% 38%",
    "--sidebar-primary-foreground": "36 30% 96%",
    "--sidebar-accent": "34 18% 84%",
    "--sidebar-accent-foreground": "28 16% 22%",
    "--sidebar-border": "34 18% 82%",
  };

  // ── Wizarding theme vars for DID/Kluci ──
  const WIZARDING_VARS: Record<string, string> = {
    "--background": "220 28% 14%",
    "--foreground": "38 18% 88%",
    "--card": "220 24% 17%",
    "--card-foreground": "38 18% 88%",
    "--popover": "220 24% 17%",
    "--popover-foreground": "38 18% 88%",
    "--primary": "38 32% 52%",
    "--primary-foreground": "220 28% 12%",
    "--secondary": "220 18% 22%",
    "--secondary-foreground": "38 16% 82%",
    "--muted": "220 16% 20%",
    "--muted-foreground": "38 10% 58%",
    "--accent": "260 18% 48%",
    "--accent-foreground": "38 18% 92%",
    "--destructive": "9 52% 48%",
    "--destructive-foreground": "38 18% 96%",
    "--border": "220 16% 24%",
    "--input": "220 16% 24%",
    "--ring": "38 32% 52%",
    "--theme-surface": "220 22% 13%",
    "--theme-soft": "220 18% 18%",
    "--theme-glow": "260 16% 28%",
    "--theme-glow-strong": "38 24% 26%",
    "--theme-noise-opacity": "0.03",
    "--chat-user": "220 18% 20%",
    "--chat-assistant": "220 16% 18%",
    "--chat-border": "220 14% 26%",
    "--surface-primary": "220 22% 14%",
    "--surface-secondary": "220 18% 16%",
    "--text-primary": "38 18% 88%",
    "--text-secondary": "38 12% 64%",
    "--sidebar-background": "220 24% 11%",
    "--sidebar-foreground": "38 16% 86%",
  };

  const jungVarsBackup = useRef<Map<string, string>>(new Map());

  // Load theme from localStorage on mount/change, restore only on unmount
  useEffect(() => {
    setLocalMode(didStorageKey);
    const root = document.documentElement;

    // Determine which theme set to apply
    const isJungMode = didStorageKey === "theme_did_entry";
    const isWizardingMode = didStorageKey === "theme_did_kids" || didStorageKey.startsWith("theme_did_kids_");

    // Check for user-saved personalized theme first
    const saved = localStorage.getItem(didStorageKey);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed && typeof parsed === "object" && parsed.primary_color) {
          applyTemporaryTheme(parsed);
          return;
        }
      } catch {
        localStorage.removeItem(didStorageKey);
      }
    }

    // Apply ambient theme based on mode
    if (isJungMode) {
      // Backup current values, then apply jung vars directly on root
      for (const [key, val] of Object.entries(JUNG_STUDY_VARS)) {
        jungVarsBackup.current.set(key, root.style.getPropertyValue(key));
        root.style.setProperty(key, val);
      }
      root.classList.remove("dark");
    } else if (isWizardingMode) {
      for (const [key, val] of Object.entries(WIZARDING_VARS)) {
        jungVarsBackup.current.set(key, root.style.getPropertyValue(key));
        root.style.setProperty(key, val);
      }
      root.classList.add("dark");
    }

    return () => {
      if (isUnmountingRef.current) {
        // Restore backed-up values
        for (const [key, val] of jungVarsBackup.current.entries()) {
          if (val) root.style.setProperty(key, val);
          else root.style.removeProperty(key);
        }
        jungVarsBackup.current.clear();
        setLocalMode(null);
        restoreGlobalTheme();
      }
    };
  }, [didStorageKey]);

  // ═══ CRISIS INDICATOR (FÁZE 3E) ═══
  // Reader-only over the canonical view-model `useCrisisOperationalState`.
  // No raw `crisis_events` query here — the router must NOT be a parallel
  // frontend resolver. The hook already encapsulates the canonical filter
  // (open phase + crisis_events as source of truth).
  const { cards: crisisCards } = useCrisisOperationalState();
  const activeCrisisBanner = React.useMemo(() => {
    if (didSubMode !== "cast" || !activeThread?.partName) return null;
    const partLower = activeThread.partName.toLowerCase();
    const match = crisisCards.find(c => (c.partName || "").toLowerCase() === partLower);
    return match && match.eventId
      ? { severity: match.severity || "moderate", eventId: match.eventId }
      : null;
  }, [didSubMode, activeThread?.partName, crisisCards]);

  // Entry screen: Terapeut / Kluci
  if (didFlowState === "entry" && !didSubMode) {
    return (
      <ScrollArea className="flex-1">
        <DidEntryScreen
          onSelectTerapeut={() => {
            setDidFlowState("terapeut");
            didContextPrime.runPrime(undefined, "mamka");
          }}
          onSelectKluci={() => {
            setDidSubMode("cast");
            setDidFlowState("loading");
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

  // Terapeut view: Surface tab bar (Dashboard / Karlův přehled / Komunikace / Admin)
  if (didFlowState === "terapeut" && !didSubMode) {
    return (
      <TerapeutSurfaces
        navigate={navigate}
        setDidFlowState={setDidFlowState}
        setDidSubMode={setDidSubMode}
        setMeetingTherapist={setMeetingTherapist}
        onManualUpdate={onManualUpdate}
        isManualUpdateLoading={isManualUpdateLoading}
        syncProgress={syncProgress}
        handleDidSubModeSelect={handleDidSubModeSelect}
        handleQuickThread={handleQuickThread}
        didInitialContext={didInitialContext}
        basicDocsRef={basicDocsRef}
        didContextPrime={didContextPrime}
      />
    );
  }

  // Meeting view
  if (didFlowState === "meeting") {
    // Support topic-based and seed-based meetings
    const isSeed = meetingIdFromUrl?.startsWith("seed:");
    const isTopic = meetingIdFromUrl?.startsWith("topic:");
    const meetingTopic = isTopic ? meetingIdFromUrl.slice(6) : (isSeed ? meetingIdFromUrl.slice(5) : undefined);
    const meetingId = (isTopic || isSeed) ? null : meetingIdFromUrl;

    // Read structured seed from sessionStorage — do NOT remove yet (DidMeetingPanel will clear after consumption)
    let meetingSeed: any = undefined;
    let seedDailyPlanId: string | null = null;
    if (isSeed) {
      try {
        const seedStr = sessionStorage.getItem("karel_meeting_seed");
        if (seedStr) {
          meetingSeed = JSON.parse(seedStr);
          // Seed may carry canonical daily_plan_id (set by KarelDailyPlan when opening meeting from today's session).
          seedDailyPlanId = meetingSeed?.dailyPlanId || meetingSeed?.daily_plan_id || null;
          // Seed will be cleared by DidMeetingPanel after successful auto-create
        }
      } catch {}
    }

    // FÁZE 3C: canonical daily_plan_id — URL param wins, then seed, then null.
    const resolvedDailyPlanId = dailyPlanIdFromUrl || seedDailyPlanId || null;

    return (
      <DidMeetingPanel
        meetingId={meetingId}
        meetingTopic={meetingTopic}
        meetingSeed={meetingSeed}
        dailyPlanId={resolvedDailyPlanId}
        therapist={meetingTherapist}
        onBack={() => {
          // 2026-04-19 — Briefing-aware Back: pokud uživatel přišel
          // z `DidDailyBriefingPanel`, vrátíme ho do terapeut dashboardu
          // (kde žije briefing). Bez flagu zachováno původní chování.
          let cameFromBriefing = false;
          try {
            cameFromBriefing = sessionStorage.getItem("karel_briefing_return") === "1";
            if (cameFromBriefing) sessionStorage.removeItem("karel_briefing_return");
          } catch { /* ignore */ }
          setDidFlowState("terapeut");
          setMeetingIdFromUrl(null);
          if (cameFromBriefing) {
            setDidSubMode(null);
          }
        }}
      />
    );
  }

  // DID Kartotéka
  if (didFlowState === "did-kartoteka") {
    return (
      <ScrollArea className="flex-1">
        <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-serif font-semibold text-foreground">Kartotéka částí</h2>
            <Button variant="ghost" size="sm" onClick={() => setDidFlowState("live-session")}>← Zpět</Button>
          </div>
          <DidRegistryOverview
            refreshTrigger={0}
            onSelectPart={(partName: string) => {
              const therapistName = didSubMode === "kata" ? "Káťa" : "Hanka";
              setDidLiveSession({ partName, therapistName });
              setDidLiveSessionReady(false);
              setDidLivePartContext("");
              setDidFlowState("live-session");
            }}
          />
        </div>
      </ScrollArea>
    );
  }

  // Live DID session
  if (didFlowState === "live-session") {
    const therapistName = didSubMode === "kata" ? "Káťa" : "Hanka";

    if (!didLiveSession) {
      return (
        <DidPartSelector
          therapistName={therapistName}
          knownParts={knownParts}
          onSelectPart={(name) => {
            setDidLiveSession({ partName: name, therapistName });
            setDidLiveSessionReady(false);
            setDidLivePartContext("");
          }}
          onBack={() => { setDidSubMode(null); setDidFlowState("terapeut"); }}
          onOpenKartoteka={() => setDidFlowState("did-kartoteka")}
        />
      );
    }

    if (!didLiveSessionReady) {
      return (
        <DidPartCard
          partName={didLiveSession.partName}
          therapistName={didLiveSession.therapistName}
          onStartLiveSession={() => setDidLiveSessionReady(true)}
          onContextLoaded={(ctx) => setDidLivePartContext(ctx)}
          onBack={() => {
            setDidLiveSession(null);
            setDidLiveSessionReady(false);
          }}
        />
      );
    }

    return (
      <ErrorBoundary fallbackTitle="Live session panel selhal">
        <DidLiveSessionPanel
          partName={didLiveSession.partName}
          therapistName={didLiveSession.therapistName}
          contextBrief={didLivePartContext || didContextPrime.primeCache || didInitialContext || undefined}
          onEnd={(summary) => {
            toast.success("DID sezení zpracováno");
            setDidLiveSession(null);
            setDidLiveSessionReady(false);
            setDidLivePartContext("");
            setDidSubMode("mamka");
            setDidFlowState("chat");
            setMessages([{ role: "assistant", content: `Sezení s **${didLiveSession.partName}** dokončeno.\n\n${summary}` }]);
          }}
          onBack={() => {
            setDidLiveSessionReady(false);
          }}
        />
      </ErrorBoundary>
    );
  }

  // PIN entry
  if (didFlowState === "pin-entry" && (didSubMode === "mamka" || didSubMode === "kata")) {
    const name = didSubMode === "mamka" ? "Hanička" : "Káťa";
    return (
      <DidPinEntry
        therapistName={name}
        onSuccess={async () => {
          setDidFlowState("loading");
          await didThreads.fetchAllThreads(didSubMode);
          if (basicDocsRef.current) setDidInitialContext(basicDocsRef.current);

          // AUTO-PREP
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

  // Therapist thread list
  if (didFlowState === "therapist-threads" && (didSubMode === "mamka" || didSubMode === "kata")) {
    const name = didSubMode === "mamka" ? "Hanička" : "Káťa";
    return (
      <ScrollArea className="flex-1">
        <DidTherapistThreadsContainer
          therapistName={name}
          threads={didThreads.threads}
          onSelectThread={(thread) => {
            setActiveThread(thread);
            setMessages(thread.messages as { role: "user" | "assistant"; content: string }[]);
            setDidFlowState("chat");
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
          onBack={() => {
            // 2026-04-19 — Briefing-aware Back: vrací do terapeut dashboardu,
            // pokud uživatel přišel kliknutím na ask_hanka / ask_kata.
            try {
              if (sessionStorage.getItem("karel_briefing_return") === "1") {
                sessionStorage.removeItem("karel_briefing_return");
              }
            } catch { /* ignore */ }
            setDidSubMode(null);
            setDidFlowState("terapeut");
          }}
        />
      </ScrollArea>
    );
  }

  if (!didSubMode) {
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
        <div className="wizarding-world min-h-full">
          <DidThreadList
            threads={didThreads.threads}
            onSelectThread={handleSelectThread}
            onDeleteThread={(id) => didThreads.deleteThread(id)}
            onNewThread={handleNewCastThread}
          />
          <div className="flex justify-center pb-4">
            <Button variant="ghost" size="sm" onClick={handleDidBackHierarchical}>
              ← Zpět
            </Button>
          </div>
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
      <ScrollArea className="flex-1 px-2 sm:px-4" ref={scrollRef}>
        <div className="max-w-4xl mx-auto py-3 sm:py-6 space-y-3 sm:space-y-4">
          {/* 2026-04-19 — Visible Back in chat view. Bez tohoto tlačítka
              uživatel po otevření briefing-spawned vlákna nemá UI návrat
              do Karlova přehledu. Back logika je v handleDidBackHierarchical,
              která má briefing-return branch (vrací rovnou do terapeut). */}
          <div className="flex items-center">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDidBackHierarchical}
              className="text-muted-foreground hover:text-foreground"
            >
              ← Zpět
            </Button>
          </div>
          {activeThread && (
            <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground bg-muted/50 rounded-lg py-2 px-3">
              <span>
                Vlákno: <strong>{activeThread.threadLabel || activeThread.partName}</strong>
                {activeThread.threadLabel && activeThread.threadLabel !== activeThread.partName && (
                  <span className="text-muted-foreground/60"> ({activeThread.partName})</span>
                )}
                {" "}• {activeThread.partLanguage !== "cs" ? `jazyk: ${activeThread.partLanguage} • ` : ""}{activeThread.messages.length} zpráv
              </span>
              <DidKidsThemeEditor
                partName={activeThread.partName}
                threadId={activeThread.id}
                onThreadThemeSaved={(tid, preset, config) => {
                  didThreads.updateThreadThemeConfig(tid, preset, config);
                  setActiveThread(prev => prev ? { ...prev, themePreset: preset, themeConfig: config, threadEmoji: config.thread_emoji || "" } : prev);
                }}
                trigger={
                  <button className="text-[0.625rem] text-primary hover:underline flex items-center gap-1">
                    🎨 Můj vzhled
                  </button>
                }
              />
            </div>
          )}
          {/* Compact crisis hint — non-narrative, points back to command card */}
          {activeCrisisBanner && didSubMode === "cast" && (
            <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-2 flex items-center gap-2 text-xs">
              <span className="text-destructive font-bold">⚠ AKTIVNÍ KRIZE</span>
              <span className="text-destructive/80">
                {activeCrisisBanner.severity}
              </span>
              <span className="text-muted-foreground ml-auto text-[10px]">
                detail v Karlově přehledu
              </span>
            </div>
          )}
          {messages.map((message, index) => (
            <ChatMessage key={index} message={message} />
          ))}
          {isLoading && messages[messages.length - 1]?.role === "user" && <LoadingSkeleton />}
          {isEnrichingContext && (
            <div className="text-center text-[0.625rem] text-muted-foreground animate-pulse">
              📚 Dostudovávám materiály k tématu...
            </div>
          )}
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
        footerText="Soukromé temenos. Konverzace zůstává jen v tvém prohlížeči."
      >
        <div className="flex items-center gap-2 flex-wrap mt-2">
          <AudioRecordButton
            state={audioRecorder.state} duration={audioRecorder.duration}
            maxDuration={audioRecorder.maxDuration} audioUrl={audioRecorder.audioUrl}
            isAnalyzing={isAudioAnalyzing} onStart={audioRecorder.startRecording}
            onStop={audioRecorder.stopRecording} onDiscard={audioRecorder.discardRecording}
            onSend={handleAudioAnalysis} disabled={isLoading || isSoapLoading}
          />
          <QuickNoteDialog partName={activeThread?.partName} subMode={didSubMode} />
        </div>
        {messages.length > 1 && (
          <DidActionButtons
            subMode={didSubMode}
            onEndCall={handleDidEndCall}
            onManualUpdate={onManualUpdate}
            onLeaveThread={(didSubMode === "cast" || didSubMode === "mamka" || didSubMode === "kata") && activeThread ? handleLeaveThread : undefined}
            onGenerateHandbook={didSubMode === "kata" ? handleGenerateHandbook : undefined}
            onWriteDiary={didSubMode === "cast" && activeThread ? handleWriteDiary : undefined}
            isUpdateLoading={isManualUpdateLoading}
            isHandbookLoading={isHandbookLoading}
            disabled={isLoading}
          />
        )}
      </ChatInputArea>
    </>
  );
};

/* ─────────────────────────────────────────────────────────────────────────
   Surface Reorganization Pass (2026-04-20)
   TerapeutSurfaces — locked target IA pro DID/Terapeut hlavní plochu.

   4 ploch:
     🩺 Dashboard       → frontstage operativy (DidDashboard)
     🧠 Karlův přehled  → decision deck (KarelOverviewPanel)
     💬 Komunikace      → Hanička / Káťa / Porady / Live (původní výběr)
     🔧 Admin           → DidSprava (admin/diagnostika v dialogu)

   Kartotéka částí žije pod Komunikace → Live → Kartotéka (původní cesta,
   nerozbíjíme runtime contracty). Centrum (Drive snapshot view) zůstává
   v Adminu — provozní servis, ne hlavní plocha.
   ───────────────────────────────────────────────────────────────────── */

type TerapeutSurface = "dashboard" | "overview" | "communication" | "admin";

interface TerapeutSurfacesProps {
  navigate: (path: string) => void;
  setDidFlowState: React.Dispatch<React.SetStateAction<DidFlowState>>;
  setDidSubMode: React.Dispatch<React.SetStateAction<any>>;
  setMeetingTherapist: React.Dispatch<React.SetStateAction<"hanka" | "kata">>;
  onManualUpdate: () => Promise<void>;
  isManualUpdateLoading: boolean;
  syncProgress: SyncProgress | null;
  handleDidSubModeSelect: (subMode: any) => void;
  handleQuickThread: (threadId: string, partName: string) => Promise<void>;
  didInitialContext: string;
  basicDocsRef: React.MutableRefObject<string>;
  didContextPrime: { runPrime: (partName?: string, subMode?: string) => void; primeCache: string | null; isPriming: boolean };
}

const TerapeutSurfaces: React.FC<TerapeutSurfacesProps> = ({
  navigate,
  setDidFlowState,
  setDidSubMode,
  setMeetingTherapist,
  onManualUpdate,
  isManualUpdateLoading,
  syncProgress,
  handleDidSubModeSelect,
  handleQuickThread,
  didInitialContext,
  basicDocsRef,
  didContextPrime,
}) => {
  // Persistovaná volba plochy přes navigace (sessionStorage), default = dashboard.
  const [surface, setSurface] = useState<TerapeutSurface>(() => {
    try {
      const saved = sessionStorage.getItem("karel_terapeut_surface");
      if (saved === "overview" || saved === "communication" || saved === "admin" || saved === "dashboard") {
        return saved;
      }
    } catch { /* ignore */ }
    return "dashboard";
  });

  const switchSurface = (next: TerapeutSurface) => {
    setSurface(next);
    try { sessionStorage.setItem("karel_terapeut_surface", next); } catch { /* ignore */ }
  };

  return (
    <div className="jung-study flex-1 flex flex-col min-h-0">
      {/* Tab bar — minimal, sticky, semantic tokens only */}
      <div className="shrink-0 border-b border-border/60 bg-background/80 backdrop-blur-sm">
        <div className="mx-auto max-w-[900px] px-3 sm:px-4">
          <nav role="tablist" aria-label="DID/Terapeut plochy" className="flex items-center gap-1 overflow-x-auto py-2">
            <SurfaceTab active={surface === "dashboard"} onClick={() => switchSurface("dashboard")}>
              🩺 Dashboard
            </SurfaceTab>
            <SurfaceTab active={surface === "overview"} onClick={() => switchSurface("overview")}>
              🧠 Karlův přehled
            </SurfaceTab>
            <SurfaceTab active={surface === "communication"} onClick={() => switchSurface("communication")}>
              💬 Komunikace
            </SurfaceTab>
            <SurfaceTab active={surface === "admin"} onClick={() => switchSurface("admin")}>
              🔧 Admin
            </SurfaceTab>
          </nav>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="relative z-10 min-h-full">
          {surface === "dashboard" && (
            <ErrorBoundary fallbackTitle="Dashboard selhal">
              <DidDashboard
                onManualUpdate={onManualUpdate}
                isUpdating={isManualUpdateLoading}
                syncProgress={syncProgress}
                onQuickSubMode={handleDidSubModeSelect}
                onQuickThread={handleQuickThread}
                contextDocs={didInitialContext || basicDocsRef.current}
                onRefreshMemory={() => didContextPrime.runPrime(undefined, "mamka")}
                isRefreshingMemory={!!(didContextPrime as any).isPriming}
              />
            </ErrorBoundary>
          )}

          {surface === "overview" && (
            <ErrorBoundary fallbackTitle="Karlův přehled selhal">
              <KarelOverviewPanel />
            </ErrorBoundary>
          )}

          {surface === "communication" && (
            <CommunicationSurface
              setDidFlowState={setDidFlowState}
              setDidSubMode={setDidSubMode}
              setMeetingTherapist={setMeetingTherapist}
              onBackToHub={() => navigate("/hub")}
            />
          )}

          {surface === "admin" && (
            <AdminSurface
              navigate={navigate}
            />
          )}
        </div>
      </ScrollArea>
    </div>
  );
};

const SurfaceTab: React.FC<{ active: boolean; onClick: () => void; children: React.ReactNode }> = ({
  active, onClick, children,
}) => (
  <button
    role="tab"
    aria-selected={active}
    onClick={onClick}
    className={`px-3 py-1.5 rounded-lg text-xs font-serif tracking-wide whitespace-nowrap transition-colors ${
      active
        ? "bg-primary/10 text-foreground"
        : "text-muted-foreground hover:text-foreground hover:bg-muted/40"
    }`}
  >
    {children}
  </button>
);

/* ── Komunikace plocha — původní 4 buttony (Hanička / Káťa / Porady / Live) ── */
const CommunicationSurface: React.FC<{
  setDidFlowState: React.Dispatch<React.SetStateAction<DidFlowState>>;
  setDidSubMode: React.Dispatch<React.SetStateAction<any>>;
  setMeetingTherapist: React.Dispatch<React.SetStateAction<"hanka" | "kata">>;
  onBackToHub: () => void;
}> = ({ setDidFlowState, setDidSubMode, setMeetingTherapist }) => (
  <div className="max-w-2xl mx-auto px-3 sm:px-4 py-6">
    <h3 className="text-sm font-serif font-normal mb-4 text-center tracking-wide text-muted-foreground">
      Kdo mluví s Karlem?
    </h3>
    <div className="space-y-2">
      <button
        onClick={() => { setDidSubMode("mamka"); setDidFlowState("pin-entry"); }}
        className="w-full flex items-center gap-3 p-4 rounded-2xl transition-all text-left jung-card hover:shadow-md"
        style={{ borderLeft: "3px solid hsl(28 42% 38%)" }}
      >
        <span className="text-lg">✨</span>
        <div>
          <div className="font-serif font-normal tracking-wide text-foreground">Hanička</div>
          <div className="text-xs font-light tracking-wide text-muted-foreground">Supervize, analýza, plánování – Karel pracuje jako tandem-terapeut</div>
        </div>
      </button>
      <button
        onClick={() => { setDidSubMode("kata"); setDidFlowState("pin-entry"); }}
        className="w-full flex items-center gap-3 p-4 rounded-2xl transition-all text-left jung-card hover:shadow-md"
        style={{ borderLeft: "3px solid hsl(var(--muted-foreground))" }}
      >
        <span className="text-lg">🤍</span>
        <div>
          <div className="font-serif font-normal tracking-wide text-foreground">Káťa</div>
          <div className="text-xs font-light tracking-wide text-muted-foreground">Konzultace – jak reagovat, jak oslovit části, jak podporovat systém</div>
        </div>
      </button>
      <button
        onClick={() => { setDidFlowState("meeting"); setMeetingTherapist("hanka"); }}
        className="w-full flex items-center gap-3 p-4 rounded-2xl transition-all text-left jung-card hover:shadow-md"
        style={{ borderLeft: "3px solid hsl(28 42% 38%)" }}
      >
        <span className="text-lg">📋</span>
        <div>
          <div className="font-serif font-normal tracking-wide text-foreground">Porady týmu</div>
          <div className="text-xs font-light tracking-wide text-muted-foreground">Asynchronní porady – Karel moderuje, oba terapeuti přispívají</div>
        </div>
      </button>
      <button
        onClick={() => { setDidSubMode("mamka"); setDidFlowState("live-session"); }}
        className="w-full flex items-center gap-3 p-4 rounded-2xl transition-all text-left jung-card hover:shadow-md"
        style={{ borderLeft: "3px solid hsl(40 60% 50%)" }}
      >
        <span className="text-lg" style={{ color: "hsl(40 60% 50%)" }}>✦</span>
        <div>
          <div className="font-serif font-normal tracking-wide text-foreground">Live DID sezení</div>
          <div className="text-xs font-light tracking-wide text-muted-foreground">Karel radí v reálném čase při práci s částí – audio + chat</div>
        </div>
      </button>
    </div>
    <p className="text-[11px] text-muted-foreground text-center mt-6">
      Kartotéka částí: otevři Live DID sezení → tlačítko „Kartotéka" v horní liště výběru části.
    </p>
  </div>
);

/* ── Admin plocha — instrukce + přímé otevření DidSprava dialogu ──
     Admin (DidSprava) zůstává inline jako Dialog v Dashboardu. Tady jen
     navedeme uživatele a poskytneme rychlý odkaz. To nerozbíjí stávající
     wiring — všechny admin tooly žijí dál uvnitř DidSprava. */
const AdminSurface: React.FC<{ navigate: (path: string) => void }> = () => (
  <div className="max-w-2xl mx-auto px-3 sm:px-4 py-6 space-y-4">
    <div className="jung-card p-4 space-y-2">
      <h3 className="text-sm font-serif tracking-wide text-foreground">🔧 Admin / Diagnostika</h3>
      <p className="text-xs text-muted-foreground leading-relaxed">
        Servisní plocha — Working Memory inspect, registry, drive queue, health audit, recovery.
        Otevři přes tlačítko <strong>Správa</strong> v horním pravém rohu Dashboardu.
      </p>
      <p className="text-[11px] text-muted-foreground">
        Tato plocha záměrně nedrží trvalá data — admin tooly žijí v dialogu, aby běžná pracovní plocha
        zůstala čistá.
      </p>
    </div>
  </div>
);

const DidContentRouter: React.FC<DidContentRouterProps> = (props) => {
  const { applyTemporaryTheme, restoreGlobalTheme } = useTheme();
  const didSubMode = props.didSubMode;
  const activeThread = props.activeThread;

  const didStorageKey = (() => {
    if (didSubMode === "mamka") return "theme_did_mamka";
    if (didSubMode === "kata") return "theme_did_kata";
    if (didSubMode === "cast" && activeThread) return `theme_did_kids_${activeThread.id}`;
    if (didSubMode === "cast") return "theme_did_kids";
    return "theme_did_entry";
  })();

  return (
    <ThemeStorageKeyProvider value={didStorageKey}>
      <DidContentRouterInner {...props} />
    </ThemeStorageKeyProvider>
  );
};

export default React.memo(DidContentRouter);

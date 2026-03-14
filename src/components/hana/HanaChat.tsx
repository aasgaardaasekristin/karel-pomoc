import { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Progress } from "@/components/ui/progress";
import { Send, Loader2, Brain, Database, Settings, Archive, ChevronDown, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { getAuthHeaders } from "@/lib/auth";
import { toast } from "sonner";
import ChatMessage from "@/components/ChatMessage";
import { useAudioRecorder } from "@/hooks/useAudioRecorder";
import AudioRecordButton from "@/components/AudioRecordButton";
import { useUniversalUpload, buildAttachmentContent } from "@/hooks/useUniversalUpload";
import UniversalAttachmentBar from "@/components/UniversalAttachmentBar";
import GoogleDrivePickerDialog from "@/components/GoogleDrivePickerDialog";
import HanaThreadHistory from "@/components/hana/HanaThreadHistory";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";

type Message = { role: "user" | "assistant"; content: string };

const WELCOME_MESSAGE = "Hani, jsem tady. Mám přístup ke všemu, co o tobě vím – tvým příběhům, vzorcům i strategiím. Pojďme si popovídat. Jak se právě teď cítíš?";

const handleApiError = async (response: Response) => {
  if (response.status === 429) throw new Error("Karel je momentálně přetížený. Zkus to prosím za chvilku.");
  if (response.status === 402) throw new Error("Karel je momentálně nedostupný – pravděpodobně došly AI kredity.");
  if (response.status === 401 || response.status === 403) {
    throw new Error("Přihlášení vypršelo. Přihlas se prosím znovu.");
  }

  const payload = await response.json().catch(() => null);
  const backendError = payload && typeof payload.error === "string" ? payload.error : null;
  throw new Error(backendError || "Něco se pokazilo. Zkus to znovu.");
};

const HanaChat = () => {
  const [messages, setMessages] = useState<Message[]>([{ role: "assistant", content: WELCOME_MESSAGE }]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [isRefreshingMemory, setIsRefreshingMemory] = useState(false);
  const [drivePickerOpen, setDrivePickerOpen] = useState(false);
  const [isFileAnalyzing, setIsFileAnalyzing] = useState(false);
  const [isAudioAnalyzing, setIsAudioAnalyzing] = useState(false);
  const [isBootstrapping, setIsBootstrapping] = useState(false);
  const [isMirroring, setIsMirroring] = useState(false);
  const [bootstrapProgress, setBootstrapProgress] = useState<{ phase: string; percent: number; detail: string } | null>(null);
  const [contextPrimeCache, setContextPrimeCache] = useState<string | null>(null);
  const [contextPrimeStats, setContextPrimeStats] = useState<any>(null);
  const [archivedCount, setArchivedCount] = useState<number>(0);
  const [archiveSummaries, setArchiveSummaries] = useState<{ id: string; summary: string; created_at: string }[]>([]);
  const [showArchiveDialog, setShowArchiveDialog] = useState(false);
  const [spravaOpen, setSpravaOpen] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const audioRecorder = useAudioRecorder();
  const { attachments, fileInputRef, openFilePicker, handleFileChange, captureScreenshot, removeAttachment, clearAttachments, addAttachment } = useUniversalUpload();

  // Load or create active conversation
  useEffect(() => {
    const loadActiveConversation = async () => {
      try {
        const { data } = await supabase
          .from("karel_hana_conversations")
          .select("id, messages")
          .eq("is_active", true)
          .order("last_activity_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (data && Array.isArray(data.messages) && data.messages.length > 0) {
          setConversationId(data.id);
          setMessages(data.messages as Message[]);
        } else if (data) {
          setConversationId(data.id);
        } else {
          // Create new conversation
          const { data: newConv } = await supabase
            .from("karel_hana_conversations")
            .insert({ messages: [{ role: "assistant", content: WELCOME_MESSAGE }] })
            .select("id")
            .single();
          if (newConv) setConversationId(newConv.id);
        }
      } catch (e) {
        console.warn("Failed to load Hana conversation:", e);
      }
    };
    loadActiveConversation();
  }, []);

  // ═══ Auto-trigger context prime on mount and new thread ═══
  const runContextPrime = useCallback(async (silent = true) => {
    try {
      if (silent) console.log("[context-prime] Starting silently...");
      const headers = await getAuthHeaders();
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-hana-context-prime`, {
        method: "POST", headers,
      });
      if (!res.ok) {
        console.warn("[context-prime] Failed:", res.status);
        return;
      }
      const data = await res.json();
      if (data.contextBrief) {
        setContextPrimeCache(data.contextBrief);
        setContextPrimeStats(data.stats);
        console.log(`[context-prime] Cache built: ${data.contextBrief.length} chars, ${data.stats?.totalMs}ms`);
        if (!silent) {
          toast.success(`Paměť osvěžena (${data.stats?.episodes || 0} epizod, ${data.stats?.entities || 0} entit, ${data.stats?.driveFolders || 0} Drive složek)`);
        }
      }
    } catch (e) {
      console.warn("[context-prime] Error:", e);
      if (!silent) toast.error("Chyba při osvěžování paměti");
    }
  }, []);

  // Auto-prime on mount (silently)
  useEffect(() => {
    const timer = setTimeout(() => runContextPrime(true), 1500);
    return () => clearTimeout(timer);
  }, [runContextPrime]);

  // Fetch archived episodes count
  useEffect(() => {
    const fetchArchiveStats = async () => {
      try {
        const { count } = await supabase
          .from("karel_episodes")
          .select("id", { count: "exact", head: true })
          .eq("is_archived", true);
        setArchivedCount(count || 0);
      } catch (e) {
        console.warn("Failed to fetch archive stats:", e);
      }
    };
    fetchArchiveStats();
  }, []);

  const loadArchiveSummaries = useCallback(async () => {
    try {
      const { data } = await supabase
        .from("karel_episodes")
        .select("id, summary_karel, created_at")
        .eq("domain", "ARCHIVE")
        .eq("hana_state", "ARCHIVE_SUMMARY")
        .order("created_at", { ascending: false })
        .limit(50);
      if (data) {
        setArchiveSummaries(data.map(d => ({ id: d.id, summary: d.summary_karel, created_at: d.created_at })));
      }
    } catch (e) {
      console.warn("Failed to load archive summaries:", e);
    }
  }, []);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  // Persist messages to DB only when they actually change (debounced)
  const lastSavedRef = useRef<string>("");
  useEffect(() => {
    if (!conversationId || messages.length < 1) return;
    const serialized = JSON.stringify(messages);
    if (serialized === lastSavedRef.current) return;
    const timeout = setTimeout(() => {
      lastSavedRef.current = serialized;
      supabase
        .from("karel_hana_conversations")
        .update({ messages: messages as any, last_activity_at: new Date().toISOString() })
        .eq("id", conversationId)
        .then();
    }, 2000);
    return () => clearTimeout(timeout);
  }, [conversationId, messages]);

  // Save on visibility change
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === "hidden" && conversationId && messages.length > 1) {
        supabase
          .from("karel_hana_conversations")
          .update({ messages: messages as any, last_activity_at: new Date().toISOString() })
          .eq("id", conversationId)
          .then();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [conversationId, messages]);

  const sendMessage = useCallback(async () => {
    if ((!input.trim() && attachments.length === 0) || isLoading) return;
    const userMessage = input.trim();
    const currentAttachments = [...attachments];
    setInput("");
    clearAttachments();
    const userContent = buildAttachmentContent(userMessage, currentAttachments);
    setMessages(prev => [...prev, { role: "user", content: userContent as any }]);
    setIsLoading(true);
    let assistantContent = "";

    try {
      const headers = await getAuthHeaders();
      const recentMessages = [...messages.slice(-30), { role: "user", content: userContent }];

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-hana-chat`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            messages: recentMessages,
            conversationId,
            contextPrimeCache: contextPrimeCache || undefined,
          }),
        }
      );

      if (!response.ok) await handleApiError(response);
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
          } catch {
            buffer = line + "\n" + buffer;
            break;
          }
        }
      }
    } catch (error) {
      console.error("Hana chat error:", error);
      const errMsg = error instanceof Error ? error.message : "Chyba při komunikaci";
      toast.error(errMsg === "Failed to fetch" ? "Spojení selhalo. Zkus to prosím znovu." : errMsg);
      if (!assistantContent) setMessages(prev => prev.slice(0, -1));
    } finally {
      setIsLoading(false);
      textareaRef.current?.focus();
    }
  }, [input, attachments, isLoading, messages, conversationId, clearAttachments, contextPrimeCache]);

  const handleNewConversation = useCallback(async () => {
    // Archive current
    if (conversationId) {
      await supabase
        .from("karel_hana_conversations")
        .update({ is_active: false, messages: messages as any })
        .eq("id", conversationId);
    }
    // Create new
    const { data: newConv } = await supabase
      .from("karel_hana_conversations")
      .insert({ messages: [{ role: "assistant", content: WELCOME_MESSAGE }] })
      .select("id")
      .single();
    if (newConv) {
      setConversationId(newConv.id);
      setMessages([{ role: "assistant", content: WELCOME_MESSAGE }]);
      toast.success("Nová konverzace zahájena");
      // Re-prime context for new thread (silently)
      setTimeout(() => runContextPrime(true), 500);
    }
  }, [conversationId, messages, runContextPrime]);

  const handleSwitchThread = useCallback(async (threadId: string, threadMessages: { role: string; content: string }[]) => {
    // Save current conversation first
    if (conversationId && messages.length > 1) {
      await supabase
        .from("karel_hana_conversations")
        .update({ messages: messages as any, last_activity_at: new Date().toISOString() })
        .eq("id", conversationId);
    }
    // Mark all as inactive, then activate the selected one
    await supabase
      .from("karel_hana_conversations")
      .update({ is_active: false })
      .neq("id", threadId);
    await supabase
      .from("karel_hana_conversations")
      .update({ is_active: true })
      .eq("id", threadId);
    
    setConversationId(threadId);
    setMessages(threadMessages as Message[]);
    lastSavedRef.current = JSON.stringify(threadMessages);
    toast.success("Vlákno načteno");
    // Auto-refresh context prime for the new thread context
    setTimeout(() => runContextPrime(true), 500);
  }, [conversationId, messages, runContextPrime]);

  const handleRefreshMemory = useCallback(async () => {
    if (isRefreshingMemory) return;
    setIsRefreshingMemory(true);
    try {
      setMessages(prev => [...prev, { role: "assistant", content: "🧠 *[Osvěžuji paměť – Karel skenuje všechny zdroje a buduje kontextovou cache]*" }]);
      await runContextPrime(false);
      // Add a summary message using the fresh cache
      if (contextPrimeStats) {
        setMessages(prev => [...prev, { role: "assistant", content: `✅ *Kontextová cache aktualizována* – ${contextPrimeStats.episodes || 0} epizod, ${contextPrimeStats.entities || 0} entit, ${contextPrimeStats.driveFolders || 0} Drive složek, ${contextPrimeStats.newsAvailable ? "novinky načteny" : "bez novinek"} (${contextPrimeStats.totalMs || 0}ms)` }]);
      }
    } catch (error) {
      console.error("Memory refresh error:", error);
      toast.error("Chyba při osvěžování paměti");
    } finally {
      setIsRefreshingMemory(false);
    }
  }, [isRefreshingMemory, runContextPrime, contextPrimeStats]);

  const isMirroringRef = useRef(false);

  const handleMirrorToDrive = useCallback(async () => {
    // Synchronous mutex — prevents any concurrent execution
    if (isMirroringRef.current) {
      toast.info("Redistribuce byla spuštěna nedávno. Počkej chvíli.");
      return;
    }
    isMirroringRef.current = true;
    setIsMirroring(true);
    try {
      setMessages(prev => [...prev, { role: "assistant", content: "📤 *[Redistribuuji informace – Karel analyzuje všechna vlákna a ukládá poznatky do Drive]*" }]);
      const headers = await getAuthHeaders();
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-memory-mirror`, {
        method: "POST", headers,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      if (data.status === "skipped") {
        setMessages(prev => prev.slice(0, -1));
        toast.info(data.reason || "Redistribuce již probíhá.");
        isMirroringRef.current = false;
        return;
      }
      const summary = [
        `✅ *Redistribuce dokončena*`,
        `📊 Vlákna analyzována: ${data.counts?.threadsScanned || 0}`,
        `🧠 DB aktualizací: ${data.counts?.dbUpdates || 0}`,
        `📁 Drive aktualizací: ${data.counts?.driveUpdates || 0}`,
        data.summary ? `\n${data.summary}` : "",
      ].filter(Boolean).join("\n");
      setMessages(prev => [...prev, { role: "assistant", content: summary }]);
      toast.success(`Redistribuce: ${data.counts?.dbUpdates || 0} DB, ${data.counts?.driveUpdates || 0} Drive`);
    } catch (error) {
      console.error("Mirror error:", error);
      toast.error(error instanceof Error ? error.message : "Chyba při redistribuci");
    } finally {
      setIsMirroring(false);
      // Keep mutex locked for 60s cooldown
      setTimeout(() => { isMirroringRef.current = false; }, 60_000);
    }
  }, []);

  const handleBootstrap = useCallback(async () => {
    if (isBootstrapping) return;
    setIsBootstrapping(true);
    const phases = [
      { key: "threads", label: "DID vlákna", weight: 40 },
      { key: "conversations", label: "DID konverzace", weight: 25 },
      { key: "hana", label: "Hana konverzace", weight: 25 },
      { key: "consolidate", label: "Sémantická konsolidace", weight: 10 },
    ];

    let totalEpisodes = 0;
    let totalErrors: string[] = [];

    try {
      const headers = await getAuthHeaders();

      for (let pi = 0; pi < phases.length; pi++) {
        const phase = phases[pi];
        const basePercent = phases.slice(0, pi).reduce((s, p) => s + p.weight, 0);
        let offset = 0;
        let hasMore = true;

        if (phase.key === "consolidate") {
          setBootstrapProgress({ phase: phase.label, percent: basePercent, detail: "Analyzuji vzorce..." });
          const res = await fetch(
            `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-memory-bootstrap`,
            { method: "POST", headers, body: JSON.stringify({ phase: phase.key }) }
          );
          if (res.ok) {
            const data = await res.json();
            setBootstrapProgress({ phase: phase.label, percent: 100, detail: data.summary || "Hotovo" });
          }
          hasMore = false;
          continue;
        }

        while (hasMore) {
          setBootstrapProgress({
            phase: phase.label,
            percent: basePercent + Math.min(phase.weight - 2, (offset / Math.max(1, offset + 10)) * phase.weight),
            detail: `Zpracovávám od záznamu ${offset}...`,
          });

          const res = await fetch(
            `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-memory-bootstrap`,
            {
              method: "POST",
              headers,
              body: JSON.stringify({ phase: phase.key, batchSize: 10, offset }),
            }
          );

          if (!res.ok) {
            totalErrors.push(`${phase.key}: HTTP ${res.status}`);
            break;
          }

          const data = await res.json();
          totalEpisodes += data.episodes_created || 0;
          if (data.errors?.length) totalErrors.push(...data.errors);

          if (data.next_offset != null) {
            offset = data.next_offset;
          } else {
            hasMore = false;
          }

          setBootstrapProgress({
            phase: phase.label,
            percent: basePercent + phase.weight,
            detail: `${data.processed || 0} zpracováno, ${data.episodes_created || 0} epizod`,
          });
        }
      }

      toast.success(`Bootstrap dokončen: ${totalEpisodes} epizod vytvořeno`);
      if (totalErrors.length > 0) {
        console.warn("[bootstrap] Errors:", totalErrors);
        toast.warning(`${totalErrors.length} chyb během bootstrapu (viz konzole)`);
      }
    } catch (error) {
      console.error("Bootstrap error:", error);
      toast.error("Chyba při bootstrapu paměti");
    } finally {
      setIsBootstrapping(false);
      setBootstrapProgress(null);
    }
  }, [isBootstrapping]);

  const handleAudioAnalysis = useCallback(async () => {
    if (isAudioAnalyzing) return;
    setIsAudioAnalyzing(true);
    try {
      const base64 = await audioRecorder.getBase64();
      if (!base64) throw new Error("Žádná nahrávka");
      const chatContext = messages.slice(-10).map(m =>
        `${m.role === "user" ? "HANA" : "KAREL"}: ${typeof m.content === "string" ? m.content : "(multimodal)"}`
      ).join("\n");
      const headers = await getAuthHeaders();
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-audio-analysis`, {
        method: "POST", headers,
        body: JSON.stringify({ audioBase64: base64, mode: "debrief", chatContext }),
      });
      if (!response.ok) await handleApiError(response);
      const { analysis } = await response.json();
      if (!analysis) throw new Error("Prázdná analýza");
      setMessages(prev => [...prev,
        { role: "assistant", content: "🎙️ *[Audio nahrávka analyzována]*" },
        { role: "assistant", content: analysis },
      ]);
      audioRecorder.discardRecording();
      toast.success("Audio analýza dokončena");
    } catch (error) {
      console.error("Audio analysis error:", error);
      toast.error(error instanceof Error ? error.message : "Chyba při analýze audia");
    } finally {
      setIsAudioAnalyzing(false);
    }
  }, [isAudioAnalyzing, messages, audioRecorder]);

  const handleAutoAnalyze = useCallback(async () => {
    if (isFileAnalyzing || attachments.length === 0 || attachments.some(a => a.uploading)) return;
    setIsFileAnalyzing(true);
    try {
      const attSummary = attachments.map(a => `📎 ${a.name}`).join(", ");
      setMessages(prev => [...prev, { role: "assistant", content: `🔍 *[Analýza příloh: ${attSummary}]*` }]);
      const headers = await getAuthHeaders();
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-analyze-file`, {
        method: "POST", headers,
        body: JSON.stringify({
          attachments: attachments.map(a => ({
            name: a.name, type: a.type, size: a.size, category: a.category,
            dataUrl: a.dataUrl, storagePath: a.storagePath, driveFileId: a.driveFileId,
          })),
          mode: "debrief",
        }),
      });
      if (!response.ok) await handleApiError(response);
      const { analysis } = await response.json();
      if (!analysis) throw new Error("Prázdná analýza");
      setMessages(prev => [...prev, { role: "assistant", content: analysis }]);
      clearAttachments();
      toast.success("Analýza souborů dokončena");
    } catch (error) {
      console.error("File analysis error:", error);
      toast.error(error instanceof Error ? error.message : "Chyba při analýze souborů");
    } finally {
      setIsFileAnalyzing(false);
    }
  }, [isFileAnalyzing, attachments, clearAttachments]);

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

  return (
    <>
      {/* Memory action bar */}
      <div className="border-b border-border bg-card/30">
        <div className="max-w-4xl mx-auto px-4 py-2 flex items-center justify-between">
          <div className="text-sm text-muted-foreground flex items-center gap-1.5">
            <Brain className="w-3.5 h-3.5" />
            Kognitivní agent
          </div>
          <div className="flex items-center gap-2">
            {/* Správa popover */}
            <Popover open={spravaOpen} onOpenChange={setSpravaOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="h-7 px-2 text-xs gap-1">
                  <Settings className="w-3 h-3" />
                  <span>Správa</span>
                  <ChevronDown className="w-3 h-3" />
                  {(isMirroring || isBootstrapping || isRefreshingMemory) && (
                    <Loader2 className="w-3 h-3 animate-spin text-primary" />
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-72 p-3 space-y-3">
                {/* Cache status */}
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Kontextová cache</span>
                  {contextPrimeCache ? (
                    <span className="inline-flex items-center gap-1 text-primary font-medium">
                      <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                      aktivní
                    </span>
                  ) : (
                    <span className="text-muted-foreground/50">neaktivní</span>
                  )}
                </div>

                {/* Archive stats */}
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground flex items-center gap-1">
                    <Archive className="w-3 h-3" />
                    Archivované epizody
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 px-1.5 text-xs text-primary hover:text-primary/80"
                    onClick={() => {
                      loadArchiveSummaries();
                      setShowArchiveDialog(true);
                      setSpravaOpen(false);
                    }}
                  >
                    {archivedCount} →
                  </Button>
                </div>

                <div className="border-t border-border pt-2 space-y-1.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => { handleMirrorToDrive(); setSpravaOpen(false); }}
                    disabled={isMirroring || isLoading}
                    className="w-full justify-start h-8 px-2 text-xs gap-2"
                  >
                    {isMirroring ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Database className="w-3.5 h-3.5" />}
                    Zrcadlit do Drive
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => { handleBootstrap(); setSpravaOpen(false); }}
                    disabled={isBootstrapping || isLoading}
                    className="w-full justify-start h-8 px-2 text-xs gap-2"
                  >
                    {isBootstrapping ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Database className="w-3.5 h-3.5" />}
                    Bootstrap paměti
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => { handleRefreshMemory(); setSpravaOpen(false); }}
                    disabled={isRefreshingMemory || isLoading}
                    className="w-full justify-start h-8 px-2 text-xs gap-2"
                  >
                    {isRefreshingMemory ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Brain className="w-3.5 h-3.5" />}
                    Osvěž paměť
                  </Button>
                </div>
              </PopoverContent>
            </Popover>

            <HanaThreadHistory
              currentConversationId={conversationId}
              onSwitchThread={handleSwitchThread}
              onNewThread={handleNewConversation}
              onMirrorToDrive={handleMirrorToDrive}
            />
          </div>
        </div>
        {bootstrapProgress && (
          <div className="max-w-4xl mx-auto px-4 pb-2 space-y-1">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{bootstrapProgress.phase}</span>
              <span>{Math.round(bootstrapProgress.percent)}%</span>
            </div>
            <Progress value={bootstrapProgress.percent} className="h-1.5" />
            <p className="text-xs text-muted-foreground/70">{bootstrapProgress.detail}</p>
          </div>
        )}
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1 px-2 sm:px-4" ref={scrollRef}>
        <div className="max-w-4xl mx-auto py-3 sm:py-6 space-y-3 sm:space-y-4">
          {messages.map((message, index) => (
            <ChatMessage key={index} message={message} />
          ))}
          {isLoading && messages[messages.length - 1]?.role === "user" && <LoadingSkeleton />}
        </div>
      </ScrollArea>

      {/* Input */}
      <div className="border-t border-border bg-card/50 backdrop-blur-sm">
        <div className="max-w-4xl mx-auto px-2 sm:px-4 py-2 sm:py-4">
          <div className="flex gap-2 sm:gap-3 items-end relative">
            <UniversalAttachmentBar
              attachments={attachments} onRemove={removeAttachment}
              onOpenFilePicker={openFilePicker} onCaptureScreenshot={captureScreenshot}
              onOpenDrivePicker={() => setDrivePickerOpen(true)} onAutoAnalyze={handleAutoAnalyze}
              disabled={isLoading}
              fileInputRef={fileInputRef as React.RefObject<HTMLInputElement>}
              onFileChange={handleFileChange} isAnalyzing={isFileAnalyzing}
            />
            <Textarea
              ref={textareaRef} value={input}
              onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown}
              placeholder="Napiš svou zprávu..."
              className="flex-1 min-w-0 min-h-[44px] sm:min-h-[56px] max-h-[150px] sm:max-h-[200px] resize-none text-sm sm:text-base"
              disabled={isLoading}
            />
            <Button
              onClick={sendMessage}
              disabled={(!input.trim() && attachments.length === 0) || isLoading}
              size="icon" className="h-[44px] w-[44px] sm:h-[56px] sm:w-[56px] shrink-0"
            >
              {isLoading ? <Loader2 className="w-4 h-4 sm:w-5 sm:h-5 animate-spin" /> : <Send className="w-4 h-4 sm:w-5 sm:h-5" />}
            </Button>
          </div>
          <div className="flex items-center gap-2 flex-wrap mt-2">
            <AudioRecordButton
              state={audioRecorder.state} duration={audioRecorder.duration}
              maxDuration={audioRecorder.maxDuration} audioUrl={audioRecorder.audioUrl}
              isAnalyzing={isAudioAnalyzing} onStart={audioRecorder.startRecording}
              onStop={audioRecorder.stopRecording} onDiscard={audioRecorder.discardRecording}
              onSend={handleAudioAnalysis} disabled={isLoading}
            />
          </div>
          <p className="text-xs text-muted-foreground mt-1.5 sm:mt-2 text-center">
            Karel si pamatuje a učí se z každého rozhovoru.
          </p>
        </div>
      </div>

      <GoogleDrivePickerDialog open={drivePickerOpen} onClose={() => setDrivePickerOpen(false)} onFileSelected={addAttachment} />

      {/* Archive summaries dialog */}
      <Dialog open={showArchiveDialog} onOpenChange={setShowArchiveDialog}>
        <DialogContent className="max-w-2xl max-h-[80vh]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Archive className="w-4 h-4" />
              Archivní shrnutí ({archivedCount} epizod)
            </DialogTitle>
            <DialogDescription>
              Komprimované shrnutí epizod starších 90 dní
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[60vh] pr-2">
            {archiveSummaries.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                Žádná archivní shrnutí zatím neexistují.
              </p>
            ) : (
              <div className="space-y-3">
                {archiveSummaries.map((a) => (
                  <div key={a.id} className="border border-border rounded-lg p-3 space-y-1.5">
                    <div className="text-xs text-muted-foreground">
                      {new Date(a.created_at).toLocaleDateString("cs-CZ", { day: "numeric", month: "long", year: "numeric" })}
                    </div>
                    <p className="text-sm whitespace-pre-wrap">{a.summary}</p>
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default HanaChat;

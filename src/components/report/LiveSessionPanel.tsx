import { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Send, Loader2, Square, Mic, Pause, Play, StopCircle, ImagePlus, ClipboardList } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { getAuthHeaders } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { generateSessionReportBlob } from "@/lib/sessionPdfExport";
import { blobToBase64 } from "@/lib/driveUtils";
import { toast } from "sonner";
import { useActiveSessions } from "@/contexts/ActiveSessionsContext";
import ChatMessage from "@/components/ChatMessage";
import { useSessionAudioRecorder } from "@/hooks/useSessionAudioRecorder";
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

type DbPrep = { id: string; session_number: number | null; created_at: string; plan: any; approved_at: string | null; notes: string | null };
type ModifyPhase = "pick" | "editing" | "generating" | "reviewing" | null;

const LiveSessionPanel = ({ clientId, clientName, caseSummary, onEndSession }: LiveSessionPanelProps) => {
  const { activeSession, activeSessionId, updateChatMessages, updateSessionPlan, sessions, createSession, setActiveSession } = useActiveSessions();
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isFinishing, setIsFinishing] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const recorder = useSessionAudioRecorder();
  const [isAudioAnalyzing, setIsAudioAnalyzing] = useState(false);
  const audioSegmentCountRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [imageAnalysisType, setImageAnalysisType] = useState("Kresba klienta");
  const [isImageAnalyzing, setIsImageAnalyzing] = useState(false);
  const [sessionMode, setSessionMode] = useState<SessionMode | null>(null);
  const [customTopic, setCustomTopic] = useState("");
  const [modeConfirmed, setModeConfirmed] = useState(false);
  const [currentPhaseIndex, setCurrentPhaseIndex] = useState(0);
  const greetingSentRef = useRef(false);

  // DB preparations state
  const [dbPreps, setDbPreps] = useState<DbPrep[]>([]);
  const [dbPrepsLoading, setDbPrepsLoading] = useState(true);
  const [selectedPrepId, setSelectedPrepId] = useState<string | null>(null);
  const [modifyPhase, setModifyPhase] = useState<ModifyPhase>(null);
  const [modifyRequest, setModifyRequest] = useState("");
  const [modifiedPlan, setModifiedPlan] = useState<any>(null);
  const [isGeneratingModification, setIsGeneratingModification] = useState(false);

  // Fetch saved preparations from DB
  useEffect(() => {
    const fetchPreps = async () => {
      setDbPrepsLoading(true);
      try {
        const { data } = await supabase
          .from("session_preparations" as any)
          .select("id, session_number, created_at, plan, approved_at, notes")
          .eq("client_id", clientId)
          .order("created_at", { ascending: false });
        setDbPreps((data as unknown as DbPrep[] | null) ?? []);
      } catch (e) {
        console.warn("[LiveSessionPanel] Failed to fetch preps:", e);
      } finally {
        setDbPrepsLoading(false);
      }
    };
    fetchPreps();
  }, [clientId]);

  // Self-heal: ensure activeSession matches this clientId
  const resolvedSessionId = (() => {
    if (activeSession?.clientId === clientId) return activeSessionId;
    const match = sessions.find(s => s.clientId === clientId);
    return match?.id ?? null;
  })();

  useEffect(() => {
    if (activeSession?.clientId === clientId) return;
    const match = sessions.find(s => s.clientId === clientId);
    if (match) {
      console.log("[LiveSessionPanel] Self-heal: activating existing session for client", clientId);
      setActiveSession(match.id);
    } else {
      console.log("[LiveSessionPanel] Self-heal: creating session for client", clientId);
      createSession(clientId, clientName);
    }
  }, [clientId, activeSession?.clientId, sessions, setActiveSession, createSession, clientName]);

  const resolvedSession = activeSession?.clientId === clientId ? activeSession : sessions.find(s => s.clientId === clientId) ?? null;
  const messages = resolvedSession?.chatMessages ?? [];
  const sessionPlan = resolvedSession?.sessionPlan;
  const hasPlan = !!sessionPlan;

  // Debug mount log
  useEffect(() => {
    console.log("[LiveSessionPanel] state", { activeSessionId, resolvedSessionId, hasSession: !!resolvedSession, modeConfirmed, messagesLen: messages.length });
  }, [activeSessionId, resolvedSessionId, resolvedSession, modeConfirmed, messages.length]);

  // Auto-greet after mode confirmed
  useEffect(() => {
    if (!resolvedSessionId || !modeConfirmed || !sessionMode) return;
    if (messages.length > 0 || greetingSentRef.current) return;
    greetingSentRef.current = true;

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
    updateChatMessages(resolvedSessionId, [{ role: "assistant", content: greeting }]);
  }, [modeConfirmed, resolvedSessionId, sessionMode, messages.length, clientName, customTopic, updateChatMessages]);

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
- Pokud dostaneš analýzu obrázku/kresby, reaguj na zjištění a doporuč další postup.
- Buď direktivní a konkrétní. Žádné filozofování.
- DŮLEŽITÉ FORMÁTOVÁNÍ: Všechny přímé rady co má terapeut říct klientovi a tvé okamžité reakce/doporučení (co má terapeut UDĚLAT nebo ŘÍCT) piš TUČNĚ pomocí **bold** markdown. Ostatní text (kontext, pozorování) piš normálně.`;
  }, [clientName, caseSummary, sessionMode, sessionPlan, customTopic]);

  // ── Shared streaming helper ──
  const requestLiveReply = useCallback(async (messagesForAI: Message[], sessionId: string) => {
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
            messages: messagesForAI,
            mode: "supervision",
            didInitialContext: buildContext(),
          }),
        }
      );

      if (!response.ok || !response.body) throw new Error("Chyba");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      updateChatMessages(sessionId, [...messagesForAI, { role: "assistant" as const, content: "" }]);

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
              updateChatMessages(sessionId, [...messagesForAI, { role: "assistant" as const, content: assistantContent }]);
            }
          } catch {
            buffer = line + "\n" + buffer;
            break;
          }
        }
      }
    } catch (error) {
      console.error("[LiveSessionPanel] requestLiveReply error:", error);
      toast.error("Chyba při komunikaci s Karlem");
      if (!assistantContent) updateChatMessages(sessionId, messagesForAI);
    } finally {
      setIsLoading(false);
      textareaRef.current?.focus();
    }
  }, [buildContext, updateChatMessages]);

  // ── Send text message ──
  const sendMessage = async () => {
    console.log("[LiveSessionPanel] sendMessage called", { input: input.trim(), isLoading, resolvedSessionId });
    if (!input.trim() || isLoading) return;

    if (!resolvedSessionId) {
      console.error("[LiveSessionPanel] No resolvedSessionId!", { activeSessionId, clientId, sessionsCount: sessions.length });
      toast.error("Chyba: session nebyla aktivována. Zkus znovu otevřít záložku Asistence.");
      return;
    }

    const userMessage = input.trim();
    setInput("");
    const updatedMessages = [...messages, { role: "user" as const, content: userMessage }];
    updateChatMessages(resolvedSessionId, updatedMessages);
    await requestLiveReply(updatedMessages, resolvedSessionId);
  };

  // ── Audio segment analysis ──
  const handleAudioSegmentAnalysis = async () => {
    if (isAudioAnalyzing) return;
    if (!resolvedSessionId) {
      toast.error("Chyba: session nebyla aktivována");
      return;
    }
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

      if (!response.ok) {
        const errText = await response.text();
        console.error("[LiveSessionPanel] Audio analysis API error:", response.status, errText);
        throw new Error("Chyba při analýze");
      }
      const { analysis } = await response.json();
      if (!analysis) throw new Error("Prázdná analýza");

      const updatedMessages: Message[] = [
        ...messages,
        { role: "user", content: `🎙️ *[Audio segment #${segNum} – ${formatDuration(recorder.duration)}]*\n\n**Analýza nahrávky:**\n${analysis}` },
      ];
      updateChatMessages(resolvedSessionId, updatedMessages);
      recorder.reset();
      toast.success(`Audio segment #${segNum} analyzován`);

      // Karel follows up with live advice
      await requestLiveReply(updatedMessages, resolvedSessionId);
    } catch (error) {
      console.error("Audio analysis error:", error);
      toast.error("Chyba při analýze audia");
    } finally {
      setIsAudioAnalyzing(false);
    }
  };

  // ── Image analysis handler ──
  const handleImageAnalysis = async (file: File) => {
    if (!resolvedSessionId) {
      toast.error("Chyba: session nebyla aktivována");
      return;
    }
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
            attachments: [{
              name: file.name,
              type: file.type,
              size: file.size,
              dataUrl,
              category: "image",
            }],
            mode: "supervision",
            chatContext,
            userPrompt: `Toto je ${imageAnalysisType} KLIENTA (ne terapeuta). Analyzuj v kontextu live sezení.`,
          }),
        }
      );

      if (!res.ok) {
        const errText = await res.text();
        console.error("[LiveSessionPanel] Image analysis API error:", res.status, errText);
        throw new Error("Chyba při analýze");
      }
      const data = await res.json();
      const analysis = data.analysis || data.response || "";
      if (!analysis) throw new Error("Prázdná analýza");

      // Upload to storage + persist metadata
      try {
        const timestamp = Date.now();
        const storagePath = `${clientId}/${timestamp}_${file.name}`;
        const { error: uploadErr } = await supabase.storage
          .from("session-materials")
          .upload(storagePath, file, { contentType: file.type });
        if (!uploadErr) {
          const { data: urlData } = supabase.storage
            .from("session-materials")
            .getPublicUrl(storagePath);
          const materialTypeMap: Record<string, string> = {
            "Kresba klienta": "drawing",
            "Písmo / rukopis": "handwriting",
            "Fotografie": "photo",
            "Dokument": "document",
          };
          await supabase.from("session_materials" as any).insert({
            client_id: clientId,
            material_type: materialTypeMap[imageAnalysisType] || "photo",
            label: `${imageAnalysisType} – ${new Date().toLocaleDateString("cs-CZ")}`,
            storage_url: urlData.publicUrl,
            analysis,
          });
        }
      } catch (e) {
        console.warn("Material persistence failed:", e);
      }

      const updatedMsgs: Message[] = [
        ...messages,
        { role: "user", content: `🖼️ *[${imageAnalysisType}: ${file.name}]*\n\n**Analýza obrázku:**\n${analysis}` },
      ];
      updateChatMessages(resolvedSessionId, updatedMsgs);
      toast.success(`${imageAnalysisType} analyzována`);

      // Karel follows up with live advice
      await requestLiveReply(updatedMsgs, resolvedSessionId);
    } catch (err) {
      console.error("Image analysis error:", err);
      toast.error("Chyba při analýze obrázku");
    } finally {
      setIsImageAnalyzing(false);
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
            sessionPlan: sessionMode === "plan" ? sessionPlan : null,
            sessionMode: sessionMode || "free",
          }),
        }
      );

      if (!response.ok) throw new Error("Chyba při finalizaci");
      const { report } = await response.json();

      // Fire-and-forget Drive backup
      try {
        const today = new Date().toISOString().split("T")[0];
        const blob = await generateSessionReportBlob(clientName, {
          session_number: null,
          session_date: today,
          report_context: "",
          report_key_theme: "",
          report_therapist_emotions: [],
          report_transference: "",
          report_risks: [],
          report_missing_data: "",
          report_interventions_tried: "",
          report_next_session_goal: "",
          ai_analysis: report || "",
          voice_analysis: "",
          notes: "",
        });
        const base64 = await blobToBase64(blob);
        supabase.functions.invoke("karel-session-drive-backup", {
          body: {
            pdfBase64: base64,
            fileName: `Asistence_${clientId}_${today}.pdf`,
            clientId,
            folder: "Asistence",
          },
        });
      } catch (e) {
        console.warn("Assistance backup failed:", e);
      }

      onEndSession(report || "Zápis nebyl vygenerován.");
    } catch (error) {
      console.error("Finalize error:", error);
      toast.error("Chyba při zpracování sezení");
    } finally {
      setIsFinishing(false);
    }
  };

  // Helper: load selected prep into session plan
  const loadPrepIntoPlan = (prep: DbPrep) => {
    if (resolvedSessionId) {
      updateSessionPlan(resolvedSessionId, prep.plan);
    }
  };

  // Helper: generate modified plan via edge function
  const generateModifiedPlan = async (basePlan: any, modifications: string) => {
    setIsGeneratingModification(true);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-session-plan`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            clientId,
            baseAnalysis: null,
            customRequest: null,
            modificationsRequested: `PŮVODNÍ PLÁN:\n${JSON.stringify(basePlan, null, 2)}\n\nPOŽADOVANÉ ÚPRAVY:\n${modifications}`,
          }),
        }
      );
      if (!res.ok) throw new Error(`Chyba: ${res.status}`);
      const { plan } = await res.json();
      setModifiedPlan(plan);
      setModifyPhase("reviewing");
    } catch (e) {
      console.error("[LiveSessionPanel] Modify plan error:", e);
      toast.error("Chyba při generování upraveného plánu");
    } finally {
      setIsGeneratingModification(false);
    }
  };

  // Mode selection dialog
  if (messages.length === 0 && !modeConfirmed) {
    const hasDbPreps = dbPreps.length > 0;
    const canUsePlan = hasPlan || hasDbPreps;

    // Modify flow: reviewing generated plan
    if (modifyPhase === "reviewing" && modifiedPlan) {
      const planObj = modifiedPlan;
      return (
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="w-full max-w-lg space-y-4">
            <div className="text-center space-y-1">
              <h3 className="text-lg font-semibold text-foreground">Upravený plán sezení</h3>
              <p className="text-sm text-muted-foreground">Zkontroluj a schval, nebo uprav dále</p>
            </div>
            <ScrollArea className="max-h-[400px] border border-border rounded-lg p-4 bg-card">
              <div className="space-y-3">
                {planObj.sessionGoal && (
                  <div>
                    <p className="text-xs font-semibold text-muted-foreground uppercase">Cíl sezení</p>
                    <p className="text-sm text-foreground">{planObj.sessionGoal}</p>
                  </div>
                )}
                {planObj.phases?.map((phase: any, i: number) => (
                  <div key={i} className="border-l-2 border-primary/30 pl-3">
                    <p className="text-sm font-medium text-foreground">
                      {phase.timeStart && `${phase.timeStart}–${phase.timeEnd} `}{phase.name}
                    </p>
                    {phase.technique && <p className="text-xs text-muted-foreground">Technika: {phase.technique}</p>}
                    {phase.howToStart && <p className="text-xs text-muted-foreground italic">„{phase.howToStart}"</p>}
                  </div>
                ))}
                {planObj.whyThisPlan && (
                  <div>
                    <p className="text-xs font-semibold text-muted-foreground uppercase">Zdůvodnění</p>
                    <p className="text-xs text-muted-foreground">{planObj.whyThisPlan}</p>
                  </div>
                )}
              </div>
            </ScrollArea>
            <div className="flex gap-2">
              <Button
                className="flex-1"
                onClick={() => {
                  if (resolvedSessionId) updateSessionPlan(resolvedSessionId, modifiedPlan);
                  setModeConfirmed(true);
                }}
              >
                Schválit a začít
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setModifyPhase("editing");
                  setModifyRequest("");
                }}
              >
                Další úpravy
              </Button>
            </div>
          </div>
        </div>
      );
    }

    // Modify flow: editing modifications
    if (modifyPhase === "editing") {
      return (
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="w-full max-w-md space-y-4">
            <div className="text-center space-y-1">
              <h3 className="text-lg font-semibold text-foreground">Jaké úpravy chceš?</h3>
              <p className="text-sm text-muted-foreground">Popiš, co chceš v plánu změnit</p>
            </div>
            <Textarea
              value={modifyRequest}
              onChange={e => setModifyRequest(e.target.value)}
              placeholder="Např. přidej 10 minut na relaxaci na začátku, vynech aktivitu s kresbou..."
              className="min-h-[100px] text-sm"
              disabled={isGeneratingModification}
            />
            <div className="flex gap-2">
              <Button
                className="flex-1"
                disabled={!modifyRequest.trim() || isGeneratingModification}
                onClick={() => {
                  const prep = dbPreps.find(p => p.id === selectedPrepId);
                  const basePlan = modifiedPlan || prep?.plan || sessionPlan;
                  if (basePlan) generateModifiedPlan(basePlan, modifyRequest);
                }}
              >
                {isGeneratingModification ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                {isGeneratingModification ? "Karel generuje…" : "Vygenerovat úpravy"}
              </Button>
              <Button variant="outline" onClick={() => { setModifyPhase(null); setSessionMode(null); }}>
                Zpět
              </Button>
            </div>
          </div>
        </div>
      );
    }

    // Modify flow: generating
    if (modifyPhase === "generating" || isGeneratingModification) {
      return (
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="text-center space-y-4">
            <Loader2 className="w-10 h-10 animate-spin text-primary mx-auto" />
            <p className="text-sm text-muted-foreground">Karel upravuje plán sezení…</p>
          </div>
        </div>
      );
    }

    const handleConfirm = () => {
      if (!sessionMode) return;

      // For plan/modify modes, load the selected DB prep first
      if ((sessionMode === "plan" || sessionMode === "modify") && !hasPlan && hasDbPreps) {
        const prep = selectedPrepId ? dbPreps.find(p => p.id === selectedPrepId) : dbPreps[0];
        if (prep) loadPrepIntoPlan(prep);
      }

      if (sessionMode === "modify") {
        // Enter modify flow
        const prep = selectedPrepId ? dbPreps.find(p => p.id === selectedPrepId) : dbPreps[0];
        if (prep) loadPrepIntoPlan(prep);
        setModifyPhase("editing");
        return;
      }

      if (sessionMode === "custom" && !customTopic.trim()) return;
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
          {!canUsePlan && !dbPrepsLoading && (
            <div className="text-center text-sm text-muted-foreground bg-muted/50 rounded-lg p-3">
              <p>Pro <strong>{clientName}</strong> nemáš připravené sezení.</p>
              <p className="text-xs mt-1">Vyber „Vlastní téma" nebo „Volná asistence".</p>
            </div>
          )}
          {dbPrepsLoading && (
            <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground py-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Načítám přípravy…</span>
            </div>
          )}
          <RadioGroup
            value={sessionMode ?? ""}
            onValueChange={(v) => {
              setSessionMode(v as SessionMode);
              // Auto-select first prep if only one
              if ((v === "plan" || v === "modify") && dbPreps.length === 1) {
                setSelectedPrepId(dbPreps[0].id);
              }
            }}
            className="space-y-3"
          >
            <label className={`flex items-start gap-3 rounded-lg border border-border p-4 cursor-pointer transition-colors hover:bg-accent/50 ${!canUsePlan ? "opacity-50 pointer-events-none" : ""}`}>
              <RadioGroupItem value="plan" id="mode-plan" disabled={!canUsePlan} className="mt-0.5" />
              <div>
                <Label htmlFor="mode-plan" className="font-medium cursor-pointer">Podle návrhu</Label>
                <p className="text-xs text-muted-foreground mt-0.5">Karel tě provede připraveným plánem fázi po fázi</p>
                {hasDbPreps && !hasPlan && (
                  <p className="text-xs text-primary mt-0.5">{dbPreps.length} příprav(a) v kartotéce</p>
                )}
              </div>
            </label>
            <label className={`flex items-start gap-3 rounded-lg border border-border p-4 cursor-pointer transition-colors hover:bg-accent/50 ${!canUsePlan ? "opacity-50 pointer-events-none" : ""}`}>
              <RadioGroupItem value="modify" id="mode-modify" disabled={!canUsePlan} className="mt-0.5" />
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

          {/* Prep picker when plan/modify selected and multiple DB preps exist */}
          {(sessionMode === "plan" || sessionMode === "modify") && !hasPlan && dbPreps.length > 1 && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-foreground">Které připravené sezení použít?</p>
              <RadioGroup
                value={selectedPrepId ?? ""}
                onValueChange={setSelectedPrepId}
                className="space-y-2"
              >
                {dbPreps.map(prep => (
                  <label key={prep.id} className="flex items-center gap-3 rounded-lg border border-border p-3 cursor-pointer transition-colors hover:bg-accent/50">
                    <RadioGroupItem value={prep.id} className="shrink-0" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground">
                        Sezení č. {prep.session_number ?? "?"} — {new Date(prep.created_at || "").toLocaleDateString("cs-CZ")}
                      </p>
                      {prep.approved_at && (
                        <Badge variant="outline" className="text-[10px] mt-0.5">Schváleno</Badge>
                      )}
                    </div>
                  </label>
                ))}
              </RadioGroup>
            </div>
          )}

          {sessionMode === "custom" && (
            <Textarea
              value={customTopic}
              onChange={e => setCustomTopic(e.target.value)}
              placeholder="Na co se chceš zaměřit?"
              className="min-h-[80px] text-sm"
            />
          )}
          <Button
            className="w-full"
            disabled={
              !sessionMode ||
              (sessionMode === "custom" && !customTopic.trim()) ||
              ((sessionMode === "plan" || sessionMode === "modify") && !canUsePlan) ||
              ((sessionMode === "plan" || sessionMode === "modify") && !hasPlan && dbPreps.length > 1 && !selectedPrepId)
            }
            onClick={handleConfirm}
          >
            {sessionMode === "modify" ? "Pokračovat k úpravám" : "Začít sezení"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 relative">
      {/* Phase banner */}
      {sessionMode === "plan" && sessionPlan?.phases && (
        <div className="px-4 py-2 bg-primary/5 border-b border-border flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 min-w-0">
            <Badge variant="outline" className="text-xs shrink-0">
              Fáze {currentPhaseIndex + 1}/{sessionPlan.phases.length}
            </Badge>
            <span className="text-sm font-medium text-foreground truncate">
              {sessionPlan.phases[currentPhaseIndex]?.name}
            </span>
            {sessionPlan.phases[currentPhaseIndex]?.timeRange && (
              <Badge variant="secondary" className="text-[10px] shrink-0">
                {sessionPlan.phases[currentPhaseIndex].timeRange}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            {currentPhaseIndex < sessionPlan.phases.length - 1 && (
              <span className="text-xs text-muted-foreground hidden sm:inline">
                Příští: {sessionPlan.phases[currentPhaseIndex + 1]?.name}
              </span>
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs gap-1"
              disabled={currentPhaseIndex >= sessionPlan.phases.length - 1}
              onClick={() => setCurrentPhaseIndex(i => Math.min(i + 1, sessionPlan.phases.length - 1))}
            >
              → Další fáze
            </Button>
          </div>
        </div>
      )}

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
          {/* Audio analysis progress */}
          {isAudioAnalyzing && (
            <div className="w-full mt-2 space-y-1.5 bg-muted/30 rounded-lg px-3 py-2">
              <div className="flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
                <span className="text-xs text-muted-foreground">Karel analyzuje audio nahrávku…</span>
              </div>
              <div className="h-1.5 w-full bg-secondary rounded-full overflow-hidden">
                <div className="h-full w-full bg-primary rounded-full animate-indeterminate-progress" />
              </div>
            </div>
          )}

          {/* Image analysis controls */}
          <div className="flex items-center gap-2 ml-auto">
            <Select
              value={imageAnalysisType}
              onValueChange={(v) => {
                setImageAnalysisType(v);
                setTimeout(() => fileInputRef.current?.click(), 100);
              }}
            >
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
              onClick={() => fileInputRef.current?.click()}
              disabled={isImageAnalyzing}
              className="gap-1.5 h-8 text-xs"
            >
              {isImageAnalyzing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ImagePlus className="w-3.5 h-3.5" />}
              Nahrát
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (fileInputRef.current) fileInputRef.current.value = "";
                if (!file) return;
                handleImageAnalysis(file);
              }}
            />
          </div>
          {/* Image analysis progress */}
          {isImageAnalyzing && (
            <div className="w-full mt-2 space-y-1.5 bg-muted/30 rounded-lg px-3 py-2">
              <div className="flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
                <span className="text-xs text-muted-foreground">Karel analyzuje {imageAnalysisType.toLowerCase()}…</span>
              </div>
              <div className="h-1.5 w-full bg-secondary rounded-full overflow-hidden">
                <div className="h-full w-full bg-primary rounded-full animate-indeterminate-progress" />
              </div>
            </div>
          )}
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

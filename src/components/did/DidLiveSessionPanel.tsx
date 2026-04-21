import { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Send, Loader2, Square, Mic, Pause, Play, StopCircle, ArrowLeft, Camera, X, Shuffle, CheckCircle, RotateCcw, FileText, ChevronDown, ChevronUp, StickyNote, DoorClosed } from "lucide-react";
import { getAuthHeaders } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import ChatMessage from "@/components/ChatMessage";
import { useSessionAudioRecorder } from "@/hooks/useSessionAudioRecorder";
import { useImageUpload } from "@/hooks/useImageUpload";
import { Progress } from "@/components/ui/progress";
import RichMarkdown from "@/components/ui/RichMarkdown";

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

  // Switch detection state
  const [activePart, setActivePart] = useState(partName);
  const [switchLog, setSwitchLog] = useState<{ from: string; to: string; time: string }[]>([]);
  const [switchFlash, setSwitchFlash] = useState(false);

  // Reflection dialog state
  const [showReflection, setShowReflection] = useState(false);
  const [reflectionEmotions, setReflectionEmotions] = useState<string[]>([]);
  const [reflectionSurprise, setReflectionSurprise] = useState("");
  const [reflectionNextTime, setReflectionNextTime] = useState("");
  const [pendingReport, setPendingReport] = useState("");
  const [pendingSavedSessionId, setPendingSavedSessionId] = useState<string | null>(null);
  const [isSavingReflection, setIsSavingReflection] = useState(false);
  const [sessionCompleted, setSessionCompleted] = useState(false);
  const [completedReport, setCompletedReport] = useState("");

  // ── Live Session Room v1 additions (session prep → live) ──
  // Plán panel viditelný hned v živé místnosti, ne jen jako skrytý kontext.
  const [planExpanded, setPlanExpanded] = useState(true);
  // Quick-note dialog — sběr poznámek během sezení (zařadí se do toku jako 📝).
  const [noteDialogOpen, setNoteDialogOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  // Lehké ukončení bez plné post-session analýzy (pro tento pass — handoff stav).
  const [handoffDialogOpen, setHandoffDialogOpen] = useState(false);
  const [isClosingLight, setIsClosingLight] = useState(false);

  const EMOTION_OPTIONS = [
    "klidná", "nejistá", "frustrovaná", "dojatá",
    "vyčerpaná", "nadějná", "úzkostná", "překvapená",
  ];

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

  const detectSwitch = useCallback((text: string) => {
    const switchMatch = text.match(/\[SWITCH:([^\]]+)\]/);
    if (switchMatch) {
      const newPart = switchMatch[1].trim();
      if (newPart && newPart.toLowerCase() !== activePart.toLowerCase()) {
        const entry = { from: activePart, to: newPart, time: new Date().toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" }) };
        setSwitchLog(prev => [...prev, entry]);
        setActivePart(newPart);
        setSwitchFlash(true);
        setTimeout(() => setSwitchFlash(false), 2000);
        toast.info(`⚡ Switch: ${entry.from} → ${entry.to}`);
      }
      return text.replace(/\[SWITCH:[^\]]+\]/g, "").trim();
    }
    return text;
  }, [activePart]);

  const buildContext = useCallback(() => {
    const switchHistory = switchLog.length > 0
      ? `\nHISTORIE SWITCHŮ V TOMTO SEZENÍ:\n${switchLog.map(s => `${s.time}: ${s.from} → ${s.to}`).join("\n")}\n`
      : "";
    return `═══ LIVE DID SEZENÍ ═══
Část: ${activePart} (původně: ${partName})
Terapeutka: ${therapistName}
Čas: ${new Date().toISOString()}
${switchHistory}
${contextBrief ? `KONTEXT Z KARTOTÉKY:\n${contextBrief.slice(0, 3000)}\n` : ""}
═══ INSTRUKCE ═══
- Jsi Karel, kognitivní agent PŘÍTOMNÝ na živém sezení s DID částí "${activePart}".
- ${therapistName} ti píše, co ${activePart} říká/dělá, nebo posílá audio segmenty.
- Odpovídej OKAMŽITĚ a STRUČNĚ (3-5 řádků max):
  🎯 Co říct ${activePart} (přesná věta, respektuj jazyk a věk části)
  👀 Na co si dát pozor (neverbální signály, switching, disociace)
  ⚠️ Rizika/varování (trigger, freeze, regrese)
  🎮 Další krok (technika, aktivita, uklidnění)
- Pokud dostaneš audio analýzu, reaguj na zjištění z hlasu (tenze, emoce, switching).
- Buď direktivní a konkrétní. Žádné filozofování.
- Respektuj věk a vývojovou úroveň části.
- Při známkách distresu nebo switchingu OKAMŽITĚ upozorni.
- Pokud detekuješ SWITCH (změnu identity/části), označ to tagem [SWITCH:JMÉNO_NOVÉ_ČÁSTI] na konci odpovědi.`;
  }, [partName, activePart, therapistName, contextBrief, switchLog]);

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

      // Detect switch in final response
      if (assistantContent) {
        const cleaned = detectSwitch(assistantContent);
        if (cleaned !== assistantContent) {
          setMessages([...updatedMessages, { role: "assistant", content: cleaned }]);
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
      const images = [...imageUpload.pendingImages];
      imageSegmentCountRef.current += 1;
      const segNum = imageSegmentCountRef.current;

      const chatContext = messages.slice(-6).map(m =>
        `${m.role === "user" ? "TERAPEUT" : "KAREL"}: ${typeof m.content === "string" ? m.content.slice(0, 200) : "(multimodal)"}`
      ).join("\n");

      const attachments = images.map(img => ({
        dataUrl: img.dataUrl,
        name: img.name,
        category: "image" as const,
        type: img.name.match(/\.png$/i) ? "image/png" : "image/jpeg",
        size: 0,
      }));

      const headers = await getAuthHeaders();
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-analyze-file`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            attachments,
            mode: "childcare",
            chatContext,
            userPrompt: `DID část: ${partName}, Terapeutka: ${therapistName}. Analyzuj ${images.length > 1 ? `${images.length} obrázků` : "obrázek"} v kontextu živého sezení — zaměř se na emoční výraz, kresbu, neverbální signály, známky distresu nebo switchingu.`,
          }),
        }
      );

      if (!response.ok) throw new Error("Chyba při analýze obrázku");
      const { analysis } = await response.json();
      if (!analysis) throw new Error("Prázdná analýza");

      const label = images.length > 1
        ? `📷 *[${images.length} obrázků #${segNum}: ${images.map(i => i.name).join(", ")}]*`
        : `📷 *[Obrázek #${segNum}: ${images[0].name}]*`;

      setMessages(prev => [
        ...prev,
        { role: "user", content: label },
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
Konkrétní úkoly pro tým. KAŽDÝ ÚKOL na zvláštní řádek v tomto PŘESNÉM formátu:
- [hanka|kata|both] [today|tomorrow|longterm] Popis úkolu
Příklady:
- [hanka] [today] Zavolat škole ohledně IVP
- [kata] [tomorrow] Připravit relaxační karty pro příští sezení
- [both] [longterm] Domluvit společnou supervizi k switchování

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
      let savedSessionId: string | null = null;
      try {
        // Build switch log text for notes
        const switchLogText = switchLog.length > 0
          ? `\n\n## SWITCH LOG\n${switchLog.map(s => `- ${s.time}: ${s.from} → ${s.to}`).join("\n")}`
          : "";

        const { data: insertedRow } = await supabase.from("did_part_sessions").insert({
          part_name: partName,
          therapist: therapistName,
          session_type: "live",
          ai_analysis: report,
          methods_used: methodsUsed,
          methods_effectiveness: effectiveness,
          tasks_assigned: tasksList,
          audio_analysis: audioAnalyses.join("\n---\n") || "",
          karel_notes: report + switchLogText,
          karel_therapist_feedback: therapistFeedback,
        }).select("id").single();
        savedSessionId = insertedRow?.id || null;
        console.log("Session saved to did_part_sessions");
      } catch (saveErr) {
        console.error("Failed to save session:", saveErr);
      }

      // === Auto-generate tasks on the board ===
      try {
        const structuredTaskRegex = /^-\s*\[(hanka|kata|both)\]\s*\[(today|tomorrow|longterm)\]\s*(.+)/gmi;
        const parsedTasks: { task: string; assignee: "hanka" | "kata" | "both"; category: string }[] = [];
        let tMatch;
        while ((tMatch = structuredTaskRegex.exec(tasksText)) !== null) {
          const assignee = tMatch[1].toLowerCase() as "hanka" | "kata" | "both";
          const category = tMatch[2].toLowerCase();
          const task = tMatch[3].trim();
          if (task && ["hanka", "kata", "both"].includes(assignee) && ["today", "tomorrow", "longterm"].includes(category)) {
            parsedTasks.push({ task, assignee, category });
          }
        }

        let createdCount = 0;
        for (const pt of parsedTasks) {
          const normalized = pt.task.toLowerCase().replace(/\s+/g, " ").trim();
          const { data: existing } = await supabase
            .from("did_therapist_tasks")
            .select("id")
            .neq("status", "done")
            .neq("status", "archived")
            .ilike("task", `%${normalized.slice(0, 30)}%`)
            .limit(1);

          if (existing && existing.length > 0) continue;

          const { error } = await supabase.from("did_therapist_tasks").insert({
            task: pt.task,
            assigned_to: pt.assignee,
            category: pt.category,
            status: "pending",
            status_hanka: "not_started",
            status_kata: "not_started",
            source_agreement: `Sezení s ${partName}`,
            priority: pt.category === "today" ? "high" : pt.category === "tomorrow" ? "normal" : "low",
            detail_instruction: `Co udělat: ${pt.task}\nKontext: Ze sezení s ${partName} (${therapistName}, ${new Date().toLocaleDateString("cs-CZ")})\nDalší krok: Udělej první konkrétní krok a zapiš krátký update.`,
          });
          if (!error) createdCount++;
        }

        if (createdCount > 0) {
          toast.success(`Vytvořeno ${createdCount} ${createdCount === 1 ? "úkol" : createdCount < 5 ? "úkoly" : "úkolů"} na nástěnce`);
        }
      } catch (taskErr) {
        console.error("Failed to auto-create tasks:", taskErr);
      }

      // Update part registry with latest contact
      try {
        await supabase.from("did_part_registry").update({
          last_seen_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq("part_name", partName);
      } catch {}

      // Show reflection dialog instead of immediately finishing
      setPendingReport(report);
      setPendingSavedSessionId(savedSessionId);
      setIsFinishing(false);
      setShowReflection(true);
    } catch (error) {
      console.error("DID Live session finalize error:", error);
      toast.error("Chyba při zpracování sezení");
      setIsFinishing(false);
    }
  };

  const toggleEmotion = (emotion: string) => {
    setReflectionEmotions(prev =>
      prev.includes(emotion) ? prev.filter(e => e !== emotion) : [...prev, emotion]
    );
  };

  const finishAfterReflection = async (skipped: boolean) => {
    setIsSavingReflection(true);
    const report = pendingReport;
    const savedSessionId = pendingSavedSessionId;

    // Build reflection text
    let reflectionText = "";
    if (!skipped && (reflectionEmotions.length > 0 || reflectionSurprise.trim() || reflectionNextTime.trim())) {
      reflectionText = `\n\n## REFLEXE TERAPEUTKY`;
      if (reflectionEmotions.length > 0) {
        reflectionText += `\n**Emoce během sezení:** ${reflectionEmotions.join(", ")}`;
      }
      if (reflectionSurprise.trim()) {
        reflectionText += `\n**Co mě překvapilo:** ${reflectionSurprise.trim()}`;
      }
      if (reflectionNextTime.trim()) {
        reflectionText += `\n**Co bych příště udělala jinak:** ${reflectionNextTime.trim()}`;
      }

      // Save reflection to karel_notes
      if (savedSessionId) {
        try {
          const { data: currentSession } = await supabase
            .from("did_part_sessions")
            .select("karel_notes")
            .eq("id", savedSessionId)
            .single();
          const updatedNotes = (currentSession?.karel_notes || "") + reflectionText;
          await supabase
            .from("did_part_sessions")
            .update({ karel_notes: updatedNotes } as any)
            .eq("id", savedSessionId);
        } catch (err) {
          console.error("Failed to save reflection:", err);
        }
      }
    }

    // Generate handoff note (with reflection context if available)
    if (savedSessionId && report) {
      try {
        const otherTherapist = therapistName === "Hanka" ? "Káťa" : "Hanka";
        const handoffPrompt = `Na základě tohoto zápisu ze sezení s DID částí "${partName}" (vedla ${therapistName}) napiš STRUČNÉ předání pro kolegyni ${otherTherapist}.

Formát: 3-5 bullet pointů zaměřených na to, co ${otherTherapist} POTŘEBUJE VĚDĚT:
- Aktuální emoční stav části
- Co fungovalo / nefungovalo  
- Na co si dát pozor příště
- Případné úkoly nebo doporučení
${reflectionText ? `\nSUBJEKTIVNÍ REFLEXE TERAPEUTKY:\n${reflectionText}\n\nZahrň postřehy terapeutky do předání — kolegyně ocení subjektivní pohled.` : ""}

ZÁPIS:
${report.slice(0, 3000)}

Piš česky, stručně, klinicky přesně. Jen bullet pointy, žádný úvod ani závěr.`;

        const handoffHeaders = await getAuthHeaders();
        const handoffResp = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-chat`,
          {
            method: "POST",
            headers: handoffHeaders,
            body: JSON.stringify({
              messages: [{ role: "user", content: handoffPrompt }],
              mode: "supervision",
            }),
          }
        );

        if (handoffResp.ok && handoffResp.body) {
          const hReader = handoffResp.body.getReader();
          const hDecoder = new TextDecoder();
          let hBuffer = "";
          let handoffNote = "";

          while (true) {
            const { done, value } = await hReader.read();
            if (done) break;
            hBuffer += hDecoder.decode(value, { stream: true });
            let idx: number;
            while ((idx = hBuffer.indexOf("\n")) !== -1) {
              let line = hBuffer.slice(0, idx);
              hBuffer = hBuffer.slice(idx + 1);
              if (line.endsWith("\r")) line = line.slice(0, -1);
              if (!line.startsWith("data: ")) continue;
              const json = line.slice(6).trim();
              if (json === "[DONE]") break;
              try {
                const parsed = JSON.parse(json);
                const content = parsed.choices?.[0]?.delta?.content;
                if (content) handoffNote += content;
              } catch { break; }
            }
          }

          if (handoffNote.trim()) {
            await supabase
              .from("did_part_sessions")
              .update({ handoff_note: handoffNote.trim() } as any)
              .eq("id", savedSessionId);
            console.log("Handoff note saved");
          }
        }
      } catch (handoffErr) {
        console.error("Failed to generate handoff note:", handoffErr);
      }
    }

    setShowReflection(false);
    setIsSavingReflection(false);
    toast.success("Sezení uloženo a analyzováno");

    // Set completed state + reset all session states
    setCompletedReport(report || "Zápis nebyl vygenerován.");
    setMessages([]);
    setInput("");
    setSwitchLog([]);
    setActivePart(partName);
    audioSegmentCountRef.current = 0;
    imageSegmentCountRef.current = 0;
    setSessionCompleted(true);
  };

  // ── Session completed screen ──
  if (sessionCompleted) {
    const handleNewSession = () => {
      setSessionCompleted(false);
      setCompletedReport("");
      // messages are already [], auto-greet will fire
    };
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="bg-card rounded-xl border border-border p-8 space-y-4 text-center max-w-md w-full">
          <CheckCircle className="w-14 h-14 text-primary mx-auto" />
          <h3 className="text-lg font-semibold text-foreground">Sezení ukončeno a analyzováno</h3>
          <p className="text-sm text-muted-foreground">
            Sezení s <span className="font-medium">{partName}</span> ({therapistName}) bylo úspěšně zpracováno a uloženo.
          </p>
          <div className="flex gap-3 justify-center pt-2">
            <Button variant="outline" onClick={handleNewSession} className="gap-1.5">
              <RotateCcw className="w-4 h-4" /> Zahájit nové sezení
            </Button>
            <Button onClick={() => onEnd(completedReport)} className="gap-1.5">
              <ArrowLeft className="w-4 h-4" /> Zpět na přehled
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className={`px-4 py-3 border-b border-border bg-card/50 transition-colors duration-500 ${switchFlash ? "bg-amber-500/10" : ""}`}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <Button variant="ghost" size="icon" onClick={onBack} className="h-8 w-8 shrink-0">
              <ArrowLeft className="w-4 h-4" />
            </Button>
            <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 transition-colors duration-500 ${switchFlash ? "bg-amber-500/20" : "bg-primary/10"}`}>
              <span className="text-sm">🧩</span>
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-foreground">Live DID sezení</h3>
                {switchLog.length > 0 && (
                  <Badge variant="outline" className="text-[9px] gap-0.5 h-4 border-amber-500/40 text-amber-700 dark:text-amber-400">
                    <Shuffle className="w-2.5 h-2.5" />
                    {switchLog.length}× switch
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground truncate">
                <span className={`font-medium ${switchFlash ? "text-amber-600 dark:text-amber-400" : ""}`}>{activePart}</span>
                {activePart !== partName && <span className="text-muted-foreground/60"> (start: {partName})</span>}
                {" • "}{therapistName}
              </p>
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
              <span className="text-xs font-medium text-destructive tabular-nums">{formatDuration(recorder.duration)} / {formatDuration(recorder.maxDuration)}</span>
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
              <span className="text-xs text-muted-foreground">⏸ {formatDuration(recorder.duration)} / {formatDuration(recorder.maxDuration)}</span>
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
              {recorder.audioUrl && <audio src={recorder.audioUrl} controls className="h-8 max-w-[11.25rem]" />}
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

        {/* Switch history strip */}
        {switchLog.length > 0 && (
          <div className="mt-2 flex items-center gap-1.5 flex-wrap">
            <Shuffle className="w-3 h-3 text-amber-600 dark:text-amber-400 shrink-0" />
            {switchLog.map((s, i) => (
              <Badge key={i} variant="outline" className="text-[9px] h-5 border-amber-500/30 text-amber-700 dark:text-amber-400 bg-amber-500/5">
                {s.time} {s.from} → {s.to}
              </Badge>
            ))}
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
              className="flex-1 min-w-0 min-h-[2.75rem] max-h-[7.5rem] resize-none text-sm"
              disabled={isLoading || isFinishing}
            />
            <Button
              size="icon"
              onClick={sendMessage}
              disabled={!input.trim() || isLoading || isFinishing}
              className="h-[2.75rem] w-[2.75rem] shrink-0"
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

      {/* Reflection Dialog */}
      <Dialog open={showReflection} onOpenChange={() => {}}>
        <DialogContent className="sm:max-w-md" onPointerDownOutside={e => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle className="text-base">Reflexe po sezení</DialogTitle>
            <DialogDescription className="text-xs">
              Jak ses cítila během sezení s {partName}? (nepovinné)
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {/* Emotions multiselect */}
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-2">Emoce během sezení</p>
              <div className="flex flex-wrap gap-1.5">
                {EMOTION_OPTIONS.map(emotion => (
                  <Badge
                    key={emotion}
                    variant={reflectionEmotions.includes(emotion) ? "default" : "outline"}
                    className="cursor-pointer text-xs"
                    onClick={() => toggleEmotion(emotion)}
                  >
                    {emotion}
                  </Badge>
                ))}
              </div>
            </div>

            {/* Surprise */}
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">Co tě překvapilo?</p>
              <Textarea
                value={reflectionSurprise}
                onChange={e => setReflectionSurprise(e.target.value)}
                placeholder="1-2 věty…"
                className="min-h-[3.75rem] text-sm"
              />
            </div>

            {/* Next time */}
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">Co bys příště udělala jinak?</p>
              <Textarea
                value={reflectionNextTime}
                onChange={e => setReflectionNextTime(e.target.value)}
                placeholder="1-2 věty…"
                className="min-h-[3.75rem] text-sm"
              />
            </div>

            <div className="flex gap-2 justify-end">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => finishAfterReflection(true)}
                disabled={isSavingReflection}
              >
                Přeskočit
              </Button>
              <Button
                size="sm"
                onClick={() => finishAfterReflection(false)}
                disabled={isSavingReflection}
              >
                {isSavingReflection ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : null}
                Uložit reflexi
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default DidLiveSessionPanel;

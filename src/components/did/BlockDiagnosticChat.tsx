import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { Loader2, Send, Mic, Camera, CheckCircle2, Sparkles, AlertCircle, Square, Video, Image as ImageIcon, X, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { getAuthHeaders } from "@/lib/auth";
import { toast } from "sonner";

/**
 * BlockDiagnosticChat
 * -------------------
 * Inline diagnostický mini-chat pod jedním bodem programu.
 *
 * Zobrazuje:
 *   - 🧪 Brief: pomůcky, instrukce pro dítě, co sledovat (z karel-block-research)
 *   - turn-by-turn log: Karel ↔ Hana (Karel napovídá slovo/otázku, Hana zapisuje reakci)
 *   - input pro další Haninu reakci
 *   - tlačítko "❓ Zeptej se Karla" (ad-hoc další otázka)
 *   - tlačítka 🎙️/📷 pro upload audio/foto vázaného na bod
 *
 * Persistence: turn log se ukládá do localStorage pod `${storageKey}::turns::${blockIndex}`
 * a také propaguje nahoru přes `onTurnsChange`, aby completion gate viděl, co bylo zaznamenáno.
 */

export type DiagTurn = {
  from: "karel" | "hana";
  text: string;
  ts: string;
  attachment?: { kind: "image" | "audio"; label: string };
};

export type BlockResearch = {
  method_label: string;
  method_id?: string;
  supplies: string[];
  setup_instruction: string;
  observe_criteria: string[];
  expected_artifacts: ("image" | "audio" | "text")[];
  followup_questions: string[];
  planned_steps?: string[];
  citations?: string[];
  source?: string;
};

export type BlockArtifact = {
  kind: "image" | "audio";
  label: string;
  data?: string;
  ts: string;
};

interface Props {
  blockIndex: number;
  blockText: string;
  blockDetail?: string;
  partName: string;
  therapistName: string;
  storageKey: string;
  sessionId?: string;
  research?: BlockResearch | null;
  isResearchLoading?: boolean;
  onLoadResearch?: () => void;
  onTurnsChange?: (turns: DiagTurn[]) => void;
  onArtifactsChange?: (artifacts: BlockArtifact[]) => void;
  onRequestArtefact?: (kind: "audio" | "image") => void;
  onMarkDone?: () => void;
  showBrief?: boolean;
  onAdvanceToNext?: () => void;
}

const BlockDiagnosticChat = ({
  blockIndex,
  blockText,
  blockDetail,
  partName,
  therapistName,
  storageKey,
  sessionId,
  research,
  isResearchLoading,
  onLoadResearch,
  onTurnsChange,
  onArtifactsChange,
  onRequestArtefact,
  onMarkDone,
  showBrief = true,
  onAdvanceToNext,
}: Props) => {
  const persistenceVersion = "live-block-v2";
  const turnsKey = `${storageKey}::turns::${blockIndex}`;
  const artKey = `${storageKey}::art::${blockIndex}`;
  const metaKey = `${storageKey}::meta::${blockIndex}`;
  const blockSignature = useMemo(
    () => JSON.stringify({ version: persistenceVersion, text: blockText.trim(), detail: (blockDetail ?? "").trim() }),
    [blockText, blockDetail],
  );

  const [turns, setTurns] = useState<DiagTurn[]>([]);
  const [artifacts, setArtifacts] = useState<BlockArtifact[]>([]);
  const [draft, setDraft] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const [missingArtifacts, setMissingArtifacts] = useState<("image" | "audio")[]>([]);
  const [closeMsg, setCloseMsg] = useState<string | null>(null);
  const [protocolState, setProtocolState] = useState<any>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [localResearch, setLocalResearch] = useState<BlockResearch | null>(null);
  const [localResearchLoading, setLocalResearchLoading] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const autoStartedRef = useRef(false);

  // ── REAL ARTIFACT CAPTURE (2026-04-23 hard fix) ──
  // Předchozí verze jen vytvořila „falešný" placeholder a nic neuploadovala.
  // Teď máme:
  //   - skutečný audio recorder (MediaRecorder, max 5 min)
  //   - file picker pro obrázky (camera + galerie / drag&drop)
  //   - file picker pro video
  //   - okamžitou analýzu přes karel-analyze-file / karel-audio-analysis
  //     → Karel hned napíše, co vidí/slyší (krátce, jako průvodce v real-time)
  const imageInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordStartRef = useRef<number>(0);
  const [isRecording, setIsRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [isAnalyzingArtifact, setIsAnalyzingArtifact] = useState(false);

  const stopRecordingTimer = () => {
    if (recordTimerRef.current) {
      clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      stopRecordingTimer();
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        try { mediaRecorderRef.current.stop(); } catch {}
      }
    };
  }, []);

  useEffect(() => {
    setHydrated(false);
    if (typeof window !== "undefined") {
      try {
        const storedSignature = window.localStorage.getItem(metaKey);
        const shouldReuseStoredData = storedSignature === blockSignature;
        const turnsRaw = shouldReuseStoredData ? window.localStorage.getItem(turnsKey) : null;
        const artRaw = shouldReuseStoredData ? window.localStorage.getItem(artKey) : null;

        if (!shouldReuseStoredData) {
          window.localStorage.removeItem(turnsKey);
          window.localStorage.removeItem(artKey);
        }

        window.localStorage.setItem(metaKey, blockSignature);
        setTurns(turnsRaw ? (JSON.parse(turnsRaw) as DiagTurn[]) : []);
        setArtifacts(artRaw ? (JSON.parse(artRaw) as BlockArtifact[]) : []);
      } catch {
        setTurns([]);
        setArtifacts([]);
      }
    }

    autoStartedRef.current = false;
    setDraft("");
    setLastError(null);
    setMissingArtifacts([]);
    setCloseMsg(null);
    setProtocolState(null);
    setLocalResearch(null);
    setLocalResearchLoading(false);
    setHydrated(true);
  }, [artKey, blockIndex, blockSignature, metaKey, turnsKey]);

  useEffect(() => {
    if (!hydrated) return;
    if (typeof window === "undefined") return;
    try { window.localStorage.setItem(turnsKey, JSON.stringify(turns)); } catch {}
    onTurnsChange?.(turns);
  }, [hydrated, turns, turnsKey, onTurnsChange]);

  useEffect(() => {
    if (!hydrated) return;
    if (typeof window === "undefined") return;
    try { window.localStorage.setItem(artKey, JSON.stringify(artifacts)); } catch {}
    onArtifactsChange?.(artifacts);
  }, [hydrated, artifacts, artKey, onArtifactsChange]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [turns]);

  const effectiveResearch = research ?? localResearch;
  const effectiveResearchLoading = !!isResearchLoading || localResearchLoading;

  const loadResearch = useCallback(async () => {
    if (effectiveResearch || effectiveResearchLoading) return;
    if (onLoadResearch) {
      onLoadResearch();
      return;
    }

    setLocalResearchLoading(true);
    try {
      const { data, error } = await (supabase as any).functions.invoke("karel-block-research", {
        body: {
          part_name: partName,
          program_block: { index: blockIndex, text: blockText, detail: blockDetail },
          depth: "deep",
        },
      });
      if (error) throw error;
      setLocalResearch((data as BlockResearch) ?? null);
    } catch (e) {
      console.error("[BlockDiagnosticChat] research failed:", e);
      toast.error("Nepodařilo se načíst instrukce pro tento bod.");
      setLocalResearch(null);
    } finally {
      setLocalResearchLoading(false);
    }
  }, [effectiveResearch, effectiveResearchLoading, onLoadResearch, partName, blockIndex, blockText, blockDetail]);

  useEffect(() => {
    if (!effectiveResearch && !effectiveResearchLoading) {
      void loadResearch();
    }
  }, [effectiveResearch, effectiveResearchLoading, loadResearch]);

  const callFollowup = useCallback(
    async (trigger: "auto_next" | "ask_karel" | "user_input" | "start", existingTurns: DiagTurn[]): Promise<boolean> => {
      setIsThinking(true);
      setLastError(null);
      try {
        const { data, error } = await (supabase as any).functions.invoke("karel-block-followup", {
          body: {
            part_name: partName,
            therapist_name: therapistName,
            session_id: sessionId,
            program_block: { index: blockIndex, text: blockText, detail: blockDetail },
            research: effectiveResearch ?? null,
            turns: existingTurns.map((t) => ({ from: t.from, text: t.text, ts: t.ts })),
            state: protocolState,
            trigger,
          },
        });
        if (error) throw new Error(error.message || "invoke failed");
        // Server now returns HTTP 200 with `fallback: true` instead of 500
        // when AI gateway returns empty/invalid bodies. Surface as toast,
        // do NOT throw (would trigger blank-screen runtime overlay).
        const isFallback = !!(data as any)?.fallback;
        const fallbackReason = String((data as any)?.fallback_reason ?? "");
        if ((data as any)?.error && !isFallback) throw new Error(String((data as any).error));
        const karelText = String((data as any)?.karel_text ?? "").trim();
        if (!karelText) throw new Error("Karel nevrátil žádný text.");
        const nextTurn: DiagTurn = { from: "karel", text: karelText, ts: new Date().toISOString() };
        setTurns((prev) => [...prev, nextTurn]);
        if ((data as any)?.state_patch) {
          setProtocolState((prev: any) => ({ ...(prev || {}), ...(data as any).state_patch }));
        }
        const done = !!(data as any)?.done;
        const missing: ("image" | "audio")[] = Array.isArray((data as any)?.missing_artifacts)
          ? (data as any).missing_artifacts : [];
        setMissingArtifacts(missing);
        if (done) {
          const cm = (data as any)?.suggested_close_message;
          setCloseMsg(typeof cm === "string" && cm.trim() ? cm.trim() : "Karel má dost dat — můžeš bod uzavřít.");
        }
        if (isFallback) {
          toast.warning(`Karel teď použil bezpečnou náhradní odpověď (${fallbackReason || "AI nevrátila výsledek"}).`);
        }
        // Surface server-side authority guard if it blocked off-plan content
        const auth = (data as any)?.authority;
        if (auth?.validation_fallback_used) {
          toast.warning("Karel chtěl spustit aktivitu mimo závěrečný blok — automaticky jsem ho vrátil k uzavření.");
        }
        return true;
      } catch (e: any) {
        console.error("[BlockDiagnosticChat] followup failed:", e);
        const msg = e?.message ?? String(e);
        setLastError(msg);
        toast.error(`Karel teď nezvládl reagovat: ${msg}`);
        return false;
      } finally {
        setIsThinking(false);
      }
    },
    [partName, therapistName, sessionId, blockIndex, blockText, blockDetail, effectiveResearch, protocolState],
  );

  // Auto-start setup briefing jakmile je k dispozici research.
  // ── HARD GUARD (2026-04-23): start smí proběhnout PRÁVĚ JEDNOU per
  // blockSignature. Před tím musí být:
  //   1. dokončená hydratace localStorage (jinak by start přepsal uložené turny),
  //   2. žádné existující turny (= bod ještě nezačal),
  //   3. dostupný research (parent NEBO local) a NIKOLI loading,
  //   4. žádné běžící AI volání (isThinking).
  // Jinak by se start spouštěl 2× (jednou pro parent research, podruhé když
  // local research dorazí → dvě duplicitní úvodní zprávy v chatu).
  useEffect(() => {
    if (!hydrated) return;
    if (autoStartedRef.current) return;
    if (isThinking) return;
    if (turns.length > 0) { autoStartedRef.current = true; return; }
    if (effectiveResearchLoading) return;
    if (!effectiveResearch) return;
    autoStartedRef.current = true;
    void callFollowup("start", []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, effectiveResearch, effectiveResearchLoading, isThinking, turns.length]);

  const handleSend = async () => {
    const text = draft.trim();
    if (!text) return;
    const haniTurn: DiagTurn = { from: "hana", text, ts: new Date().toISOString() };
    const next = [...turns, haniTurn];
    setTurns(next);
    const prevDraft = draft;
    setDraft("");
    const ok = await callFollowup("auto_next", next);
    if (!ok) {
      setDraft(prevDraft);
      setTurns((curr) => curr.filter((t) => t !== haniTurn));
    }
  };

  const handleAskKarel = () => { void callFollowup("ask_karel", turns); };
  const handleStartFirstTurn = () => { void callFollowup("start", turns); };

  const handleRetry = () => {
    void callFollowup("auto_next", turns);
  };

  // ── REAL ARTIFACT ANALYSIS ──
  // Vezme blob/obrázek, pošle Karlovi a hned přidá jeho stručnou reakci
  // (max ~5 řádků) do per-bod logu. Karel se chová jako průvodce stojící
  // vedle Hany — řekne, co vidí na kresbě, na co se má zeptat, kam směřovat.
  const analyzeArtifactWithKarel = useCallback(
    async (
      kind: "image" | "audio" | "video",
      payload: { dataUrl?: string; audioBase64?: string; fileName: string; mimeType: string },
    ) => {
      setIsAnalyzingArtifact(true);
      const ts = new Date().toISOString();
      const label =
        kind === "image"
          ? `📷 Obrázek/kresba: ${payload.fileName}`
          : kind === "video"
          ? `🎞️ Video: ${payload.fileName}`
          : `🎙️ Audio nahrávka (${payload.fileName})`;

      // 1) Hned přidáme zprávu Hany do per-bod logu (důkaz, že to dorazilo)
      const hanaTurn: DiagTurn = {
        from: "hana",
        text: `${label} — posílám Karlovi`,
        ts,
        attachment: { kind: kind === "video" ? "image" : kind, label },
      };
      setTurns((prev) => [...prev, hanaTurn]);
      setArtifacts((prev) => [
        ...prev,
        { kind: kind === "video" ? "image" : kind, label, ts },
      ]);
      onRequestArtefact?.(kind === "video" ? "image" : kind);

      try {
        const lastTurnsContext = turns
          .slice(-6)
          .map((t) => `${t.from === "karel" ? "K" : "H"}: ${t.text}`)
          .join("\n");

        const briefingPrompt = `Jsi Karel, průvodce ${therapistName} v živém DID sezení s částí ${partName}.
Aktuální bod programu: "${blockText}${blockDetail ? " — " + blockDetail : ""}".
${lastTurnsContext ? `Poslední výměny v tomto bodě:\n${lastTurnsContext}\n` : ""}
${therapistName} právě poslala ${
          kind === "image" ? "obrázek/kresbu" : kind === "video" ? "video" : "audio nahrávku"
        } z tohoto bodu.

Reaguj OKAMŽITĚ a STRUČNĚ (max 5 řádků):
🎯 Co vidím/slyším (1-2 konkrétní pozorování)
👉 Na co se ${therapistName} má teď zeptat ${partName} (přesná otázka)
⚠️ Pokud zachytíš signál (úzkost, switch, regrese) — jednou větou
NEPIŠ dlouhé analýzy. Jsi průvodce v reálném čase, ne soudce.`;

        const headers = await getAuthHeaders();
        let karelText = "";

        if (kind === "image" || kind === "video") {
          const res = await fetch(
            `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-analyze-file`,
            {
              method: "POST",
              headers,
              body: JSON.stringify({
                attachments: [
                  {
                    dataUrl: payload.dataUrl,
                    name: payload.fileName,
                    category: kind === "video" ? "video" : "image",
                    type: payload.mimeType,
                    size: 0,
                  },
                ],
                mode: "childcare",
                chatContext: lastTurnsContext,
                userPrompt: briefingPrompt,
              }),
            },
          );
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          karelText = String(data?.analysis ?? "").trim();
        } else {
          const res = await fetch(
            `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-audio-analysis`,
            {
              method: "POST",
              headers,
              body: JSON.stringify({
                audioBase64: payload.audioBase64,
                mode: "did-live-session",
                chatContext: lastTurnsContext,
                clientName: partName,
                extraContext: briefingPrompt,
              }),
            },
          );
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          karelText = String(data?.analysis ?? "").trim();
        }

        if (!karelText) throw new Error("Karel vrátil prázdnou reakci");

        const karelTurn: DiagTurn = {
          from: "karel",
          text: karelText,
          ts: new Date().toISOString(),
        };
        setTurns((prev) => [...prev, karelTurn]);
        toast.success("Karel zareagoval na přílohu.");
      } catch (e: any) {
        const msg = e?.message ?? String(e);
        console.error("[BlockDiagnosticChat] artifact analysis failed:", e);
        toast.error(`Karel teď přílohu nezpracoval: ${msg}`);
        setTurns((prev) => [
          ...prev,
          {
            from: "karel",
            text: `⚠️ Přílohu jsem teď nezpracoval (${msg}). Zkus prosím znovu, nebo mi popiš, co na ní je.`,
            ts: new Date().toISOString(),
          },
        ]);
      } finally {
        setIsAnalyzingArtifact(false);
      }
    },
    [turns, therapistName, partName, blockText, blockDetail, onRequestArtefact],
  );

  const handleImageFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    Array.from(files).forEach((file) => {
      if (!/^image\//.test(file.type)) {
        toast.error(`${file.name} není obrázek.`);
        return;
      }
      if (file.size > 8 * 1024 * 1024) {
        toast.error(`${file.name} je větší než 8 MB.`);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        void analyzeArtifactWithKarel("image", {
          dataUrl,
          fileName: file.name,
          mimeType: file.type || "image/jpeg",
        });
      };
      reader.readAsDataURL(file);
    });
    if (imageInputRef.current) imageInputRef.current.value = "";
  };

  const handleVideoFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    if (!/^video\//.test(file.type)) {
      toast.error(`${file.name} není video.`);
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      toast.error(`${file.name} je větší než 25 MB.`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      void analyzeArtifactWithKarel("video", {
        dataUrl,
        fileName: file.name,
        mimeType: file.type || "video/mp4",
      });
    };
    reader.readAsDataURL(file);
    if (videoInputRef.current) videoInputRef.current.value = "";
  };

  const startAudioRecording = async () => {
    if (isRecording) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(
        stream,
        MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? { mimeType: "audio/webm;codecs=opus" }
          : { mimeType: "audio/webm" },
      );
      mediaRecorderRef.current = mr;
      audioChunksRef.current = [];
      recordStartRef.current = Date.now();
      setRecordSeconds(0);
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        stopRecordingTimer();
        setIsRecording(false);
        const blob = new Blob(audioChunksRef.current, { type: "audio/webm" });
        if (blob.size === 0) {
          toast.error("Nahrávka je prázdná.");
          return;
        }
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          const base64 = dataUrl.split(",")[1];
          if (!base64) {
            toast.error("Audio se nepodařilo zakódovat.");
            return;
          }
          const fileName = `audio-${new Date()
            .toISOString()
            .slice(11, 19)
            .replace(/:/g, "-")}.webm`;
          void analyzeArtifactWithKarel("audio", {
            audioBase64: base64,
            fileName,
            mimeType: "audio/webm",
          });
        };
        reader.readAsDataURL(blob);
      };
      mr.start(250);
      setIsRecording(true);
      recordTimerRef.current = setInterval(() => {
        const elapsed = Math.floor((Date.now() - recordStartRef.current) / 1000);
        setRecordSeconds(elapsed);
        if (elapsed >= 300) {
          toast.info("Limit 5 minut — nahrávání zastaveno.");
          try { mr.stop(); } catch {}
        }
      }, 500);
      toast.info("🎙️ Nahrávám…");
    } catch (e) {
      console.error("Mic access failed:", e);
      toast.error("Nelze získat přístup k mikrofonu.");
    }
  };

  const stopAudioRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.stop();
    }
  };


  return (
    <div className="rounded-md border border-primary/20 bg-card/50 px-2.5 py-2 space-y-2 min-h-0">
      {/* ── Brief: pomůcky, instrukce, kritéria ── */}
      {showBrief && (
        <div className="rounded-sm border border-border/60 bg-background/70">
          <div className="px-2.5 pb-2 space-y-1.5 text-[11px] text-foreground">
            {!effectiveResearch && !effectiveResearchLoading && (
              <div className="flex items-center justify-between gap-2">
                <p className="text-muted-foreground italic">Karel ještě neprovedl odbornou rešerši.</p>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 text-[10px] gap-1"
                  onClick={() => void loadResearch()}
                >
                  <Sparkles className="w-3 h-3" /> Spustit rešerši
                </Button>
              </div>
            )}
            {effectiveResearchLoading && (
              <div className="flex items-center gap-2 text-muted-foreground italic">
                <Loader2 className="w-3 h-3 animate-spin" /> Karel dohledává odborná kritéria…
              </div>
            )}
            {effectiveResearch && (
              <>
                {effectiveResearch.method_label && (
                  <p>
                    <span className="font-semibold">Metoda:</span> {effectiveResearch.method_label}
                  </p>
                )}
                {effectiveResearch.supplies?.length > 0 && (
                  <p>
                    <span className="font-semibold">Pomůcky:</span> {effectiveResearch.supplies.join(", ")}
                  </p>
                )}
                {effectiveResearch.setup_instruction && (
                  <p>
                    <span className="font-semibold">Instrukce dítěti:</span> „{effectiveResearch.setup_instruction}"
                  </p>
                )}
                {effectiveResearch.observe_criteria?.length > 0 && (
                  <div>
                    <p className="font-semibold">Co sledovat:</p>
                    <ul className="list-disc pl-4 space-y-0.5">
                      {effectiveResearch.observe_criteria.slice(0, 8).map((c, i) => (
                        <li key={i}>{c}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {effectiveResearch.expected_artifacts?.length > 0 && (
                  <p className="text-muted-foreground">
                    <span className="font-semibold">Karel očekává:</span>{" "}
                    {effectiveResearch.expected_artifacts
                      .map((a) => (a === "image" ? "📷 obrázek" : a === "audio" ? "🎙️ audio" : "📝 zápis"))
                      .join(", ")}
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Turn log: Karel ↔ Hana ── */}
      <div
        ref={logRef}
        className="min-h-0 overflow-y-auto rounded-sm border border-border/50 bg-background/40 px-2 py-1.5 space-y-1.5 max-h-[min(40vh,24rem)]"
      >
        {turns.length === 0 ? (
          <div className="text-center py-3">
            <p className="text-[11px] text-muted-foreground italic mb-2">
              Diagnostický chat zatím prázdný.
            </p>
            <Button
              size="sm"
              variant="default"
              className="h-7 text-[10px] gap-1"
              onClick={handleStartFirstTurn}
              disabled={isThinking}
            >
              {isThinking ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Sparkles className="w-3 h-3" />
              )}
              Spustit bod (Karel začne)
            </Button>
          </div>
        ) : (
          turns.map((t, i) => (
            <div
              key={i}
              className={`text-[11px] leading-snug ${
                t.from === "karel"
                  ? "text-primary"
                  : "text-foreground"
              }`}
            >
              <span className="font-semibold mr-1">
                {t.from === "karel" ? "Karel:" : `${therapistName}:`}
              </span>
              <span className="whitespace-pre-wrap">{t.text}</span>
            </div>
          ))
        )}
        {isThinking && (
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground italic">
            <Loader2 className="w-3 h-3 animate-spin" /> Karel přemýšlí…
          </div>
        )}
      </div>

      {/* ── Vstup pro Haninu reakci ── */}
      <div className="flex items-end gap-1.5">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter = odeslat, Shift+Enter = nový řádek
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder={
            turns.length === 0
              ? "Co Tundrupek řekl / udělal? (Enter odešle, Shift+Enter = nový řádek)"
              : "Zapiš jeho další reakci… (Enter odešle)"
          }
          className="min-h-[2.75rem] text-[11px] flex-1"
          disabled={isThinking}
        />
        <div className="flex flex-col gap-1">
          <Button
            size="sm"
            variant="default"
            className="h-7 text-[10px] gap-1 px-2"
            onClick={handleSend}
            disabled={!draft.trim() || isThinking}
            title="Odeslat reakci, Karel pošle další otázku/slovo"
          >
            {isThinking ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
            Pošli
          </Button>
        </div>
      </div>

      {/* ── Chybový stav s retry ── */}
      {lastError && !isThinking && (
        <div className="rounded-sm border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-[11px] text-destructive flex items-center justify-between gap-2">
          <span className="flex items-center gap-1">
            <AlertCircle className="w-3 h-3" /> Karel neodpověděl: {lastError}
          </span>
          <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={handleRetry}>
            Zkus znovu
          </Button>
        </div>
      )}

      {/* ── Skrytá file inputy pro upload ── */}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        multiple
        capture="environment"
        className="hidden"
        onChange={(e) => handleImageFiles(e.target.files)}
      />
      <input
        ref={videoInputRef}
        type="file"
        accept="video/*"
        className="hidden"
        onChange={(e) => handleVideoFiles(e.target.files)}
      />

      {/* ── Tlačítka per-bod artefakty (REAL upload + nahrávání) ── */}
      <div className="flex items-center gap-1.5 flex-wrap border-t border-border/40 pt-2">
        {!isRecording ? (
          <Button
            size="sm"
            variant="outline"
            className="h-6 text-[10px] gap-1"
            onClick={() => void startAudioRecording()}
            disabled={isAnalyzingArtifact}
            title="Začít nahrávat audio (real-time, max 5 min)"
          >
            <Mic className="w-3 h-3" /> Nahrát audio
          </Button>
        ) : (
          <Button
            size="sm"
            variant="destructive"
            className="h-6 text-[10px] gap-1"
            onClick={stopAudioRecording}
            title="Zastavit nahrávání a poslat Karlovi"
          >
            <Square className="w-3 h-3" /> Stop ({Math.floor(recordSeconds / 60)}:
            {String(recordSeconds % 60).padStart(2, "0")})
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          className="h-6 text-[10px] gap-1"
          onClick={() => imageInputRef.current?.click()}
          disabled={isRecording || isAnalyzingArtifact}
          title="Foto z kamery / nahrát kresbu / screenshot"
        >
          <Camera className="w-3 h-3" /> Foto / kresba
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-6 text-[10px] gap-1"
          onClick={() => videoInputRef.current?.click()}
          disabled={isRecording || isAnalyzingArtifact}
          title="Nahrát video"
        >
          <Video className="w-3 h-3" /> Video
        </Button>
        {isAnalyzingArtifact && (
          <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <Loader2 className="w-3 h-3 animate-spin" /> Karel zpracovává…
          </span>
        )}
        {artifacts.length > 0 && !isAnalyzingArtifact && (
          <span className="text-[9px] text-muted-foreground">
            přiloženo: {artifacts.length} {artifacts.length === 1 ? "artefakt" : "artefaktů"}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5 flex-wrap justify-end">
          {closeMsg && onMarkDone && (
            <Button
              size="sm"
              variant="default"
              className="h-6 text-[10px] gap-1"
              onClick={() => {
                onMarkDone();
                toast.success("Bod uzavřen.");
              }}
              title={closeMsg}
            >
              <CheckCircle2 className="w-3 h-3" /> Uzavřít bod
            </Button>
          )}
          {onAdvanceToNext && (
            <Button
              size="sm"
              variant="outline"
              className="h-6 text-[10px] gap-1"
              onClick={onAdvanceToNext}
            >
              Další bod
            </Button>
          )}
        </div>
      </div>

      {/* ── Karlova zpětná vazba (done / missing) ── */}
      {closeMsg && (
        <div className="rounded-sm border border-primary/30 bg-primary/5 px-2 py-1.5 text-[11px] text-foreground">
          <p className="font-semibold flex items-center gap-1 mb-0.5">
            <CheckCircle2 className="w-3 h-3 text-primary" /> Karel: dost dat
          </p>
          <p className="text-muted-foreground">{closeMsg}</p>
          {missingArtifacts.length > 0 && (
            <p className="mt-1 text-amber-700 dark:text-amber-400 flex items-center gap-1 text-[10px]">
              <AlertCircle className="w-3 h-3" /> Ještě prosím přilož:{" "}
              {missingArtifacts
                .map((a) => (a === "image" ? "📷 obrázek/kresbu" : "🎙️ audio nahrávku"))
                .join(", ")}
            </p>
          )}
        </div>
      )}
    </div>
  );
};

export default BlockDiagnosticChat;

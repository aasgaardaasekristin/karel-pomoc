import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Send, Loader2, Square, Mic, Pause, Play, StopCircle, ArrowLeft, Camera, X, Shuffle, CheckCircle, RotateCcw, FileText, ChevronDown, ChevronUp, StickyNote, DoorClosed, AlertTriangle, RefreshCw, Link2, MessageSquare, Sparkles } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { getAuthHeaders } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import ChatMessage from "@/components/ChatMessage";
import { useSessionAudioRecorder } from "@/hooks/useSessionAudioRecorder";
import { useImageUpload } from "@/hooks/useImageUpload";
import { Progress } from "@/components/ui/progress";

import DidPostSessionInterrogation, { type InterrogationAnswer } from "./DidPostSessionInterrogation";
import LiveProgramChecklist from "./LiveProgramChecklist";
import KarelInSessionCards, { type KarelHintTrigger } from "./KarelInSessionCards";
import BlockDiagnosticChat, { type BlockResearch } from "./BlockDiagnosticChat";

type Message = {
  role: "user" | "assistant";
  content: string;
  // ── instrumentace pro „terapeut musí vědět, že to dorazilo" (2026-04-23) ──
  ts?: string;                 // ISO timestamp odeslání / přijetí
  failed?: boolean;            // true = volání karel-chat selhalo, máme retry tlačítko
  errorMsg?: string;           // detail chyby (pro toast/UI)
  acceptedAt?: string;         // HH:MM kdy Karel odpověděl (badge ✓ přijato)
  attachedBlockIndex?: number; // pokud terapeut připojil zprávu k bodu programu
  attachedBlockText?: string;  // krátký label bodu pro UI
};

type LiveAction = "internet_search" | "drive_read" | "image_stimulus" | null;

const detectLiveAction = (text: string): LiveAction => {
  const t = text.toLowerCase();
  if (/(pošli|posli|ukaž|ukaz|dej|vlož|vloz|zobraz).{0,40}(obrázek|obrazek|stimul|skvrn|věž|vez|dveř|dver|cest|les|dům|dum)/i.test(t)) return "image_stimulus";
  if (/(najdi|vyhledej|dohledej|ověř|over|prohledej|internet|googl|kdo je|co je).{0,80}(internet|web|online|zdroj|emma|tustin|článek|clanek|studie|google)|\bemma\s+tustin\b/i.test(t)) return "internet_search";
  if (/(načti|nacti|přečti|precti|podívej|podivej|najdi|otevři|otevri).{0,60}(drive|kartu|kartě|karte|kartot|dokument|soubor)/i.test(t)) return "drive_read";
  return null;
};

const buildTowerStimulusMarkdown = () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 560"><defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d8e3e7"/><stop offset="1" stop-color="#f2eadb"/></linearGradient><linearGradient id="hill" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8fa184"/><stop offset="1" stop-color="#5d6f5a"/></linearGradient></defs><rect width="900" height="560" fill="url(#sky)"/><path d="M0 390 C170 330 270 365 410 330 C575 288 690 330 900 285 L900 560 L0 560 Z" fill="url(#hill)"/><path d="M520 128 L642 128 L662 410 L500 410 Z" fill="#6f6a5d"/><path d="M500 128 L581 64 L662 128 Z" fill="#4f4a43"/><rect x="556" y="319" width="46" height="91" rx="20" fill="#2d2b28"/><rect x="548" y="176" width="24" height="52" rx="12" fill="#d6d0bd"/><rect x="611" y="176" width="24" height="52" rx="12" fill="#d6d0bd"/><path d="M120 438 C205 410 286 417 354 392" stroke="#3f4b3d" stroke-width="10" fill="none" opacity=".45"/><circle cx="188" cy="304" r="34" fill="#69785f" opacity=".75"/><rect x="182" y="324" width="12" height="94" fill="#4b3c31" opacity=".65"/><path d="M0 455 C145 430 270 462 410 436 C588 405 724 438 900 398 L900 560 L0 560 Z" fill="#d8c8a8" opacity=".45"/></svg>`;
  const url = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  return `🖼️ **Obrázkový stimul pro vyprávění**\n\n![Osamělá věž v krajině](${url})\n\nHani, obrázek jsem vložil do chatu. Řekni Arthurovi přesně: „Podívej se na tu věž a vymysli krátký příběh: kdo v ní bydlí, co se stalo předtím a co se stane dál?“\n\nZapiš prosím verbatim odpověď, pauzy, afekt a zda se objeví motiv izolace, ochrany, uvěznění nebo útěku.`;
};

const formatDuration = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
};

// Lokální parser bodů programu — kopírujeme stejnou logiku jako v LiveProgramChecklist,
// abychom v hlavním panelu mohli nabídnout dropdown „Připojit k bodu" bez lift-upu state.
const parseProgramBulletsLocal = (md: string): string[] => {
  if (!md) return [];
  const lines = md.split(/\r?\n/);
  const bullets: string[] = [];
  let inSection = false;
  let started = false;
  const sectionRe = /^#{1,6}\s+program\s+sezení\s*$/i;
  const bulletRe = /^\s*(?:[-*•]|\d+[.)])\s+(.+)$/;
  for (const raw of lines) {
    const line = raw.replace(/\u00A0/g, " ").trimEnd();
    if (sectionRe.test(line)) { inSection = true; started = false; continue; }
    if (inSection && /^#{1,6}\s+/.test(line) && !sectionRe.test(line)) break;
    if (!inSection) continue;
    const m = bulletRe.exec(line);
    if (m) {
      const t = m[1].replace(/\*\*/g, "").replace(/__/g, "").replace(/\s+/g, " ").trim();
      if (t.length >= 6) { bullets.push(t); started = true; }
      continue;
    }
    if (bullets.length > 0 && /^\s{2,}\S/.test(raw)) {
      bullets[bullets.length - 1] = `${bullets[bullets.length - 1]} — ${line.trim()}`;
      continue;
    }
    if (line === "") { if (started) break; continue; }
    if (started) break;
  }
  return bullets.slice(0, 12);
};

interface DidLiveSessionPanelProps {
  partName: string;
  therapistName: string; // "Hanka" or "Káťa"
  contextBrief?: string;
  /**
   * ID dnešního did_daily_session_plans řádku, ze kterého live sezení vzniklo.
   * Používá se k pravdivému přepsání stavu plánu po light close / finální analýze.
   * Optional pro zpětnou kompatibilitu — když chybí, status se nepřepisuje.
   */
  planId?: string;
  onEnd: (summary: string) => void;
  onBack: () => void;
}

/**
 * Live DID Session Panel
 * Karel advises the therapist in real-time during work with a DID part.
 * Similar to LiveSessionPanel but with DID-specific context and prompts.
 */
const DidLiveSessionPanel = ({ partName, therapistName, contextBrief, planId, onEnd, onBack }: DidLiveSessionPanelProps) => {
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
  // 'light'  = ukončeno bez analýzy (uložen surový přepis, čeká na následný analytický krok)
  // 'analyzed' = plně zpracované sezení s Karlovou analýzou
  const [completionMode, setCompletionMode] = useState<"light" | "analyzed">("analyzed");

  // ── Live Session Room v1 additions (session prep → live) ──
  // Plán panel viditelný hned v živé místnosti, ne jen jako skrytý kontext.
  // Default = collapsed. Na malých výškách (888×744) by rozbalený plán
  // společně s tool-stripem a hint kartami vytlačil input mimo viewport
  // a uživatelka by ho fyzicky neměla kam doscrollovat.
  const [planExpanded, setPlanExpanded] = useState(true);
  // Quick-note dialog — sběr poznámek během sezení (zařadí se do toku jako 📝).
  const [noteDialogOpen, setNoteDialogOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  // Lehké ukončení bez plné post-session analýzy (pro tento pass — handoff stav).
  const [handoffDialogOpen, setHandoffDialogOpen] = useState(false);
  const [isClosingLight, setIsClosingLight] = useState(false);

  // ── Post-session interrogation room ──
  // Mezikrok mezi LIVE a finální analýzou: Karel klade cílené otázky, terapeut doplňuje.
  const [showInterrogation, setShowInterrogation] = useState(false);
  const [interrogationPayload, setInterrogationPayload] = useState<{
    qa: InterrogationAnswer[];
    extraNote: string;
  } | null>(null);

  // ── Completion gate (měkká brána) ──
  // Před analýzou Karel zkontroluje, zda u bodů, kde sám očekával povinné artefakty
  // (foto kresby / audio nahrávka), terapeutka opravdu něco přiložila. Pokud ne,
  // zobrazí varování s možností buď ještě doplnit, nebo přesto pokračovat (a chybějící
  // detaily doptat v post-session interrogation roomu).
  const [completionGateOpen, setCompletionGateOpen] = useState(false);
  const [completionGateAction, setCompletionGateAction] = useState<"analyze" | "light_close">("analyze");
  const [missingArtifactsReport, setMissingArtifactsReport] = useState<
    { blockIndex: number; blockText: string; missing: ("image" | "audio")[] }[]
  >([]);

  // ── Karel in-session feedback triggers (pravý sloupec) ──
  const [hintTriggers, setHintTriggers] = useState<KarelHintTrigger[]>([]);
  const pushHintTrigger = useCallback(
    (observation: string, attachmentKind?: KarelHintTrigger["attachmentKind"]) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setHintTriggers(prev => [
        ...prev.slice(-9),
        { id, kind: "observation", observation, attachmentKind: attachmentKind ?? null, programBlock: null },
      ]);
    },
    [],
  );

  // ── Aktivace bodu programu: Karel vyrobí konkrétní obsah ──
  // Drží se referenci na poslední aktivovaný bod, aby přímé výzvy v hlavním
  // chatu typu "napiš mi ty slova" mohly být přesměrovány na produce endpoint.
  const [activeBlock, setActiveBlock] = useState<{ index: number; text: string; detail?: string } | null>(null);

  // ── BLOCK WORKSPACE MODE (2026-04-23 hard reset) ──
  // Když je nastaven, celá obrazovka se přepne do dedikovaného pracovního
  // prostoru jednoho bodu programu (Karlův brief, instrukce, pomůcky, přílohy
  // a per-bod chat). Hana tak vidí JEN to, co k danému bodu potřebuje.
  // null = výchozí "plan_overview" obraz (seznam bodů schváleného plánu).
  const [activeBlockWorkspace, setActiveBlockWorkspace] = useState<{
    index: number;
    text: string;
    detail?: string;
  } | null>(null);
  const [planRefreshTick, setPlanRefreshTick] = useState(0);
  const [researchByIdx, setResearchByIdx] = useState<Record<number, BlockResearch | null>>({});
  const [researchLoadingIdx, setResearchLoadingIdx] = useState<Record<number, boolean>>({});

  const loadBlockResearch = useCallback(
    async (idx: number, blockText: string, blockDetail?: string, depth: "light" | "deep" = "deep") => {
      if (researchByIdx[idx] !== undefined || researchLoadingIdx[idx]) return;
      setResearchLoadingIdx((prev) => ({ ...prev, [idx]: true }));
      try {
        const { data, error } = await (supabase as any).functions.invoke("karel-block-research", {
          body: {
            part_name: partName,
            program_block: { index: idx, text: blockText, detail: blockDetail },
            depth,
          },
        });
        if (error) throw error;
        setResearchByIdx((prev) => ({ ...prev, [idx]: (data as BlockResearch) ?? null }));
      } catch (e) {
        console.warn("[DidLiveSessionPanel] block research failed:", e);
        setResearchByIdx((prev) => ({ ...prev, [idx]: null }));
      } finally {
        setResearchLoadingIdx((prev) => ({ ...prev, [idx]: false }));
      }
    },
    [partName, researchByIdx, researchLoadingIdx],
  );

  // Per-block research cache (do localStorage Karel ukládá expected_artifacts).
  // Pro completion gate stačí číst přímo z localStorage při ukončování.
  const checkMissingArtifacts = useCallback((): { blockIndex: number; blockText: string; missing: ("image" | "audio")[] }[] => {
    if (typeof window === "undefined") return [];
    const baseKey = `live_program_${planId ?? "ad-hoc"}`;
    const result: { blockIndex: number; blockText: string; missing: ("image" | "audio")[] }[] = [];
    try {
      const planRaw = window.localStorage.getItem(baseKey);
      if (!planRaw) return [];
      const items = JSON.parse(planRaw) as { id: string; text: string; done: boolean }[];
      if (!Array.isArray(items)) return [];
      // Iterujeme přes všechny localStorage klíče s research/art/turns prefixem.
      for (let idx = 0; idx < items.length; idx++) {
        // Karel research data jsou v paměti komponenty (loadResearch), ne v LS.
        // Místo toho použijeme heuristiku: pokud byly v BlockDiagnosticChat
        // přidány turny (tj. bod se reálně rozjel), zkontrolujeme artefakty.
        const turnsRaw = window.localStorage.getItem(`${baseKey}::turns::${idx}`);
        if (!turnsRaw) continue;
        const turns = JSON.parse(turnsRaw) as { from: string; text: string; attachment?: { kind: string } }[];
        if (!Array.isArray(turns) || turns.length === 0) continue;
        const artRaw = window.localStorage.getItem(`${baseKey}::art::${idx}`);
        const arts = artRaw ? (JSON.parse(artRaw) as { kind: string }[]) : [];
        const hasImage = arts.some(a => a.kind === "image");
        const hasAudio = arts.some(a => a.kind === "audio");
        // Heuristika: pokud text bodu obsahuje slova kresb/nakresl/portrét/strom/postav/mapa → očekáváme image
        const textLc = items[idx].text.toLowerCase();
        const expectsImage = /(nakresl|kresb|kresl|namaluj|portr|strom|postav|tělov|telov|mandala)/i.test(textLc);
        const expectsAudio = /(asocia|slovn[íi] hr|příběh|pribeh|narrativ|narativ|hra s|figurk)/i.test(textLc);
        const missing: ("image" | "audio")[] = [];
        if (expectsImage && !hasImage) missing.push("image");
        if (expectsAudio && !hasAudio) missing.push("audio");
        if (missing.length > 0) {
          result.push({ blockIndex: idx, blockText: items[idx].text, missing });
        }
      }
    } catch (e) {
      console.warn("[completion gate] failed to scan artifacts:", e);
    }
    return result;
  }, [planId]);

  const requestCloseFlow = useCallback((action: "analyze" | "light_close") => {
    if (messages.length < 2) {
      toast.error("Sezení je prázdné.");
      return;
    }
    const missing = checkMissingArtifacts();
    setMissingArtifactsReport(missing);
    setCompletionGateAction(action);
    if (missing.length > 0) {
      // Měkká brána — varování s možností doplnit nebo pokračovat.
      setCompletionGateOpen(true);
      return;
    }
    // Žádné chybějící artefakty → pokračuj rovnou.
    if (action === "analyze") {
      setShowInterrogation(true);
    } else {
      setHandoffDialogOpen(true);
    }
  }, [messages.length, checkMissingArtifacts]);

  const pushActivateBlock = useCallback(
    (block: { index: number; text: string; detail?: string }, userRequest?: string) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setHintTriggers(prev => [
        ...prev.slice(-9),
        {
          id,
          kind: "activate_block",
          observation: `Spuštěn bod #${block.index + 1}: ${block.text.slice(0, 200)}`,
          attachmentKind: null,
          programBlock: { index: block.index, text: block.text, detail: block.detail ?? null },
          planContext: contextBrief?.slice(0, 2000),
          userRequest,
        },
      ]);
      setActiveBlock(block);
    },
    [contextBrief],
  );

  const EMOTION_OPTIONS = [
    "klidná", "nejistá", "frustrovaná", "dojatá",
    "vyčerpaná", "nadějná", "úzkostná", "překvapená",
  ];

  // Auto-greet ZAKÁZÁN (2026-04-23):
  //  Generický uvítací odstavec ("Hani, jsem tu s tebou...") zabíral celý
  //  hlavní obraz a tlačil pryč to, co Hana skutečně potřebuje vidět:
  //  schválený plán bod po bodu. Místo toho startujeme s prázdnou historií
  //  hlavního chatu a hlavním obsahem se stává LiveProgramChecklist.
  //  Hlavní chat zůstává jako fallback dole pro volné poznámky a komunikaci
  //  mimo konkrétní bod programu.

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
- ⚡ POVINNÉ POTVRZENÍ PŘÍJMU: V PRVNÍ větě své odpovědi DOSLOVA odcituj klíčové slovo / asociaci / větu, kterou ti ${therapistName} právě napsala. Formát: "Slyším: »…« — …" nebo "Beru: »…« — …". Tím terapeutka uvidí, že jsi její vstup skutečně přijal. NIKDY tento řádek nevynechej.
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

  // Detekce přímé výzvy „napiš mi slova / otázky / nápady" — přesměrujeme na produce
  const CONTENT_REQUEST_RE = /(napiš|dej|navrhni|vygeneruj|řekni|vyrob)\s+(mi\s+)?(ty\s+)?(slova|asociace|otázky|otazky|nápady|napady|barvy|instrukci|seznam)/i;

  // ── Volba bodu programu, ke kterému se další zpráva připojí (dropdown vedle textarey) ──
  const programBlocks = useMemo(() => parseProgramBulletsLocal(contextBrief ?? ""), [contextBrief]);
  const [attachToBlockIdx, setAttachToBlockIdx] = useState<number | null>(null);

  // ── Pomocná funkce: přidá zápis do localStorage diagnostického logu daného bodu ──
  // BlockDiagnosticChat čte tento klíč při mountu (`${storageKey}::turns::${idx}`).
  // Tím Karelovo „připojeno k bodu" reálně dorazí do per-bod chatu i do completion gate.
  const appendToBlockTurns = useCallback((blockIndex: number, hanaText: string, karelText?: string) => {
    if (typeof window === "undefined") return;
    const baseKey = `live_program_${planId ?? "ad-hoc"}`;
    const turnsKey = `${baseKey}::turns::${blockIndex}`;
    try {
      const raw = window.localStorage.getItem(turnsKey);
      const arr: { from: string; text: string; ts: string }[] = raw ? JSON.parse(raw) : [];
      const ts = new Date().toISOString();
      arr.push({ from: "hana", text: hanaText, ts });
      if (karelText) arr.push({ from: "karel", text: karelText, ts: new Date().toISOString() });
      window.localStorage.setItem(turnsKey, JSON.stringify(arr));
    } catch (e) {
      console.warn("[live] appendToBlockTurns failed:", e);
    }
  }, [planId]);

  // ── Jádro odeslání: streamuje karel-chat odpověď. Vrací true při úspěchu. ──
  // Klíčové oproti původní verzi: NIKDY nemažeme uživatelskou zprávu z chatu.
  // Při chybě jen označíme zprávu `failed=true` (UI nabídne „Zkusit znovu").
  const streamKarelReply = useCallback(async (
    historyForApi: Message[],
    userMsgTs: string,
    blockAttachment?: { index: number; text: string },
  ): Promise<boolean> => {
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
            messages: historyForApi,
            mode: "supervision",
            didInitialContext: buildContext(),
          }),
        }
      );
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      // Vlož prázdnou Karlovu zprávu — bude se postupně plnit streamem
      setMessages(prev => [...prev, { role: "assistant", content: "", ts: new Date().toISOString() }]);

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
              setMessages(prev => {
                const next = [...prev];
                // poslední zpráva je Karel — aktualizuj content
                for (let i = next.length - 1; i >= 0; i--) {
                  if (next[i].role === "assistant") {
                    next[i] = { ...next[i], content: assistantContent };
                    break;
                  }
                }
                return next;
              });
            }
          } catch {
            buffer = line + "\n" + buffer;
            break;
          }
        }
      }

      // Vyčistit case: Karel nic nevrátil → považujeme za chybu (failed badge)
      if (!assistantContent.trim()) {
        // Smaž prázdnou Karlovu placeholder zprávu
        setMessages(prev => {
          const next = [...prev];
          if (next.length && next[next.length - 1].role === "assistant" && !next[next.length - 1].content) {
            next.pop();
          }
          return next;
        });
        throw new Error("Karel vrátil prázdnou odpověď");
      }

      // Detekce switche
      const cleaned = detectSwitch(assistantContent);
      const finalContent = cleaned !== assistantContent ? cleaned : assistantContent;
      const acceptedAt = new Date().toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" });

      // Označ uživatelskou zprávu jako přijatou + vyčisti případný předchozí failed stav.
      // Současně dopiš Karlovu finální verzi (po switch cleanup).
      setMessages(prev => {
        const next = [...prev];
        for (let i = next.length - 1; i >= 0; i--) {
          if (next[i].role === "assistant") {
            next[i] = { ...next[i], content: finalContent };
            break;
          }
        }
        for (let i = next.length - 1; i >= 0; i--) {
          if (next[i].role === "user" && next[i].ts === userMsgTs) {
            next[i] = { ...next[i], failed: false, errorMsg: undefined, acceptedAt };
            break;
          }
        }
        return next;
      });

      // Pokud byla zpráva připojena k bodu programu, zaloguj i Karlovu odpověď
      // do diagnostického logu daného bodu (ať to přežije remount + completion gate).
      if (blockAttachment) {
        appendToBlockTurns(blockAttachment.index, /* hana */ "", finalContent);
        // Note: hana text byl už zalogován v sendMessage před streamem.
      }

      // Hint trigger spustíme až PO úspěšném streamu — neblbne pravý sloupec při chybě.
      // Pošleme jen poslední uživatelský vstup.
      const lastUserText = historyForApi[historyForApi.length - 1]?.content ?? "";
      if (lastUserText) pushHintTrigger(lastUserText, "note");

      return true;
    } catch (error) {
      console.error("DID Live session stream error:", error);
      const errMsg = error instanceof Error ? error.message : "Neznámá chyba";

      // ── KLÍČOVÁ OPRAVA: NIKDY nemažeme zprávu Hany ──
      // Označíme ji `failed=true` a uživatelka má retry tlačítko.
      setMessages(prev => {
        const next = [...prev];
        // Smaž prázdnou Karlovu placeholder zprávu (pokud vznikla)
        if (next.length && next[next.length - 1].role === "assistant" && !next[next.length - 1].content.trim()) {
          next.pop();
        }
        // Najdi uživatelskou zprávu podle ts a označ failed
        for (let i = next.length - 1; i >= 0; i--) {
          if (next[i].role === "user" && next[i].ts === userMsgTs) {
            next[i] = { ...next[i], failed: true, errorMsg: errMsg, acceptedAt: undefined };
            break;
          }
        }
        return next;
      });
      toast.error(`Karel teď neodpověděl — text máš uložený, klikni „Zkusit znovu". (${errMsg})`);
      return false;
    } finally {
      setIsLoading(false);
      textareaRef.current?.focus();
    }
  }, [buildContext, detectSwitch, pushHintTrigger, appendToBlockTurns]);

  const sendMessage = async () => {
    if (!input.trim() || isLoading) return;
    const userMessage = input.trim();
    setInput("");

    // Přímá výzva na produkci obsahu pro aktivní bod → produce endpoint místo karel-chat
    if (activeBlock && CONTENT_REQUEST_RE.test(userMessage)) {
      const ts = new Date().toISOString();
      setMessages(prev => [...prev, { role: "user", content: userMessage, ts, acceptedAt: new Date().toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" }) }]);
      pushActivateBlock(activeBlock, userMessage);
      toast.info(`Karel vyrábí obsah pro bod #${activeBlock.index + 1}…`);
      return;
    }

    // Atašmán k bodu programu (z dropdownu vedle textarey)
    const attached = (attachToBlockIdx !== null && programBlocks[attachToBlockIdx])
      ? { index: attachToBlockIdx, text: programBlocks[attachToBlockIdx] }
      : undefined;

    const ts = new Date().toISOString();
    const userObj: Message = {
      role: "user",
      content: userMessage,
      ts,
      attachedBlockIndex: attached?.index,
      attachedBlockText: attached?.text,
    };
    const updatedMessages: Message[] = [...messages, userObj];
    setMessages(updatedMessages);

    // Pokud terapeut připojuje zprávu k bodu, hned ji zaloguj do per-bod logu
    // (i kdyby Karel selhal, asociace zůstane uložená u bodu).
    if (attached) {
      appendToBlockTurns(attached.index, userMessage);
    }

    // Reset výběru bodu po odeslání — terapeut musí explicitně připojit znovu
    setAttachToBlockIdx(null);

    // Připrav historii pro API (BEZ instrumentačních polí, jen role+content)
    const apiHistory: Message[] = updatedMessages.map(m => ({ role: m.role, content: m.content }));
    await streamKarelReply(apiHistory, ts, attached);
  };

  // ── Retry pro neúspěšné zprávy ──
  // Zprávu Hany ponecháme; jen znovu zavoláme stream s aktuální historií.
  const retryUserMessage = useCallback(async (msgTs: string) => {
    if (isLoading) return;
    const idx = messages.findIndex(m => m.role === "user" && m.ts === msgTs);
    if (idx < 0) return;
    // Vyčisti failed flag, aby UI hned přepnulo na „přemýšlí…"
    setMessages(prev => prev.map((m, i) => i === idx ? { ...m, failed: false, errorMsg: undefined } : m));
    const apiHistory: Message[] = messages.slice(0, idx + 1).map(m => ({ role: m.role, content: m.content }));
    const attached = messages[idx].attachedBlockIndex !== undefined && messages[idx].attachedBlockText
      ? { index: messages[idx].attachedBlockIndex!, text: messages[idx].attachedBlockText! }
      : undefined;
    await streamKarelReply(apiHistory, msgTs, attached);
  }, [messages, isLoading, streamKarelReply]);


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
      // Karel proaktivní reakce na čerstvou audio analýzu
      pushHintTrigger(
        `Nová audio analýza segmentu #${segNum} (${formatDuration(recorder.duration)}):\n${analysis.slice(0, 800)}`,
        "audio",
      );
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
      // Karel proaktivní reakce na obrazovou analýzu
      pushHintTrigger(
        `Nová obrazová analýza (${images.length}× ${images.length > 1 ? "obrázků" : "obrázek"}):\n${analysis.slice(0, 800)}`,
        "image",
      );
      imageUpload.clearImages();
      toast.success(`Obrázek #${segNum} analyzován`);
    } catch (error) {
      console.error("Image analysis error:", error);
      toast.error("Chyba při analýze obrázku");
    } finally {
      setIsImageAnalyzing(false);
    }
  };

  // ── Quick note (📝) — vloží poznámku do toku jako user message ──
  const handleAddNote = () => {
    const text = noteDraft.trim();
    if (!text) return;
    const stamp = new Date().toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" });
    setMessages(prev => [
      ...prev,
      { role: "user", content: `📝 *[Poznámka ${stamp}]*\n\n${text}` },
    ]);
    // Karel proaktivní reakce na poznámku terapeutky
    pushHintTrigger(`Poznámka terapeutky [${stamp}]:\n${text}`, "note");
    setNoteDraft("");
    setNoteDialogOpen(false);
    toast.success("Poznámka uložena");
  };

  // ── Lehké ukončení sezení (handoff stav, bez plné analýzy) ──
  // Pro tento pass: uloží surový přepis + audio segmenty do did_part_sessions
  // a propíše „sezení ukončeno" stav. Plná Karelova analýza se neprovádí.
  const handleLightClose = async () => {
    if (messages.length < 2) {
      toast.error("Sezení je prázdné.");
      return;
    }
    setIsClosingLight(true);
    try {
      const transcript = messages
        .map(m => `${m.role === "user" ? "TERAPEUT" : "KAREL"}: ${m.content}`)
        .join("\n\n");
      const switchLogText = switchLog.length > 0
        ? `\n\n## SWITCH LOG\n${switchLog.map(s => `- ${s.time}: ${s.from} → ${s.to}`).join("\n")}`
        : "";
      const audioAnalyses = messages
        .filter(m => m.role === "assistant" && messages[messages.indexOf(m) - 1]?.content?.includes("🎙️"))
        .map(m => m.content);

      await supabase.from("did_part_sessions").insert({
        part_name: partName,
        therapist: therapistName,
        session_type: "live",
        ai_analysis: "",
        karel_notes: `## SUROVÝ PŘEPIS (bez analýzy)\n\n${transcript}${switchLogText}`,
        audio_analysis: audioAnalyses.join("\n---\n") || "",
        karel_therapist_feedback: "",
      });

      // ── PRAVDIVÝ STAV PLÁNU: light close → awaiting_analysis ──
      // Plán už neběží, ale taky není analyzovaný. Pracovna layer 4 toto
      // musí vidět jinak než `in_progress` nebo `done`.
      if (planId) {
        try {
          await (supabase as any)
            .from("did_daily_session_plans")
            .update({
              status: "awaiting_analysis",
              updated_at: new Date().toISOString(),
            })
            .eq("id", planId);
        } catch (planErr) {
          console.warn("Failed to update plan status to awaiting_analysis:", planErr);
        }
      }

      toast.success("Sezení ukončeno — připraveno pro následnou analýzu");
      setHandoffDialogOpen(false);
      setCompletedReport("Surový přepis uložen. Plná analýza proběhne v dalším kroku.");
      setMessages([]);
      setInput("");
      setSwitchLog([]);
      setActivePart(partName);
      audioSegmentCountRef.current = 0;
      imageSegmentCountRef.current = 0;
      setCompletionMode("light");
      setSessionCompleted(true);
    } catch (e) {
      console.error("Light close failed:", e);
      toast.error("Nepodařilo se ukončit sezení");
    } finally {
      setIsClosingLight(false);
    }
  };

  // End session — generate analysis + save to did_part_sessions
  // Optional `qa` parameter: výstup z post-session interrogation roomu (cílené otázky + odpovědi).
  const handleEndSession = async (qa?: InterrogationAnswer[], extraNote?: string) => {
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

      // Build interrogation block (cílené Q&A + vlastní postřeh terapeutky)
      const answeredQA = (qa || []).filter(item => item.answer.trim().length > 0);
      const interrogationBlock = answeredQA.length > 0 || (extraNote && extraNote.trim())
        ? `\n\nDOPTÁVÁNÍ PO SEZENÍ (post-session interrogation):\n${
            answeredQA.map((it, i) => `Q${i + 1}: ${it.question}\nA${i + 1}: ${it.answer}${it.attachments.length > 0 ? `\n   📎 ${it.attachments.map(a => `${a.kind}: ${a.label}`).join(", ")}` : ""}`).join("\n\n")
          }${extraNote && extraNote.trim() ? `\n\nVLASTNÍ POSTŘEH TERAPEUTKY:\n${extraNote.trim()}` : ""}`
        : "";

      // Build finalization prompt
      const finalizationPrompt = `Sezení s částí "${partName}" (terapeutka: ${therapistName}) právě skončilo. 

CELÝ PRŮBĚH SEZENÍ:
${messages.map(m => `${m.role === "user" ? "TERAPEUT" : "KAREL"}: ${m.content}`).join("\n")}

${audioAnalyses.length > 0 ? `AUDIO ANALÝZY ZE SEZENÍ:\n${audioAnalyses.join("\n---\n")}` : ""}${interrogationBlock}

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

    // ── PRAVDIVÝ STAV PLÁNU: finální analýza dokončena → done ──
    // Po analyzed větvi (handleEndSession → finishAfterReflection) musí být plán
    // v Pracovně viditelný jako uzavřený, ne dál jako `in_progress`.
    if (planId) {
      try {
        await (supabase as any)
          .from("did_daily_session_plans")
          .update({
            status: "done",
            completed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", planId);
      } catch (planErr) {
        console.warn("Failed to update plan status to done:", planErr);
      }
    }

    // ── SPIŽÍRNA HANDOFF (THERAPIST-LED TRUTH PASS, 2026-04-22) ──
    // Po Karlově finální analýze založíme balík do `did_pantry_packages`,
    // který v noci (~04:15 Prague) `karel-pantry-flush-to-drive` převezme
    // a zařadí do Drive queue. Status `pending_drive` je triggerem pro flush.
    if (savedSessionId && (report || "").trim().length > 0) {
      try {
        const todayKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague" }).format(new Date());
        const driveTargetPath = `06_INTERVENCE/${todayKey}_${partName}_analyza`;

        // ── INTERROGATION Q&A (THERAPIST-LED TRUTH PASS, C2) ──
        // Karlovo cílené doptávání + odpovědi terapeutky musí být součástí
        // balíku ve Spižírně, jinak se ztratí v noční flush rotaci.
        let interrogationBlock = "";
        if (interrogationPayload?.qa?.length) {
          const qaLines = interrogationPayload.qa
            .map((q, i) => {
              const attachLabels = (q.attachments ?? []).map(a => `[${a.kind}: ${a.label}]`).join(" ");
              return `**${i + 1}. ${q.question}**\n${q.answer || "(bez odpovědi)"}${attachLabels ? `\n_Přílohy:_ ${attachLabels}` : ""}`;
            })
            .join("\n\n");
          interrogationBlock = `\n\n## KARLOVO POST-SESSION DOPTÁVÁNÍ\n\n${qaLines}`;
          if (interrogationPayload.extraNote?.trim()) {
            interrogationBlock += `\n\n**Doplněk terapeutky:** ${interrogationPayload.extraNote.trim()}`;
          }
        }

        const fullContent = `# Analýza sezení s ${partName}
**Datum:** ${todayKey}
**Terapeutka:** ${therapistName}
**Session ID:** ${savedSessionId}
${planId ? `**Plán ID:** ${planId}` : ""}

---

${report}${interrogationBlock}${reflectionText}`;

        await (supabase as any).from("did_pantry_packages").insert({
          source_id: savedSessionId,
          source_table: "did_part_sessions",
          package_type: "session_analysis",
          status: "pending_drive",
          content_md: fullContent,
          drive_target_path: driveTargetPath,
          metadata: {
            part_name: partName,
            therapist: therapistName,
            plan_id: planId ?? null,
            therapist_addendum: reflectionText.length > 0,
            interrogation_qa_count: interrogationPayload?.qa?.length ?? 0,
            generated_at: new Date().toISOString(),
          },
        });
        console.log("[Spižírna] session_analysis package queued for nightly Drive flush");
      } catch (pantryErr) {
        console.error("Failed to enqueue pantry package:", pantryErr);
      }
    }

    // Set completed state + reset all session states
    setCompletedReport(report || "Zápis nebyl vygenerován.");
    setMessages([]);
    setInput("");
    setSwitchLog([]);
    setActivePart(partName);
    audioSegmentCountRef.current = 0;
    imageSegmentCountRef.current = 0;
    setCompletionMode("analyzed");
    setSessionCompleted(true);
  };

  // ── Post-session interrogation room ──
  // Otevírá se po kliknutí na "Ukončit a analyzovat". Vede cílené doptávání před finální analýzou.
  if (showInterrogation && !sessionCompleted) {
    return (
      <DidPostSessionInterrogation
        partName={partName}
        therapistName={therapistName}
        contextBrief={contextBrief}
        liveMessages={messages}
        switchLog={switchLog}
        audioSegmentCount={audioSegmentCountRef.current}
        imageSegmentCount={imageSegmentCountRef.current}
        isSubmitting={isFinishing}
        onCancel={() => setShowInterrogation(false)}
        onSubmit={(qa, extraNote) => {
          setInterrogationPayload({ qa, extraNote });
          setShowInterrogation(false);
          // Spustit finální analýzu s Q&A obohacením
          handleEndSession(qa, extraNote);
        }}
      />
    );
  }

  // ── Session completed screen ──
  if (sessionCompleted) {
    const handleNewSession = () => {
      setSessionCompleted(false);
      setCompletedReport("");
      setCompletionMode("analyzed");
      // messages are already [], auto-greet will fire
    };
    const isLight = completionMode === "light";
    const headline = isLight ? "Sezení ukončeno" : "Sezení ukončeno a analyzováno";
    const subline = isLight
      ? <>Sezení s <span className="font-medium">{partName}</span> ({therapistName}) bylo ukončeno. Surový přepis je uložen — připraveno pro následný analytický krok.</>
      : <>Sezení s <span className="font-medium">{partName}</span> ({therapistName}) bylo úspěšně zpracováno a uloženo.</>;
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="bg-card rounded-xl border border-border p-8 space-y-4 text-center max-w-md w-full">
          <CheckCircle className={`w-14 h-14 mx-auto ${isLight ? "text-amber-500" : "text-primary"}`} />
          <h3 className="text-lg font-semibold text-foreground">{headline}</h3>
          <p className="text-sm text-muted-foreground">{subline}</p>
          {isLight && (
            <div className="text-xs text-muted-foreground rounded-md border border-border/60 bg-muted/30 p-3 text-left space-y-1">
              <div>✓ Přepis uložen do <span className="font-mono">did_part_sessions</span></div>
              <div>✓ Žádná Karlova analýza dosud neproběhla</div>
              <div>↪ Připraveno pro následnou analýzu</div>
            </div>
          )}
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

  // ── BLOCK WORKSPACE — celá obrazovka pro JEDEN bod programu ──
  // Hana viděla jenom generický chat a nevěděla, kam psát ani jaké jsou
  // instrukce k bodu. Tady dostává VŠE k jednomu bodu na jednom místě:
  // Karlův brief (pomůcky, instrukce, co sledovat) + krokový chat Karel↔Hana
  // + per-bod přílohy (foto/audio).
  if (activeBlockWorkspace && !sessionCompleted) {
    const block = activeBlockWorkspace;
    const moveToNextBlock = () => {
      try {
        const key = `live_program_${planId ?? "ad-hoc"}`;
        const raw = window.localStorage.getItem(key);
        if (!raw) {
          setActiveBlockWorkspace(null);
          setActiveBlock(null);
          return;
        }
        const arr = JSON.parse(raw) as Array<{ text?: string }>;
        const nextIndex = block.index + 1;
        if (Array.isArray(arr) && arr[nextIndex]) {
          const nextText = typeof arr[nextIndex].text === "string" ? arr[nextIndex].text : `Bod #${nextIndex + 1}`;
          const sepIdx = nextText.indexOf(" — ");
          const nextBlock = sepIdx > 0
            ? { index: nextIndex, text: nextText.slice(0, sepIdx).trim(), detail: nextText.slice(sepIdx + 3).trim() }
            : { index: nextIndex, text: nextText };
          setActiveBlock(nextBlock);
          setActiveBlockWorkspace(nextBlock);
          return;
        }
      } catch (e) {
        console.warn("next block navigation failed:", e);
      }
      setActiveBlockWorkspace(null);
      setActiveBlock(null);
    };

    return (
      <div className="h-full w-full flex flex-col min-h-0 overflow-hidden bg-background">
        {/* Sticky header bodu */}
        <div className="shrink-0 px-4 py-3 border-b border-border bg-card/50">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setActiveBlockWorkspace(null);
                setActiveBlock(null);
              }}
              className="h-8 gap-1.5 text-xs shrink-0"
            >
              <ArrowLeft className="w-4 h-4" />
              Zpět na plán
            </Button>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant="outline" className="text-[10px] h-5 border-primary/40 text-primary">
                  Bod #{block.index + 1}
                </Badge>
                <Badge className="text-[9px] gap-1 h-4 bg-destructive/15 text-destructive border border-destructive/30">
                  <span className="w-1.5 h-1.5 rounded-full bg-destructive animate-pulse" />
                  LIVE
                </Badge>
                <span className="text-[11px] text-muted-foreground">
                  Část: <span className="font-medium text-foreground">{partName}</span>
                  {" · vede "}<span className="font-medium text-foreground">{therapistName}</span>
                </span>
              </div>
              <h3 className="text-sm font-semibold text-foreground mt-0.5 leading-snug">
                {block.text}
              </h3>
              {block.detail && (
                <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug">
                  {block.detail}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Scrollovatelný střed = celý pracovní prostor bodu */}
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
          <div className="max-w-3xl mx-auto px-3 sm:px-4 py-4 pb-24">
            <BlockDiagnosticChat
              key={`${planId ?? "ad-hoc"}-${block.index}-${planRefreshTick}`}
              blockIndex={block.index}
              blockText={block.text}
              blockDetail={block.detail}
              partName={partName}
              therapistName={therapistName}
              storageKey={`live_program_${planId ?? "ad-hoc"}`}
              sessionId={planId}
              research={researchByIdx[block.index] ?? null}
              isResearchLoading={!!researchLoadingIdx[block.index]}
              onLoadResearch={() => loadBlockResearch(block.index, block.text, block.detail, "deep")}
              showBrief={false}
              onMarkDone={() => {
                // Označit bod jako hotový v checklistu (LS) a zavřít workspace
                try {
                  const key = `live_program_${planId ?? "ad-hoc"}`;
                  const raw = window.localStorage.getItem(key);
                  if (raw) {
                    const arr = JSON.parse(raw) as Array<{ done: boolean }>;
                    if (Array.isArray(arr) && arr[block.index]) {
                      arr[block.index].done = true;
                      window.localStorage.setItem(key, JSON.stringify(arr));
                    }
                  }
                } catch (e) {
                  console.warn("mark block done failed:", e);
                }
                toast.success(`Bod #${block.index + 1} hotový.`);
                setPlanRefreshTick((v) => v + 1);
                setActiveBlockWorkspace(null);
                setActiveBlock(null);
              }}
              onAdvanceToNext={moveToNextBlock}
              onRequestArtefact={(kind) => {
                if (kind === "audio") {
                  toast.info(`Bod #${block.index + 1}: spouštím nahrávání…`);
                  recorder.startRecording();
                } else {
                  toast.info(`Bod #${block.index + 1}: vyber fotku.`);
                  imageUpload.openFilePicker();
                }
              }}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full flex flex-col min-h-0 overflow-hidden bg-background">
      {/* Header — shrink-0; vlastní vnitřní scroll, aby nikdy nevytlačil input mimo viewport */}
      <div className={`shrink-0 px-4 py-3 border-b border-border bg-card/50 transition-colors duration-500 max-h-[45vh] overflow-y-auto ${switchFlash ? "bg-amber-500/10" : ""}`}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <Button variant="ghost" size="icon" onClick={onBack} className="h-8 w-8 shrink-0">
              <ArrowLeft className="w-4 h-4" />
            </Button>
            <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 transition-colors duration-500 ${switchFlash ? "bg-amber-500/20" : "bg-primary/10"}`}>
              <span className="text-sm">🧩</span>
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-sm font-semibold text-foreground">Live DID sezení</h3>
                <Badge className="text-[9px] gap-1 h-4 bg-destructive/15 text-destructive border border-destructive/30">
                  <span className="w-1.5 h-1.5 rounded-full bg-destructive animate-pulse" />
                  LIVE
                </Badge>
                <Badge variant="outline" className="text-[9px] h-4 border-primary/30 text-primary">
                  připraveno · podepsáno týmem
                </Badge>
                {switchLog.length > 0 && (
                  <Badge variant="outline" className="text-[9px] gap-0.5 h-4 border-amber-500/40 text-amber-700 dark:text-amber-400">
                    <Shuffle className="w-2.5 h-2.5" />
                    {switchLog.length}× switch
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground truncate">
                Část: <span className={`font-medium ${switchFlash ? "text-amber-600 dark:text-amber-400" : "text-foreground"}`}>{activePart}</span>
                {activePart !== partName && <span className="text-muted-foreground/60"> (start: {partName})</span>}
                {" · vede "}<span className="font-medium text-foreground">{therapistName}</span>
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="outline"
              size="sm"
              onClick={() => requestCloseFlow("light_close")}
              disabled={isFinishing || isClosingLight || messages.length < 2}
              className="gap-1.5 text-xs h-9"
            >
              <DoorClosed className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Ukončit sezení</span>
              <span className="sm:hidden">Ukončit</span>
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => requestCloseFlow("analyze")}
              disabled={isFinishing || isClosingLight || messages.length < 2}
              className="gap-1.5 text-xs h-9"
            >
              {isFinishing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <StopCircle className="w-3.5 h-3.5" />}
              <span className="hidden md:inline">Ukončit a analyzovat</span>
              <span className="md:hidden">Analyzovat</span>
            </Button>
          </div>
        </div>

        {/* ── Schválený plán (z přípravné porady) ── */}
        {contextBrief && (
          <div className="mt-3 rounded-md border border-primary/25 bg-primary/5">
            <button
              type="button"
              onClick={() => setPlanExpanded(v => !v)}
              className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left"
            >
              <div className="flex items-center gap-2 min-w-0">
                <FileText className="w-3.5 h-3.5 text-primary shrink-0" />
                <span className="text-xs font-medium text-foreground">Schválený plán sezení</span>
                <Badge variant="outline" className="text-[9px] h-4 border-primary/30 text-primary">
                  z přípravné porady
                </Badge>
              </div>
              {planExpanded ? (
                <ChevronUp className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              ) : (
                <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              )}
            </button>
            {planExpanded && (
              <div className="px-3 pb-3 pt-0 max-h-64 overflow-y-auto border-t border-primary/15">
                <LiveProgramChecklist
                  key={`${planId ?? "ad-hoc"}-${planRefreshTick}`}
                  planMarkdown={contextBrief}
                  storageKey={`live_program_${planId ?? "ad-hoc"}`}
                  partName={partName}
                  therapistName={therapistName}
                  sessionId={planId}
                  onItemToggle={(it) =>
                    pushHintTrigger(
                      `Bod programu ${it.done ? "označen jako HOTOVÝ" : "vrácen do běhu"}: „${it.text.slice(0, 200)}"`,
                      "note",
                    )
                  }
                  onObservationSubmit={(it) =>
                    pushHintTrigger(
                      `Pozorování k bodu „${it.text.slice(0, 120)}":\n${it.observation.slice(0, 600)}`,
                      "note",
                    )
                  }
                  onActivateBlock={(block) => {
                    void loadBlockResearch(block.index, block.text, block.detail, "deep");
                    // ── Spustit bod = otevři dedikovaný pracovní prostor bodu ──
                    setActiveBlock(block);
                    setActiveBlockWorkspace(block);
                  }}
                  onRequestArtefact={(block, kind) => {
                    setActiveBlock(block);
                    if (kind === "audio") {
                      toast.info(`Bod #${block.index + 1}: spouštím nahrávání…`);
                      recorder.startRecording();
                    } else {
                      toast.info(`Bod #${block.index + 1}: vyber fotku.`);
                      imageUpload.openFilePicker();
                    }
                  }}
                />
              </div>
            )}
          </div>
        )}

        {/* Audio & Image & Note tools strip */}
        <div className="mt-3 flex items-center gap-2 flex-wrap">
          {/* Note button */}
          <Button variant="outline" size="sm" onClick={() => setNoteDialogOpen(true)} className="gap-1.5 h-8 text-xs">
            <StickyNote className="w-3.5 h-3.5" /> Poznámka
          </Button>
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

      {/* Messages — explicitní min-h chrání před zkolabováním pod kartami */}
      <ScrollArea className="flex-1 min-h-0 px-2 sm:px-4" ref={scrollRef}>
        <div className="max-w-3xl mx-auto py-4 space-y-3">
          {messages.length === 0 && (
            <div className="rounded-md border border-dashed border-primary/30 bg-primary/5 px-4 py-6 text-center space-y-2">
              <Sparkles className="w-5 h-5 text-primary mx-auto" />
              <p className="text-xs text-foreground font-medium">
                Nahoře vidíš schválený plán bod po bodu.
              </p>
              <p className="text-[11px] text-muted-foreground leading-snug">
                U každého bodu klikni <span className="font-semibold text-primary">🎯 Spustit bod</span> a otevře se pracovní prostor toho bodu — Karlův návod, pomůcky, instrukce, přílohy a chat krok po kroku.
                <br />
                Tady dole zůstává hlavní tok pro volné poznámky mimo konkrétní bod.
              </p>
            </div>
          )}
          {messages.map((msg, i) => (
            <div key={i} className="space-y-1">
              <ChatMessage message={msg} />
              {/* ── Meta-řádek pod uživatelskou zprávou: přijato / chyba / bod ── */}
              {msg.role === "user" && (msg.acceptedAt || msg.failed || msg.attachedBlockIndex !== undefined) && (
                <div className="flex flex-wrap items-center gap-1.5 pl-2 text-[10px]">
                  {msg.attachedBlockIndex !== undefined && (
                    <Badge variant="outline" className="h-4 text-[9px] gap-0.5 border-primary/30 text-primary">
                      <Link2 className="w-2.5 h-2.5" />
                      bod #{msg.attachedBlockIndex + 1}
                    </Badge>
                  )}
                  {msg.acceptedAt && !msg.failed && (
                    <span className="text-emerald-700 dark:text-emerald-400 font-medium">
                      ✓ Karel přijal · uloženo {msg.acceptedAt}
                    </span>
                  )}
                  {msg.failed && (
                    <>
                      <span className="text-destructive font-medium flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3" />
                        Karel neodpověděl{msg.errorMsg ? ` (${msg.errorMsg})` : ""}
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-5 px-1.5 text-[10px] gap-1 border-destructive/40 text-destructive hover:bg-destructive/10"
                        onClick={() => msg.ts && retryUserMessage(msg.ts)}
                        disabled={isLoading}
                      >
                        <RefreshCw className="w-2.5 h-2.5" />
                        Zkusit znovu
                      </Button>
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
          {isLoading && messages[messages.length - 1]?.role === "user" && (
            <div className="flex justify-start">
              <div className="chat-message-assistant">
                <Loader2 className="w-4 h-4 animate-spin text-primary" />
              </div>
            </div>
          )}
          {/* Karlovy in-session karty — uvnitř scroll oblasti, aby NIKDY nemohly vytlačit input mimo viewport. */}
          {hintTriggers.length > 0 && (
            <div className="rounded-md border border-border/60 bg-card/40 backdrop-blur-sm px-2.5 py-2">
              <KarelInSessionCards
                partName={activePart}
                therapistName={therapistName}
                triggers={hintTriggers}
                onAnswerHint={(text) => {
                  setInput((prev) => (prev ? `${prev}\n\n${text}` : text));
                  textareaRef.current?.focus();
                }}
                onCompleteBlock={(blockIndex) => {
                  try {
                    const key = `live_program_${planId ?? "ad-hoc"}`;
                    const raw = window.localStorage.getItem(key);
                    if (raw) {
                      const arr = JSON.parse(raw) as Array<{ done: boolean }>;
                      if (Array.isArray(arr) && arr[blockIndex]) {
                        arr[blockIndex].done = true;
                        window.localStorage.setItem(key, JSON.stringify(arr));
                        setPlanExpanded(false);
                        setTimeout(() => setPlanExpanded(true), 80);
                      }
                    }
                    toast.success(`Bod #${blockIndex + 1} hotový.`);
                    setActiveBlock(null);
                  } catch (e) {
                    console.warn("complete block failed:", e);
                  }
                }}
              />
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Input — sticky shrink-0 dno panelu, vzdy viditelne bez ohledu na obsah nahore */}
      <div className="shrink-0 border-t border-border bg-card/50 backdrop-blur-sm">
        <div className="max-w-3xl mx-auto px-3 sm:px-4 py-3 space-y-2">
          {/* ── Orientační lišta: kam vlastně píšu + výběr bodu programu ── */}
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant="outline"
              className="text-[10px] h-5 gap-1 border-primary/30 text-primary bg-primary/5"
            >
              <MessageSquare className="w-2.5 h-2.5" />
              Hlavní tok sezení — Karel čte VŠE co napíšeš
            </Badge>
            {programBlocks.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="sm"
                    variant={attachToBlockIdx !== null ? "default" : "outline"}
                    className="h-6 text-[10px] gap-1 px-2"
                    title="Připojit další zprávu jako asociaci k vybranému bodu programu"
                  >
                    <Link2 className="w-3 h-3" />
                    {attachToBlockIdx !== null
                      ? `→ bod #${attachToBlockIdx + 1}`
                      : "Připojit k bodu"}
                    <ChevronDown className="w-3 h-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-w-sm">
                  <DropdownMenuLabel className="text-[10px] text-muted-foreground">
                    Další zpráva se zaloguje jako asociace daného bodu
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-xs"
                    onClick={() => setAttachToBlockIdx(null)}
                  >
                    <span className="text-muted-foreground">Žádný bod (jen do hlavního toku)</span>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {programBlocks.map((b, i) => (
                    <DropdownMenuItem
                      key={i}
                      className="text-xs items-start gap-2"
                      onClick={() => setAttachToBlockIdx(i)}
                    >
                      <Badge variant="outline" className="text-[9px] h-4 mt-0.5">
                        #{i + 1}
                      </Badge>
                      <span className="line-clamp-2">{b}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
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
              placeholder={`Sem zapisuj, co ${partName} říká nebo dělá. Karel okamžitě poradí. (Enter odešle, Shift+Enter = nový řádek)`}
              className="flex-1 min-w-0 min-h-[2.75rem] max-h-[7.5rem] resize-none text-sm"
              disabled={isLoading || isFinishing}
            />
            <Button
              size="icon"
              onClick={sendMessage}
              disabled={!input.trim() || isLoading || isFinishing}
              className="h-[2.75rem] w-[2.75rem] shrink-0"
              title="Odeslat (Enter)"
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

      {/* ── Quick Note Dialog ── */}
      <Dialog open={noteDialogOpen} onOpenChange={setNoteDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base flex items-center gap-2">
              <StickyNote className="w-4 h-4 text-primary" />
              Poznámka ze sezení
            </DialogTitle>
            <DialogDescription className="text-xs">
              Krátká poznámka, postřeh nebo citace — uloží se do toku sezení s časem.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={noteDraft}
            onChange={e => setNoteDraft(e.target.value)}
            placeholder="Co se stalo, co řekla část, neverbální signál…"
            className="min-h-[6rem] text-sm"
            autoFocus
          />
          <DialogFooter className="gap-2">
            <Button variant="ghost" size="sm" onClick={() => { setNoteDialogOpen(false); setNoteDraft(""); }}>
              Zrušit
            </Button>
            <Button size="sm" onClick={handleAddNote} disabled={!noteDraft.trim()}>
              Přidat poznámku
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Lehké ukončení sezení (handoff bez plné analýzy) ── */}
      <Dialog open={handoffDialogOpen} onOpenChange={setHandoffDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base flex items-center gap-2">
              <DoorClosed className="w-4 h-4 text-primary" />
              Ukončit sezení
            </DialogTitle>
            <DialogDescription className="text-xs">
              Uloží surový přepis, audio segmenty i poznámky a sezení označí jako <strong>ukončené, připravené pro následnou analýzu</strong>. Plnou Karelovu analýzu spustíš v dalším kroku zvlášť.
            </DialogDescription>
          </DialogHeader>
          <div className="text-xs text-muted-foreground space-y-1.5 rounded-md border border-border/60 bg-muted/30 p-3">
            <div>• Část: <span className="font-medium text-foreground">{partName}</span></div>
            <div>• Vede: <span className="font-medium text-foreground">{therapistName}</span></div>
            <div>• Záznamů v toku: <span className="font-medium text-foreground">{messages.length}</span></div>
            {switchLog.length > 0 && (
              <div>• Switche: <span className="font-medium text-foreground">{switchLog.length}×</span></div>
            )}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="ghost" size="sm" onClick={() => setHandoffDialogOpen(false)} disabled={isClosingLight}>
              Zpět do sezení
            </Button>
            <Button size="sm" onClick={handleLightClose} disabled={isClosingLight} className="gap-1.5">
              {isClosingLight ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <DoorClosed className="w-3.5 h-3.5" />}
              Ukončit a uložit přepis
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Completion gate (měkká brána) ── */}
      <Dialog open={completionGateOpen} onOpenChange={setCompletionGateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-500" />
              {completionGateAction === "analyze" ? "Před analýzou — chybí podklady" : "Před ukončením — chybí podklady"}
            </DialogTitle>
            <DialogDescription className="text-xs">
              U některých bodů jsi spustila diagnostický chat, ale chybí povinný artefakt (kresba / audio).
              Karel z toho neudělá plnou klinickou analýzu.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 max-h-72 overflow-y-auto">
            {missingArtifactsReport.map((m) => (
              <div
                key={m.blockIndex}
                className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs"
              >
                <p className="font-semibold text-foreground mb-1">
                  Bod #{m.blockIndex + 1}: <span className="font-normal">{m.blockText.slice(0, 90)}</span>
                </p>
                <p className="text-amber-700 dark:text-amber-400">
                  Chybí: {m.missing.map((k) => (k === "image" ? "📷 obrázek/kresba" : "🎙️ audio nahrávka")).join(", ")}
                </p>
              </div>
            ))}
          </div>
          <DialogFooter className="gap-2 flex-wrap">
            <Button variant="ghost" size="sm" onClick={() => setCompletionGateOpen(false)}>
              Zpět doplnit
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                // Měkká brána: pokračuj, doplň chybějící do extra note přes interrogation room.
                setCompletionGateOpen(false);
                if (completionGateAction === "analyze") {
                  // Předáme info o chybějících artefaktech přes setInterrogationPayload jako placeholder note
                  const note = missingArtifactsReport
                    .map((m) => `Bod #${m.blockIndex + 1}: chybí ${m.missing.join(", ")}`)
                    .join("; ");
                  setInterrogationPayload({ qa: [], extraNote: `[CHYBĚJÍCÍ ARTEFAKTY] ${note}` });
                  setShowInterrogation(true);
                } else {
                  setHandoffDialogOpen(true);
                }
              }}
            >
              Pokračovat přesto
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default DidLiveSessionPanel;

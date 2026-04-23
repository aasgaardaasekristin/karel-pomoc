import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { Loader2, Send, Mic, Camera, CheckCircle2, Sparkles, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
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
  const logRef = useRef<HTMLDivElement>(null);
  const autoStartedRef = useRef(false);

  useEffect(() => {
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
  }, [artKey, blockIndex, blockSignature, metaKey, turnsKey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try { window.localStorage.setItem(turnsKey, JSON.stringify(turns)); } catch {}
    onTurnsChange?.(turns);
  }, [turns, turnsKey, onTurnsChange]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try { window.localStorage.setItem(artKey, JSON.stringify(artifacts)); } catch {}
    onArtifactsChange?.(artifacts);
  }, [artifacts, artKey, onArtifactsChange]);

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
        if ((data as any)?.error) throw new Error(String((data as any).error));
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

  // Auto-start setup briefing jakmile je k dispozici research
  useEffect(() => {
    if (autoStartedRef.current) return;
    if (turns.length > 0) { autoStartedRef.current = true; return; }
    if (!effectiveResearch || effectiveResearchLoading) return;
    autoStartedRef.current = true;
    void callFollowup("start", []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveResearch, effectiveResearchLoading]);

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

  const addArtifactPlaceholder = (kind: "image" | "audio") => {
    // přidáme placeholder do turns (Hana později uploaduje skutečný soubor přes nadřazený panel)
    const label = kind === "image" ? "📷 Foto/kresba k tomuto bodu" : "🎙️ Audio k tomuto bodu";
    const turn: DiagTurn = {
      from: "hana",
      text: `${label} (přiloženo)`,
      ts: new Date().toISOString(),
      attachment: { kind, label },
    };
    setTurns((prev) => [...prev, turn]);
    setArtifacts((prev) => [...prev, { kind, label, ts: new Date().toISOString() }]);
    onRequestArtefact?.(kind);
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

      {/* ── Tlačítka per-bod artefakty ── */}
      <div className="flex items-center gap-1.5 flex-wrap border-t border-border/40 pt-2">
        <Button
          size="sm"
          variant="outline"
          className="h-6 text-[10px] gap-1"
          onClick={() => addArtifactPlaceholder("audio")}
          title="Nahrát/přiložit audio k tomuto bodu"
        >
          <Mic className="w-3 h-3" /> + audio
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-6 text-[10px] gap-1"
          onClick={() => addArtifactPlaceholder("image")}
          title="Vyfotit/přiložit obrázek (kresbu) k tomuto bodu"
        >
          <Camera className="w-3 h-3" /> + foto
        </Button>
        {artifacts.length > 0 && (
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

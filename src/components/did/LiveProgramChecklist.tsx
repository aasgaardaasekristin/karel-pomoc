import { useMemo, useState, useEffect, useCallback, useRef } from "react";
import { CheckCircle2, Circle, ChevronDown, ChevronRight, ListChecks, Sparkles, Mic, Camera, FlagOff, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import BlockDiagnosticChat, { type BlockResearch, type DiagTurn, type BlockArtifact } from "./BlockDiagnosticChat";
import { parseProgramBullets } from "@/lib/liveProgramParser";

/**
 * LiveProgramChecklist
 * --------------------
 * THERAPIST-LED LIVE PASS (2026-04-23) — Krok 5, levý panel.
 *
 * Vezme schválený program (z `plan_markdown` / `program_draft`) a ukáže
 * ho jako interaktivní checklist bod-po-bodu. Pro každý bod:
 *   - 🎯 „Spustit bod"  — Karel vyrobí KONKRÉTNÍ obsah (slova/otázky/instrukci)
 *   - 🎙️ / 📷 / 📤      — per-bod audio / foto / odeslat artefakt k analýze
 *   - checkbox „bod hotov" + textarea pozorování
 *
 * Stav je per `planId` perzistován do localStorage.
 */

export type ProgramItem = {
  id: string;
  text: string;
  done: boolean;
  observation: string;
};

export type ProgramBlockRef = {
  index: number;       // 0-based
  text: string;        // celý text bodu
  detail?: string;     // případný odsazený detail
};

interface Props {
  planMarkdown: string;
  storageKey: string;
  partName?: string;
  therapistName?: string;
  sessionId?: string;
  onItemToggle?: (item: ProgramItem) => void;
  onObservationSubmit?: (item: ProgramItem) => void;
  onActivateBlock?: (block: ProgramBlockRef) => void;
  onRequestArtefact?: (block: ProgramBlockRef, kind: "audio" | "image") => void;
  onBlockTurnsChange?: (blockIndex: number, turns: DiagTurn[]) => void;
  onBlockArtifactsChange?: (blockIndex: number, artifacts: BlockArtifact[]) => void;
}

function parseProgramBullets(md: string): string[] {
  if (!md) return [];

  const lines = md.split(/\r?\n/);
  const bullets: string[] = [];
  let inProgramSection = false;
  let bulletBlockStarted = false;

  const sectionRe = /^#{1,6}\s+program\s+sezení\s*$/i;
  const bulletRe = /^\s*(?:[-*•]|\d+[.)])\s+(.+)$/;

  for (const raw of lines) {
    const line = raw.replace(/\u00A0/g, " ").trimEnd();

    if (sectionRe.test(line)) {
      inProgramSection = true;
      bulletBlockStarted = false;
      continue;
    }

    if (inProgramSection && /^#{1,6}\s+/.test(line) && !sectionRe.test(line)) {
      break;
    }

    if (!inProgramSection) continue;

    const m = bulletRe.exec(line);
    if (m) {
      const text = m[1]
        .replace(/\*\*/g, "")
        .replace(/__/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (text.length >= 6) {
        bullets.push(text);
        bulletBlockStarted = true;
      }
      continue;
    }

    if (bullets.length > 0 && /^\s{2,}\S/.test(raw)) {
      bullets[bullets.length - 1] = `${bullets[bullets.length - 1]} — ${line.trim()}`;
      continue;
    }

    if (line === "") {
      if (bulletBlockStarted) break;
      continue;
    }

    if (bulletBlockStarted) break;
  }

  return bullets.slice(0, 12);
}

const LiveProgramChecklist = ({
  planMarkdown,
  storageKey,
  partName = "Tundrupek",
  therapistName = "Hanka",
  sessionId,
  onItemToggle,
  onObservationSubmit,
  onActivateBlock,
  onRequestArtefact,
  onBlockTurnsChange,
  onBlockArtifactsChange,
}: Props) => {
  const parsed = useMemo(() => parseProgramBullets(planMarkdown), [planMarkdown]);
  // ── STABLE signature ──
  // Dříve: JSON.stringify(parsed) → drobná změna markdownu (re-fetch, whitespace,
  // emoji v plánu) měnila podpis a Hany ZTRATILA splněné body. Nově použijeme
  // jen počet bodů + prvních 40 znaků každého bodu (lower-cased, bez interpunkce).
  // To přežije drobné re-fetch artefakty, ale zachytí změnu programu.
  const planSignature = useMemo(
    () =>
      JSON.stringify(
        parsed.map(t =>
          t
            .toLowerCase()
            .replace(/[^a-zá-ž0-9 ]/gi, "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 40),
        ),
      ),
    [parsed],
  );
  const metaKey = `${storageKey}::meta`;

  const initialItems: ProgramItem[] = useMemo(() => {
    if (parsed.length === 0) {
      return [
        {
          id: "fallback-0",
          text: "Bezformátový program — sleduj plán v chatu",
          done: false,
          observation: "",
        },
      ];
    }
    return parsed.map((text, i) => ({
      id: `bod-${i + 1}`,
      text,
      done: false,
      observation: "",
    }));
  }, [parsed]);

  const [items, setItems] = useState<ProgramItem[]>(() => {
    if (typeof window === "undefined") return initialItems;
    try {
      const storedSignature = window.localStorage.getItem(metaKey);
      const saved = window.localStorage.getItem(storageKey);
      if (saved && storedSignature === planSignature) {
        const parsedSaved = JSON.parse(saved) as ProgramItem[];
        if (Array.isArray(parsedSaved) && parsedSaved.length === initialItems.length) {
          return initialItems.map((it, i) => ({
            ...it,
            done: !!parsedSaved[i]?.done,
            observation: parsedSaved[i]?.observation ?? "",
          }));
        }
      }
    } catch {
      // ignore
    }
    return initialItems;
  });

  useEffect(() => {
    if (typeof window === "undefined") {
      setItems(initialItems);
      return;
    }

    try {
      const storedSignature = window.localStorage.getItem(metaKey);
      const saved = window.localStorage.getItem(storageKey);
      if (saved && storedSignature === planSignature) {
        const parsedSaved = JSON.parse(saved) as ProgramItem[];
        if (Array.isArray(parsedSaved) && parsedSaved.length === initialItems.length) {
          setItems(initialItems.map((it, i) => ({
            ...it,
            done: !!parsedSaved[i]?.done,
            observation: parsedSaved[i]?.observation ?? "",
          })));
          return;
        }
      }
    } catch {
      // ignore
    }

    setItems(initialItems);
  }, [initialItems, metaKey, planSignature, storageKey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(metaKey, planSignature);
      window.localStorage.setItem(storageKey, JSON.stringify(items));
    } catch {
      // quota — ignore
    }
  }, [items, metaKey, planSignature, storageKey]);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [researchByIdx, setResearchByIdx] = useState<Record<number, BlockResearch | null>>({});
  const [researchLoadingIdx, setResearchLoadingIdx] = useState<Record<number, boolean>>({});
  const turnsByBlockRef = useRef<Record<number, DiagTurn[]>>({});
  const artifactsByBlockRef = useRef<Record<number, BlockArtifact[]>>({});
  const syncTimerRef = useRef<number | null>(null);

  const persistProgress = useCallback(async (snapshotItems: ProgramItem[], finalizedReason?: "completed" | "partial") => {
    if (!sessionId) return;
    const { data: authData } = await supabase.auth.getUser();
    const userId = authData.user?.id;
    if (!userId) return;

    const completed = snapshotItems.filter(it => it.done).length;
    const now = new Date().toISOString();
    const { error } = await (supabase as any)
      .from("did_live_session_progress")
      .upsert({
        user_id: userId,
        plan_id: sessionId,
        part_name: partName,
        therapist: therapistName,
        items: snapshotItems,
        turns_by_block: turnsByBlockRef.current,
        artifacts_by_block: artifactsByBlockRef.current,
        completed_blocks: completed,
        total_blocks: snapshotItems.length,
        last_activity_at: now,
        finalized_at: finalizedReason ? now : null,
        finalized_reason: finalizedReason ?? null,
      }, { onConflict: "plan_id" });

    if (error) {
      console.warn("[LiveProgramChecklist] progress sync failed", error);
    }
  }, [partName, sessionId, therapistName]);

  const queueProgressSync = useCallback((snapshotItems: ProgramItem[]) => {
    if (!sessionId || typeof window === "undefined") return;
    if (syncTimerRef.current) window.clearTimeout(syncTimerRef.current);
    syncTimerRef.current = window.setTimeout(() => {
      void persistProgress(snapshotItems);
    }, 700);
  }, [persistProgress, sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    void (async () => {
      const { data, error } = await (supabase as any)
        .from("did_live_session_progress")
        .select("items, turns_by_block, artifacts_by_block")
        .eq("plan_id", sessionId)
        .maybeSingle();
      if (cancelled || error || !data) return;

      if (data.turns_by_block && typeof data.turns_by_block === "object") {
        turnsByBlockRef.current = data.turns_by_block;
        Object.entries(data.turns_by_block as Record<string, DiagTurn[]>).forEach(([idx, turns]) => {
          try { window.localStorage.setItem(`${storageKey}::turns::${idx}`, JSON.stringify(turns)); } catch {}
        });
      }
      if (data.artifacts_by_block && typeof data.artifacts_by_block === "object") {
        artifactsByBlockRef.current = data.artifacts_by_block;
      }
      if (Array.isArray(data.items) && data.items.length === initialItems.length) {
        setItems(initialItems.map((it, i) => ({
          ...it,
          done: !!data.items[i]?.done,
          observation: data.items[i]?.observation ?? "",
        })));
      }
    })();
    return () => { cancelled = true; };
  }, [initialItems, sessionId, storageKey]);

  useEffect(() => {
    queueProgressSync(items);
    return () => {
      if (syncTimerRef.current && typeof window !== "undefined") window.clearTimeout(syncTimerRef.current);
    };
  }, [items, queueProgressSync]);

  const loadResearch = useCallback(
    async (idx: number, blockText: string, blockDetail: string | undefined, depth: "light" | "deep" = "light") => {
      if (researchByIdx[idx] !== undefined || researchLoadingIdx[idx]) return;
      setResearchLoadingIdx(m => ({ ...m, [idx]: true }));
      try {
        const { data, error } = await (supabase as any).functions.invoke("karel-block-research", {
          body: {
            part_name: partName,
            program_block: { index: idx, text: blockText, detail: blockDetail },
            depth,
          },
        });
        if (error) throw error;
        setResearchByIdx(m => ({ ...m, [idx]: data as BlockResearch }));
      } catch (e) {
        console.warn("[LiveProgramChecklist] research failed", e);
        setResearchByIdx(m => ({ ...m, [idx]: null }));
      } finally {
        setResearchLoadingIdx(m => ({ ...m, [idx]: false }));
      }
    },
    [researchByIdx, researchLoadingIdx, partName],
  );

  const setDoneState = (id: string, done: boolean) => {
    setItems(prev => {
      const next = prev.map(it => (it.id === id ? { ...it, done } : it));
      const changed = next.find(it => it.id === id);
      if (changed && onItemToggle) onItemToggle(changed);
      queueProgressSync(next);
      return next;
    });
  };

  const appendObservationFromTurns = (id: string, turns: DiagTurn[]) => {
    const formatted = turns
      .map(t => `${t.from === "karel" ? "K" : "H"}: ${t.text}`)
      .join("\n");
    setItems(prev => {
      const next = prev.map(it =>
        it.id === id ? { ...it, observation: formatted } : it,
      );
      const updated = next.find(it => it.id === id);
      if (updated && onObservationSubmit) onObservationSubmit(updated);
      return next;
    });
  };

  const buildBlockRef = (item: ProgramItem, idx: number): ProgramBlockRef => {
    // pokud má text " — " separátor (přidaný parserem), oddělíme detail
    const sepIdx = item.text.indexOf(" — ");
    if (sepIdx > 0) {
      return {
        index: idx,
        text: item.text.slice(0, sepIdx).trim(),
        detail: item.text.slice(sepIdx + 3).trim(),
      };
    }
    return { index: idx, text: item.text };
  };

  const doneCount = items.filter(it => it.done).length;

  // ── Ukončit a vyhodnotit (volá karel-did-session-evaluate) ──
  // sessionId je v tomto kontextu rovno planId (did_daily_session_plans.id) —
  // viz DidLiveSessionPanel, který předává `sessionId={planId}`.
  const [finalizing, setFinalizing] = useState(false);
  const [finalized, setFinalized] = useState(false);
  const [jobStatus, setJobStatus] = useState<"idle" | "pending" | "running" | "failed_retry" | "completed">("idle");

  const handleEndAndEvaluate = useCallback(async () => {
    if (finalizing || finalized) return;
    if (!sessionId) {
      toast.error("Chybí ID plánu — nelze vyhodnotit (zřejmě ad-hoc sezení).");
      return;
    }
    const incomplete = doneCount < items.length;
    if (incomplete) {
      const ok = window.confirm(
        `Ještě není označeno ${items.length - doneCount} z ${items.length} bodů. Opravdu sezení ukončit a vyhodnotit částečně?`,
      );
      if (!ok) return;
    }

    setFinalizing(true);
    try {
      // Sběr per-block turnů a pozorování (turny ukládá BlockDiagnosticChat do localStorage).
      const turnsByBlock: Record<number, Array<{ from: "karel" | "hana"; text: string }>> = {};
      const observationsByBlock: Record<number, string> = {};
      items.forEach((it, idx) => {
        const turnsKey = `${storageKey}::turns::${idx}`;
        try {
          const raw = typeof window !== "undefined" ? window.localStorage.getItem(turnsKey) : null;
          if (raw) {
            const parsed = JSON.parse(raw) as DiagTurn[];
            if (Array.isArray(parsed) && parsed.length > 0) {
              turnsByBlock[idx] = parsed.map(t => ({ from: t.from, text: t.text }));
            }
          }
        } catch { /* ignore */ }
        if (it.observation && it.observation.trim().length > 0) {
          observationsByBlock[idx] = it.observation;
        }
      });
      await persistProgress(items, incomplete ? "partial" : "completed");

      const { data, error } = await supabase.functions.invoke("karel-did-session-evaluate", {
        body: {
          planId: sessionId,
          completedBlocks: doneCount,
          totalBlocks: items.length,
          endedReason: incomplete ? "partial" : "completed",
          turnsByBlock,
          observationsByBlock,
          enqueueOnly: true,
        },
      });
      if (error) throw error;
      if ((data as any)?.ok === false) throw new Error((data as any)?.error || "Vyhodnocení selhalo.");
      setJobStatus("pending");
      toast.success("Sezení je bezpečně uložené a zařazené ke zpracování. Karel ho označí hotové až po analýze.");

      const { data: workerData, error: workerError } = await supabase.functions.invoke("karel-did-session-evaluate", {
        body: { processPendingJobs: true, limit: 1 },
      });
      if (workerError) throw workerError;
      const result = (workerData as any)?.results?.[0];
      if (result?.ok === true && ["analyzed", "evidence_limited"].includes(String(result?.review_status))) {
        setJobStatus("completed");
        setFinalized(true);
        toast.success(incomplete ? "Sezení částečně vyhodnoceno." : "Sezení vyhodnoceno.");
      } else {
        setJobStatus("failed_retry");
        toast.warning("Vyhodnocení je ve frontě pro opakování; data nejsou ztracená.");
      }
    } catch (e: any) {
      console.error("[LiveProgramChecklist] evaluate failed", e);
      setJobStatus("failed_retry");
      toast.error(e?.message || "Vyhodnocení selhalo, zkus to znovu.");
    } finally {
      setFinalizing(false);
    }
  }, [doneCount, finalized, finalizing, items, persistProgress, sessionId, storageKey]);

  return (
    <div className="rounded-md border border-primary/25 bg-primary/5">
      <div className="px-3 py-2 border-b border-primary/15 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <ListChecks className="w-3.5 h-3.5 text-primary shrink-0" />
          <span className="text-xs font-medium text-foreground">Program bod po bodu</span>
          <Badge variant="outline" className="text-[9px] h-4 border-primary/30 text-primary">
            {doneCount}/{items.length}
          </Badge>
        </div>
        <Button
          size="sm"
          variant={doneCount >= items.length ? "default" : "outline"}
          className="h-6 text-[10px] px-2 gap-1"
          onClick={handleEndAndEvaluate}
          disabled={finalizing || finalized || items.length === 0}
          title="Ukončit sezení a nechat Karla vyhodnotit (i částečně)"
        >
          {finalizing ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <FlagOff className="w-3 h-3" />
          )}
          {finalized ? "Vyhodnoceno" : jobStatus === "pending" || jobStatus === "running" ? "Zpracovávám" : jobStatus === "failed_retry" ? "Čeká na opakování" : "Ukončit a vyhodnotit"}
        </Button>
      </div>

      <div className="px-2 py-2 space-y-1.5 max-h-[24rem] overflow-y-auto">
        {items.map((item, idx) => {
          const isExp = expandedId === item.id;
          const isFallback = item.id.startsWith("fallback");
          const blockRef = buildBlockRef(item, idx);
          return (
            <div
              key={item.id}
              className={`rounded-md border ${
                item.done ? "border-accent/40 bg-accent/10" : "border-border/60 bg-card/40"
              } px-2 py-1.5 transition-colors`}
            >
              <div className="flex items-start gap-2">
                <button
                  onClick={() => setDoneState(item.id, !item.done)}
                  className="shrink-0 mt-0.5"
                  aria-label={item.done ? "Označit jako nehotový" : "Označit jako hotový"}
                >
                  {item.done ? (
                    <CheckCircle2 className="w-4 h-4 text-accent" />
                  ) : (
                    <Circle className="w-4 h-4 text-muted-foreground" />
                  )}
                </button>
                <div className="flex-1 min-w-0">
                  <p
                    className={`text-[12px] leading-snug ${
                      item.done ? "text-muted-foreground" : "text-foreground"
                    }`}
                  >
                    {item.text}
                  </p>
                  {item.done && (
                    <p className="text-[10px] font-medium text-accent mt-1">
                      Bod je splněný.
                    </p>
                  )}
                  {item.observation && !isExp && (
                    <p className="text-[10px] text-muted-foreground italic mt-0.5 line-clamp-2">
                      📝 {item.observation}
                    </p>
                  )}

                  {/* ── Aktivační lišta: viditelná i bez rozbalení ── */}
                  {!isFallback && (
                    <div className="mt-1.5 flex items-center gap-1 flex-wrap">
                      {onActivateBlock && (
                        <Button
                          size="sm"
                          variant="default"
                          className="h-6 text-[10px] px-2 gap-1"
                          onClick={() => onActivateBlock(blockRef)}
                          title="Karel vyrobí obsah pro tento bod (slova / otázky / instrukci)"
                        >
                          <Sparkles className="w-3 h-3" />
                          Spustit bod
                        </Button>
                      )}
                      {onRequestArtefact && (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 text-[10px] px-2 gap-1"
                            onClick={() => onRequestArtefact(blockRef, "audio")}
                            title="Nahrát audio k tomuto bodu"
                          >
                            <Mic className="w-3 h-3" />
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 text-[10px] px-2 gap-1"
                            onClick={() => onRequestArtefact(blockRef, "image")}
                            title="Vyfotit / přidat obrázek k tomuto bodu"
                          >
                            <Camera className="w-3 h-3" />
                          </Button>
                        </>
                      )}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => setExpandedId(isExp ? null : item.id)}
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                  aria-label="Rozbalit poznámky"
                >
                  {isExp ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                </button>
              </div>
              {isExp && !isFallback && (
                <div className="mt-2 pl-6">
                  <BlockDiagnosticChat
                    blockIndex={idx}
                    blockText={blockRef.text}
                    blockDetail={blockRef.detail}
                    partName={partName}
                    therapistName={therapistName}
                    storageKey={storageKey}
                    sessionId={sessionId}
                    research={researchByIdx[idx] ?? null}
                    isResearchLoading={!!researchLoadingIdx[idx]}
                    onLoadResearch={() => loadResearch(idx, blockRef.text, blockRef.detail, "deep")}
                    onTurnsChange={turns => {
                      turnsByBlockRef.current[idx] = turns;
                      appendObservationFromTurns(item.id, turns);
                      onBlockTurnsChange?.(idx, turns);
                      queueProgressSync(items);
                    }}
                    onArtifactsChange={arts => {
                      artifactsByBlockRef.current[idx] = arts;
                      onBlockArtifactsChange?.(idx, arts);
                      queueProgressSync(items);
                    }}
                    onRequestArtefact={kind => onRequestArtefact?.(blockRef, kind)}
                    onMarkDone={() => setDoneState(item.id, true)}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default LiveProgramChecklist;

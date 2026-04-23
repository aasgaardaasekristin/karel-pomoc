import { useMemo, useState, useEffect, useCallback } from "react";
import { CheckCircle2, Circle, ChevronDown, ChevronRight, ListChecks, Sparkles, Mic, Camera } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import BlockDiagnosticChat, { type BlockResearch, type DiagTurn, type BlockArtifact } from "./BlockDiagnosticChat";

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
  onItemToggle?: (item: ProgramItem) => void;
  onObservationSubmit?: (item: ProgramItem) => void;
  /** Nové: Hanka klikla „Spustit bod" — Karel má vyrobit obsah. */
  onActivateBlock?: (block: ProgramBlockRef) => void;
  /** Nové: Hanka chce pro daný bod nahrát/poslat artefakt (audio/foto). */
  onRequestArtefact?: (block: ProgramBlockRef, kind: "audio" | "image") => void;
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
  onItemToggle,
  onObservationSubmit,
  onActivateBlock,
  onRequestArtefact,
}: Props) => {
  const parsed = useMemo(() => parseProgramBullets(planMarkdown), [planMarkdown]);

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
      const saved = window.localStorage.getItem(storageKey);
      if (saved) {
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
    setItems(initialItems);
  }, [initialItems]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(items));
    } catch {
      // quota — ignore
    }
  }, [items, storageKey]);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const toggleDone = (id: string) => {
    setItems(prev => {
      const next = prev.map(it => (it.id === id ? { ...it, done: !it.done } : it));
      const changed = next.find(it => it.id === id);
      if (changed && onItemToggle) onItemToggle(changed);
      return next;
    });
  };

  const submitObservation = (id: string) => {
    const draft = (drafts[id] ?? "").trim();
    if (!draft) return;
    setItems(prev => {
      const next = prev.map(it =>
        it.id === id ? { ...it, observation: it.observation ? `${it.observation}\n\n${draft}` : draft } : it,
      );
      const updated = next.find(it => it.id === id);
      if (updated && onObservationSubmit) onObservationSubmit(updated);
      return next;
    });
    setDrafts(d => ({ ...d, [id]: "" }));
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
                item.done ? "border-primary/30 bg-primary/5" : "border-border/60 bg-card/40"
              } px-2 py-1.5 transition-colors`}
            >
              <div className="flex items-start gap-2">
                <button
                  onClick={() => toggleDone(item.id)}
                  className="shrink-0 mt-0.5"
                  aria-label={item.done ? "Označit jako nehotový" : "Označit jako hotový"}
                >
                  {item.done ? (
                    <CheckCircle2 className="w-4 h-4 text-primary" />
                  ) : (
                    <Circle className="w-4 h-4 text-muted-foreground" />
                  )}
                </button>
                <div className="flex-1 min-w-0">
                  <p
                    className={`text-[12px] leading-snug ${
                      item.done ? "line-through text-muted-foreground" : "text-foreground"
                    }`}
                  >
                    {item.text}
                  </p>
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
              {isExp && (
                <div className="mt-2 pl-6 space-y-1.5">
                  {item.observation && (
                    <div className="rounded-sm bg-muted/40 px-2 py-1.5 text-[11px] text-foreground whitespace-pre-wrap">
                      {item.observation}
                    </div>
                  )}
                  <div className="flex items-end gap-1.5">
                    <Textarea
                      value={drafts[item.id] ?? ""}
                      onChange={e => setDrafts(d => ({ ...d, [item.id]: e.target.value }))}
                      placeholder="Co jsi u tohoto bodu pozorovala…"
                      className="min-h-[2.5rem] text-[11px] flex-1"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-[10px] gap-1 shrink-0"
                      onClick={() => submitObservation(item.id)}
                      disabled={!(drafts[item.id] ?? "").trim()}
                    >
                      <NotebookPen className="w-3 h-3" />
                      Přidat
                    </Button>
                  </div>
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

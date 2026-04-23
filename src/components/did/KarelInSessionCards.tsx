import { useEffect, useRef, useState } from "react";
import { Sparkles, Loader2, Send, X, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";

/**
 * KarelInSessionCards
 * -------------------
 * THERAPIST-LED LIVE PASS (2026-04-23) — Krok 5, pravý sloupec.
 *
 * Pravý panel živé místnosti:
 *   - kind: "observation"        → karel-live-session-feedback (krátká meta-rada)
 *   - kind: "activate_block"     → karel-live-session-produce (KONKRÉTNÍ obsah pro bod)
 *   - kind: "attachment_analysis"→ feedback s kontextem o příloze
 *
 * Aktivační karta („activate_block") má zelený akcent, větší pole pro obsah,
 * tlačítko „Hotovo, dál" které volá onCompleteBlock(block.index).
 */

export type KarelHintTrigger = {
  id: string;
  kind?: "observation" | "activate_block" | "attachment_analysis";
  observation: string;
  attachmentKind?: "image" | "audio" | "video" | "note" | null;
  programBlock?: { index?: number; block?: string; text?: string; detail?: string | null } | null;
  /** pro activate_block: celý markdown plánu jako kontext pro Karla */
  planContext?: string;
  /** pro activate_block: přímá výzva uživatele („napiš mi ty slova") */
  userRequest?: string;
};

type HintCard = {
  id: string;
  hint: string;
  kind: "observation" | "activate_block" | "attachment_analysis";
  blockIndex?: number;
  acknowledged: boolean;
  loading: boolean;
};

interface Props {
  partName: string;
  therapistName: string;
  triggers: KarelHintTrigger[];
  onAnswerHint: (text: string) => void;
  /** Volá se když uživatel klikne „Hotovo, dál" na aktivační kartě. */
  onCompleteBlock?: (blockIndex: number) => void;
}

const KarelInSessionCards = ({
  partName,
  therapistName,
  triggers,
  onAnswerHint,
  onCompleteBlock,
}: Props) => {
  const [cards, setCards] = useState<HintCard[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const processedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const last = triggers[triggers.length - 1];
    if (!last) return;
    if (processedRef.current.has(last.id)) return;
    processedRef.current.add(last.id);

    const cardId = last.id;
    const kind = last.kind ?? "observation";
    const blockIndex = last.programBlock?.index;

    setCards(prev => [
      { id: cardId, hint: "", kind, blockIndex, acknowledged: false, loading: true },
      ...prev.slice(0, 4),
    ]);

    (async () => {
      try {
        if (kind === "activate_block") {
          // ── Content-producing volání ──
          const block = last.programBlock ?? {};
          const { data, error } = await (supabase as any).functions.invoke(
            "karel-live-session-produce",
            {
              body: {
                part_name: partName,
                therapist_name: therapistName,
                program_block: {
                  index: typeof block.index === "number" ? block.index : 0,
                  text: String(block.text ?? block.block ?? "").slice(0, 600),
                  detail: block.detail ?? undefined,
                },
                plan_context: last.planContext?.slice(0, 2000),
                observation_so_far: last.observation?.slice(0, 800),
                user_request: last.userRequest?.slice(0, 400),
              },
            },
          );
          if (error) throw error;
          const content = ((data as any)?.karel_content ?? "").toString().trim();
          setCards(prev =>
            prev.map(c =>
              c.id === cardId
                ? {
                    ...c,
                    loading: false,
                    hint: content || "(Karel nevyrobil obsah — zkus znovu.)",
                  }
                : c,
            ),
          );
          return;
        }

        // ── Default: feedback (krátká meta-rada) ──
        const { data, error } = await (supabase as any).functions.invoke(
          "karel-live-session-feedback",
          {
            body: {
              part_name: partName,
              therapist_name: therapistName,
              observation: last.observation.slice(0, 1500),
              attachment_kind: last.attachmentKind ?? null,
              program_block: last.programBlock ?? null,
            },
          },
        );
        if (error) throw error;
        const hint = ((data as any)?.karel_hint ?? "").toString().trim();
        setCards(prev =>
          prev.map(c =>
            c.id === cardId
              ? {
                  ...c,
                  loading: false,
                  hint: hint || "Bez zásahu — jen tiše drž prostor.",
                }
              : c,
          ),
        );
      } catch (e) {
        console.warn("[KarelInSessionCards] failed:", e);
        setCards(prev => prev.filter(c => c.id !== cardId));
      }
    })();
  }, [triggers, partName, therapistName]);

  const ackAndRemove = (id: string) => {
    setCards(prev => prev.filter(c => c.id !== id));
    setDrafts(d => {
      const next = { ...d };
      delete next[id];
      return next;
    });
  };

  const submit = (id: string, hint: string) => {
    const draft = (drafts[id] ?? "").trim();
    if (!draft) return;
    onAnswerHint(`💡 *Reakce na Karlovu poznámku:*\n> ${hint.slice(0, 200)}…\n\n${draft}`);
    ackAndRemove(id);
  };

  const completeBlock = (card: HintCard) => {
    if (typeof card.blockIndex === "number" && onCompleteBlock) {
      onCompleteBlock(card.blockIndex);
    }
    ackAndRemove(card.id);
  };

  if (cards.length === 0) {
    return (
      <div className="rounded-md border border-border/60 bg-card/40 p-2.5 text-center">
        <Sparkles className="w-4 h-4 text-muted-foreground/50 mx-auto mb-1" />
        <p className="text-[10px] text-muted-foreground italic leading-snug">
          Karel je tu. Klikni „🎯 Spustit bod" u programu a vyrobí ti slova / otázky / instrukci.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {cards.map(card => {
        const isActivate = card.kind === "activate_block";
        const silent = !card.loading && !isActivate && /bez zásahu|tiše drž|tise drz/i.test(card.hint);
        const styleClass = isActivate
          ? "border-primary/40 bg-primary/5"
          : silent
          ? "border-border/50 bg-muted/30"
          : "border-amber-500/30 bg-amber-500/5";
        const iconColor = isActivate
          ? "text-primary"
          : silent
          ? "text-muted-foreground"
          : "text-amber-600 dark:text-amber-400";

        return (
          <div
            key={card.id}
            className={`rounded-md border ${styleClass} px-2.5 py-2 space-y-1.5`}
          >
            <div className="flex items-start gap-1.5">
              <Sparkles className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${iconColor}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 mb-0.5">
                  <span className="text-[10px] font-semibold text-foreground/80">Karel</span>
                  <Badge
                    variant="outline"
                    className="text-[8px] h-3.5 border-border/50 text-muted-foreground"
                  >
                    {isActivate
                      ? `🎯 bod #${(card.blockIndex ?? 0) + 1}`
                      : card.kind === "attachment_analysis"
                      ? "📎 analýza"
                      : "in-session"}
                  </Badge>
                </div>
                {card.loading ? (
                  <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    {isActivate ? "Karel teď vyrábí obsah pro tento bod…" : "Karel se dívá…"}
                  </div>
                ) : (
                  <p className={`${isActivate ? "text-[12px]" : "text-[11px]"} text-foreground leading-snug whitespace-pre-wrap`}>
                    {card.hint}
                  </p>
                )}
              </div>
              <button
                onClick={() => ackAndRemove(card.id)}
                className="shrink-0 text-muted-foreground hover:text-foreground"
                aria-label="Odbavit"
              >
                <X className="w-3 h-3" />
              </button>
            </div>

            {!card.loading && isActivate && (
              <div className="pl-5 flex items-center gap-1.5 flex-wrap">
                <Button
                  size="sm"
                  variant="default"
                  className="h-7 text-[10px] gap-1"
                  onClick={() => completeBlock(card)}
                >
                  <CheckCircle2 className="w-3 h-3" />
                  Hotovo, dál
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-[10px] gap-1"
                  onClick={() => onAnswerHint(`📋 *Použité Karlovo zadání pro bod #${(card.blockIndex ?? 0) + 1}:*\n${card.hint}`)}
                >
                  <Send className="w-3 h-3" />
                  Vložit do toku
                </Button>
              </div>
            )}

            {!card.loading && !isActivate && !silent && (
              <div className="flex items-end gap-1.5 pl-5">
                <Textarea
                  value={drafts[card.id] ?? ""}
                  onChange={e => setDrafts(d => ({ ...d, [card.id]: e.target.value }))}
                  placeholder="Tvoje rychlá odpověď Karlovi…"
                  className="min-h-[2.25rem] text-[11px] flex-1"
                />
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-[10px] gap-1 shrink-0"
                  onClick={() => submit(card.id, card.hint)}
                  disabled={!(drafts[card.id] ?? "").trim()}
                >
                  <Send className="w-3 h-3" />
                  Poslat
                </Button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default KarelInSessionCards;

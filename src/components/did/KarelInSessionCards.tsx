import { useEffect, useRef, useState } from "react";
import { Sparkles, Loader2, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";

/**
 * KarelInSessionCards
 * -------------------
 * THERAPIST-LED TRUTH PASS (2026-04-22) — Krok 5, pravý sloupec.
 *
 * Pravý panel živé místnosti:
 *   - Karlovy proaktivní in-session karty („pozoruj X" / „zeptej se Y").
 *   - Po každé nové zprávě/uploadu od terapeutky se na pozadí volá
 *     `karel-live-session-feedback` (Gemini 2.5 Flash, fire-and-forget).
 *   - Vrácený `karel_hint` se zobrazí jako karta s rychlým input polem
 *     „odpovědět" — text se přes `onAnswerHint` propíše zpět do hlavního
 *     chatu jako user message a Karel ho ihned započítá.
 *
 * Když je hint typu „Bez zásahu — jen tiše drž prostor.", karta se
 * zobrazí jako tichá poznámka bez input pole.
 */

export type KarelHintTrigger = {
  id: string; // unique key (timestamp)
  observation: string;
  attachmentKind?: "image" | "audio" | "video" | "note" | null;
  programBlock?: { block: string; detail?: string | null } | null;
};

type HintCard = {
  id: string;
  hint: string;
  acknowledged: boolean;
  loading: boolean;
};

interface Props {
  partName: string;
  therapistName: string;
  /** Trigger pulses: each new value spawns one feedback request. */
  triggers: KarelHintTrigger[];
  onAnswerHint: (text: string) => void;
}

const KarelInSessionCards = ({ partName, therapistName, triggers, onAnswerHint }: Props) => {
  const [cards, setCards] = useState<HintCard[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const processedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const last = triggers[triggers.length - 1];
    if (!last) return;
    if (processedRef.current.has(last.id)) return;
    processedRef.current.add(last.id);

    const cardId = last.id;
    setCards(prev => [
      { id: cardId, hint: "", acknowledged: false, loading: true },
      ...prev.slice(0, 4), // drž max 5 karet, novější nahoře
    ]);

    (async () => {
      try {
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
                  hint:
                    hint ||
                    "Bez zásahu — jen tiše drž prostor.",
                }
              : c,
          ),
        );
      } catch (e) {
        console.warn("[KarelInSessionCards] feedback failed:", e);
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
    onAnswerHint(`💡 *Reakce na Karlovu poznámku:*\n> ${hint}\n\n${draft}`);
    ackAndRemove(id);
  };

  if (cards.length === 0) {
    return (
      <div className="rounded-md border border-border/60 bg-card/40 p-3 text-center">
        <Sparkles className="w-4 h-4 text-muted-foreground/50 mx-auto mb-1.5" />
        <p className="text-[10px] text-muted-foreground italic leading-relaxed">
          Karel tu sedí potichu.<br />Po každém tvém vstupu se sám ozve s krátkou poznámkou.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {cards.map(card => {
        const silent = !card.loading && /bez zásahu|tiše drž|tise drz/i.test(card.hint);
        return (
          <div
            key={card.id}
            className={`rounded-md border ${
              silent ? "border-border/50 bg-muted/30" : "border-amber-500/30 bg-amber-500/5"
            } px-2.5 py-2 space-y-1.5`}
          >
            <div className="flex items-start gap-1.5">
              <Sparkles
                className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${
                  silent ? "text-muted-foreground" : "text-amber-600 dark:text-amber-400"
                }`}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 mb-0.5">
                  <span className="text-[10px] font-semibold text-foreground/80">Karel</span>
                  <Badge
                    variant="outline"
                    className="text-[8px] h-3.5 border-border/50 text-muted-foreground"
                  >
                    in-session
                  </Badge>
                </div>
                {card.loading ? (
                  <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Karel se dívá…
                  </div>
                ) : (
                  <p className="text-[11px] text-foreground leading-snug whitespace-pre-wrap">
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

            {!card.loading && !silent && (
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

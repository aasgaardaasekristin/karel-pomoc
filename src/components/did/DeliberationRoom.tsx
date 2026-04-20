import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useNavigate } from "react-router-dom";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import RichMarkdown from "@/components/ui/RichMarkdown";
import { Loader2, CheckCircle2, Send, ArrowRight, Users, Brain, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { useTeamDeliberations } from "@/hooks/useTeamDeliberations";
import {
  signoffProgress,
  type TeamDeliberation,
  type DeliberationQuestion,
  type KarelSynthesis,
} from "@/types/teamDeliberation";

interface Props {
  deliberationId: string | null;
  onClose: () => void;
}

const TYPE_LABEL: Record<string, string> = {
  team_task: "Společné rozhodnutí",
  session_plan: "Plán sezení",
  crisis: "Krizová koordinace",
  followup_review: "Vyhodnocení sezení",
  supervision: "Supervize",
};

function areAllQuestionsAnswered(questions: DeliberationQuestion[] = []) {
  return questions.length > 0 && questions.every((q) => !!q.answer?.trim());
}

function QuestionList({
  questions,
  who,
  onAnswer,
  readOnly = false,
}: {
  questions: DeliberationQuestion[];
  who: "hanka" | "kata";
  onAnswer: (idx: number, answer: string) => Promise<void>;
  readOnly?: boolean;
}) {
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<number | null>(null);

  if (!questions || questions.length === 0) {
    return (
      <p className="text-[11px] text-muted-foreground italic">
        Žádná otázka pro {who === "hanka" ? "Haničku" : "Káťu"}.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {questions.map((q, i) => (
        <div key={i} className="rounded-md border border-border/60 bg-card/40 p-2.5 space-y-1.5">
          <p className="text-[12px] font-medium text-foreground">{q.question}</p>
          {q.answer ? (
            <div className="rounded bg-muted/40 p-2 text-[11px] text-foreground/90">
              <span className="text-[9px] text-muted-foreground block mb-1">
                {who === "hanka" ? "Hanička" : "Káťa"} odpověděla:
              </span>
              {q.answer}
            </div>
          ) : readOnly ? (
            <p className="text-[10px] text-muted-foreground italic">Bez odpovědi.</p>
          ) : (
            <div className="space-y-1.5">
              <Textarea
                value={drafts[i] ?? ""}
                onChange={(e) => setDrafts((d) => ({ ...d, [i]: e.target.value }))}
                placeholder={`Odpověď ${who === "hanka" ? "Haničky" : "Káti"}...`}
                className="min-h-[56px] text-[11px]"
              />
              <Button
                size="sm"
                className="h-7 text-[11px]"
                disabled={!drafts[i]?.trim() || busy === i}
                onClick={async () => {
                  setBusy(i);
                  try {
                    await onAnswer(i, drafts[i].trim());
                    setDrafts((d) => ({ ...d, [i]: "" }));
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                {busy === i ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                <span className="ml-1">Odeslat</span>
              </Button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function KarelSynthesisBlock({
  d,
  synthesizing,
  onSynthesize,
  readOnly = false,
}: {
  d: TeamDeliberation;
  synthesizing: boolean;
  onSynthesize: () => void;
  readOnly?: boolean;
}) {
  const isCrisis = d.deliberation_type === "crisis";
  const synth = d.karel_synthesis as KarelSynthesis | null;
  const crisisAnswersReady =
    areAllQuestionsAnswered(d.questions_for_hanka ?? []) &&
    areAllQuestionsAnswered(d.questions_for_kata ?? []);

  const hasInput =
    (d.questions_for_hanka ?? []).some((q) => q.answer?.trim()) ||
    (d.questions_for_kata ?? []).some((q) => q.answer?.trim()) ||
    (d.discussion_log ?? []).length > 0;
  const canSynthesize = isCrisis ? crisisAnswersReady : hasInput;

  if (!synth) {
    if (!isCrisis && !hasInput) return null;
    if (readOnly) return null;
    return (
      <section className={`rounded-lg border p-3 space-y-2 ${
        isCrisis ? "border-amber-500/40 bg-amber-500/5" : "border-border/60 bg-card/40"
      }`}>
        <div className="flex items-start gap-2">
          {isCrisis ? (
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
          ) : (
            <Brain className="w-4 h-4 text-primary shrink-0 mt-0.5" />
          )}
          <div className="flex-1">
            <h4 className="text-[11px] font-semibold text-foreground">
              {isCrisis ? "Karlova syntéza je povinná před podpisem" : "Karlova syntéza"}
            </h4>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              {isCrisis
                ? "Karel musí nejdřív vyhodnotit kompletní odpovědi Haničky a Káti (krize trvá / polevuje / lze uzavřít) a teprve potom může podepsat."
                : "Karel může vyhodnotit odpovědi terapeutek a navrhnout další krok."}
            </p>
          </div>
        </div>
        <Button
          size="sm"
          className="h-7 text-[11px] w-full"
          disabled={!canSynthesize || synthesizing}
          onClick={onSynthesize}
        >
          {synthesizing ? (
            <Loader2 className="w-3 h-3 mr-1 animate-spin" />
          ) : (
            <Brain className="w-3 h-3 mr-1" />
          )}
          {canSynthesize
            ? "Spustit Karlovu syntézu"
            : isCrisis
              ? "Čeká na kompletní odpovědi terapeutek"
              : "Čeká na odpovědi terapeutek"}
        </Button>
      </section>
    );
  }

  const verdictLabel: Record<string, { label: string; tone: string }> = {
    crisis_persists: { label: "🔴 Krize trvá", tone: "border-destructive/40 bg-destructive/5 text-destructive" },
    crisis_easing: { label: "🟡 Krize polevuje", tone: "border-amber-500/40 bg-amber-500/5 text-amber-700" },
    crisis_resolvable: { label: "🟢 Krizi lze uzavřít", tone: "border-emerald-500/40 bg-emerald-500/5 text-emerald-700" },
    non_crisis: { label: "Bez krizového stavu", tone: "border-border/60 bg-card/40 text-foreground" },
  };
  const v = verdictLabel[synth.verdict] ?? verdictLabel.crisis_persists;

  return (
    <section className={`rounded-lg border p-3 space-y-2 ${v.tone}`}>
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-[11px] font-semibold flex items-center gap-1.5">
          <Brain className="w-3.5 h-3.5" />
          Karlova syntéza — {v.label}
        </h4>
        {!readOnly && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[10px]"
            disabled={synthesizing}
            onClick={onSynthesize}
          >
            {synthesizing ? <Loader2 className="w-3 h-3 animate-spin" /> : "Přesyntetizovat"}
          </Button>
        )}
      </div>
      <p className="text-[11px] text-foreground/90"><strong>Další krok:</strong> {synth.next_step}</p>
      {synth.needs_karel_interview && (
        <p className="text-[11px] text-foreground/90">
          <strong>Karel si přizve {(d.subject_parts ?? [])[0] || "část"} k vlastnímu rozhovoru.</strong>
        </p>
      )}
      {synth.recommended_session_focus && (
        <p className="text-[11px] text-foreground/90">
          <strong>Zaměření sezení:</strong> {synth.recommended_session_focus}
        </p>
      )}
      {synth.key_insights.length > 0 && (
        <div className="text-[11px]">
          <strong className="block mb-0.5">Klíčové vhledy:</strong>
          <ul className="list-disc pl-4 space-y-0.5 text-foreground/85">
            {synth.key_insights.map((k, i) => <li key={i}>{k}</li>)}
          </ul>
        </div>
      )}
      {synth.risk_signals.length > 0 && (
        <div className="text-[11px]">
          <strong className="block mb-0.5">Rizikové signály:</strong>
          <ul className="list-disc pl-4 space-y-0.5 text-foreground/85">
            {synth.risk_signals.map((k, i) => <li key={i}>{k}</li>)}
          </ul>
        </div>
      )}
      {synth.protective_signals.length > 0 && (
        <div className="text-[11px]">
          <strong className="block mb-0.5">Ochranné signály:</strong>
          <ul className="list-disc pl-4 space-y-0.5 text-foreground/85">
            {synth.protective_signals.map((k, i) => <li key={i}>{k}</li>)}
          </ul>
        </div>
      )}
      {d.karel_synthesized_at && (
        <p className="text-[9px] text-muted-foreground italic">
          Syntéza: {new Date(d.karel_synthesized_at).toLocaleString("cs-CZ")}
        </p>
      )}
    </section>
  );
}

const DeliberationRoom = ({ deliberationId, onClose }: Props) => {
  const navigate = useNavigate();
  const { sign, synthesize, answerQuestion, postMessage, reload, items } = useTeamDeliberations(0);
  const [d, setD] = useState<TeamDeliberation | null>(null);
  const [loading, setLoading] = useState(true);
  const [signing, setSigning] = useState<string | null>(null);
  const [synthesizing, setSynthesizing] = useState(false);
  const [chatDraft, setChatDraft] = useState("");
  const [chatAuthor, setChatAuthor] = useState<"hanka" | "kata" | "karel">("hanka");
  const [bridgedPlanId, setBridgedPlanId] = useState<string | null>(null);

  useEffect(() => {
    const found = items.find((x) => x.id === deliberationId) ?? null;
    if (found) {
      setD(found);
      setLoading(false);
      return;
    }
    if (!deliberationId) return;
    let alive = true;
    (async () => {
      const { data, error } = await (supabase as any)
        .from("did_team_deliberations")
        .select("*")
        .eq("id", deliberationId)
        .maybeSingle();
      if (!alive) return;
      if (!error && data) setD(data as TeamDeliberation);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [deliberationId, items]);

  // realtime row refresh
  useEffect(() => {
    if (!deliberationId) return;
    const ch = (supabase as any)
      .channel(`delib_${deliberationId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "did_team_deliberations", filter: `id=eq.${deliberationId}` },
        (payload: any) => setD(payload.new as TeamDeliberation),
      )
      .subscribe();
    return () => { (supabase as any).removeChannel(ch); };
  }, [deliberationId]);

  if (!deliberationId) return null;

  const handleSign = async (who: "hanka" | "kata" | "karel") => {
    if (!d) return;
    setSigning(who);
    try {
      const res = await sign(d.id, who);
      if (res?.bridged_plan_id) {
        setBridgedPlanId(res.bridged_plan_id);
        toast.success("Porada schválena. Plán propsán do dnešního live sezení.");
      } else if (res?.deliberation?.status === "approved") {
        toast.success("Porada schválena.");
      } else {
        toast.success(`Podpis ${who === "hanka" ? "Hanička" : who === "kata" ? "Káťa" : "Karel"} zapsán.`);
      }
    } catch (e: any) {
      toast.error(e?.message ?? "Podpis selhal.");
    } finally {
      setSigning(null);
    }
  };

  const handleSynthesize = async () => {
    if (!d) return;
    setSynthesizing(true);
    try {
      const res = await synthesize(d.id);
      if (res?.synthesis) {
        toast.success("Karlova syntéza hotová. Můžeš podepsat.");
      }
    } catch (e: any) {
      toast.error(e?.message ?? "Syntéza selhala. Mají Hanička a Káťa už odpověděno?");
    } finally {
      setSynthesizing(false);
    }
  };

  const handleAnswer = async (who: "hanka" | "kata", idx: number, answer: string) => {
    if (!d) return;
    try {
      await answerQuestion(d.id, who, idx, answer);
    } catch (e: any) {
      toast.error(e?.message ?? "Uložení odpovědi selhalo.");
    }
  };

  const handlePostMessage = async () => {
    if (!d || !chatDraft.trim()) return;
    try {
      await postMessage(d.id, chatAuthor, chatDraft.trim());
      setChatDraft("");
    } catch (e: any) {
      toast.error(e?.message ?? "Odeslání selhalo.");
    }
  };

  const goToLiveSession = () => {
    const planId = bridgedPlanId ?? d?.linked_live_session_id;
    if (!planId) return;
    navigate(`/?did=live-session&daily_plan_id=${planId}`);
    onClose();
  };

  const sp = d ? signoffProgress(d) : { signed: 0, total: 3, missing: [] };
  const isReadOnly = d?.status === "approved";

  return (
    <Dialog open={!!deliberationId} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-w-3xl w-[calc(100vw-2rem)] h-[90vh] sm:h-auto sm:max-h-[90vh] p-0 gap-0 overflow-hidden !grid-cols-1 grid-rows-[auto_minmax(0,1fr)_auto] sm:!flex sm:!flex-col"
      >
        <DialogHeader className="px-6 pt-6 pb-3 shrink-0 border-b border-border/40">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Users className="w-4 h-4 text-primary" />
            {loading ? "Načítám…" : d?.title ?? "Porada"}
          </DialogTitle>
          {d && (
            <DialogDescription className="text-[11px] flex flex-wrap items-center gap-1.5">
              <Badge className="text-[9px] h-4 px-1.5 bg-muted text-muted-foreground border-border">
                {TYPE_LABEL[d.deliberation_type] ?? d.deliberation_type}
              </Badge>
              {d.subject_parts?.map((p) => (
                <Badge key={p} className="text-[9px] h-4 px-1.5 bg-primary/10 text-primary border-primary/20">
                  {p}
                </Badge>
              ))}
              <span className="text-muted-foreground ml-1">
                podpisy {sp.signed}/{sp.total}
              </span>
            </DialogDescription>
          )}
        </DialogHeader>


        {loading || !d ? (
          <div className="flex justify-center py-8 px-6">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="min-h-0 overflow-y-auto overscroll-contain px-6 py-4">
            <div className="space-y-4">
              {isReadOnly && (
                <section className="rounded-lg border border-primary/30 bg-primary/5 p-3 flex items-start gap-2">
                  <CheckCircle2 className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <h4 className="text-[11px] font-semibold text-foreground">
                      Porada je schválená — náhled jen pro čtení
                    </h4>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      Odpovědi, podpisy i Karlova syntéza jsou uzavřené. Nelze měnit, jen prohlížet.
                      Pro nové rozhodnutí počkej na další briefing.
                    </p>
                  </div>
                </section>
              )}
              {/* Karlův úvod */}
              <section className="rounded-lg border border-border/60 bg-card/40 p-3">
                <h4 className="text-[11px] font-semibold text-muted-foreground mb-1.5">
                  Karel svolal poradu
                </h4>
                <RichMarkdown compact>{d.initial_karel_brief ?? "(žádný brief)"}</RichMarkdown>
                {d.reason && (
                  <p className="text-[11px] text-muted-foreground italic mt-2">
                    Důvod: {d.reason}
                  </p>
                )}
              </section>

              {/* Karlův návrh — pro session_plan je to first_draft z briefingu */}
              <section className="rounded-lg border border-primary/20 bg-primary/5 p-3">
                <h4 className="text-[11px] font-semibold text-primary mb-1.5">
                  {d.deliberation_type === "session_plan" ? "První pracovní návrh" : "Karlův pracovní návrh"}
                </h4>
                <RichMarkdown compact>{d.karel_proposed_plan ?? "(zatím bez návrhu)"}</RichMarkdown>
              </section>

              {/* SLICE 3 — Agenda / minutáž (zejména pro session_plan) */}
              {Array.isArray((d as any).agenda_outline) && (d as any).agenda_outline.length > 0 && (
                <section className="rounded-lg border border-border/60 bg-card/40 p-3">
                  <h4 className="text-[11px] font-semibold text-foreground mb-2">
                    Osnova / minutáž
                  </h4>
                  <ol className="space-y-1.5">
                    {((d as any).agenda_outline as Array<{block:string;minutes?:number|null;detail?:string|null}>).map((b, i) => (
                      <li key={i} className="text-[11px] flex gap-2">
                        <span className="font-semibold text-primary shrink-0">
                          {i + 1}.
                          {typeof b.minutes === "number" && b.minutes > 0 ? ` ${b.minutes}′` : ""}
                        </span>
                        <span className="flex-1">
                          <span className="font-medium text-foreground">{b.block}</span>
                          {b.detail && (
                            <span className="block text-foreground/75 mt-0.5">{b.detail}</span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ol>
                </section>
              )}

              {/* Otázky pro Haničku */}
              <section className="rounded-lg border border-border/60 p-3">
                <h4 className="text-[11px] font-semibold mb-2 text-foreground">
                  Pro Haničku
                </h4>
                <QuestionList
                  questions={d.questions_for_hanka ?? []}
                  who="hanka"
                  onAnswer={(idx, ans) => handleAnswer("hanka", idx, ans)}
                />
              </section>

              {/* Otázky pro Káťu */}
              <section className="rounded-lg border border-border/60 p-3">
                <h4 className="text-[11px] font-semibold mb-2 text-foreground">
                  Pro Káťu
                </h4>
                <QuestionList
                  questions={d.questions_for_kata ?? []}
                  who="kata"
                  onAnswer={(idx, ans) => handleAnswer("kata", idx, ans)}
                />
              </section>

              {/* Volný diskusní log */}
              {(d.discussion_log?.length ?? 0) > 0 && (
                <section className="rounded-lg border border-border/60 p-3 space-y-1.5">
                  <h4 className="text-[11px] font-semibold mb-1 text-foreground">
                    Diskuse
                  </h4>
                  {d.discussion_log.map((m, i) => (
                    <div key={i} className="text-[11px]">
                      <span className="font-semibold mr-1">
                        {m.author === "karel" ? "Karel" : m.author === "hanka" ? "Hanička" : "Káťa"}:
                      </span>
                      <span className="text-foreground/90 whitespace-pre-line">{m.content}</span>
                    </div>
                  ))}
                </section>
              )}

              {/* KARLOVA SYNTÉZA — povinná pro `crisis` před Karlovým podpisem */}
              <KarelSynthesisBlock
                d={d}
                synthesizing={synthesizing}
                onSynthesize={handleSynthesize}
              />

              <section className="rounded-lg border border-dashed border-border/60 p-3 space-y-2">
                <div className="flex items-center gap-1.5">
                  {(["hanka", "kata", "karel"] as const).map((who) => (
                    <Button
                      key={who}
                      size="sm"
                      variant={chatAuthor === who ? "default" : "outline"}
                      className="h-6 px-2 text-[10px]"
                      onClick={() => setChatAuthor(who)}
                    >
                      {who === "hanka" ? "Hanička" : who === "kata" ? "Káťa" : "Karel"}
                    </Button>
                  ))}
                </div>
                <Textarea
                  value={chatDraft}
                  onChange={(e) => setChatDraft(e.target.value)}
                  placeholder="Příspěvek do diskuse…"
                  className="min-h-[50px] text-[11px]"
                />
                <Button
                  size="sm"
                  className="h-7 text-[11px]"
                  disabled={!chatDraft.trim()}
                  onClick={handlePostMessage}
                >
                  <Send className="w-3 h-3 mr-1" /> Odeslat
                </Button>
              </section>
            </div>
          </div>
        )}

        {d && (
          <div className="shrink-0 border-t border-border/60 px-6 py-3 bg-background space-y-2">
            <div className="flex items-center gap-2">
              {(["hanka", "kata", "karel"] as const).map((who) => {
                const signed =
                  who === "hanka" ? d.hanka_signed_at :
                  who === "kata" ? d.kata_signed_at : d.karel_signed_at;
                const crisisAnswersReady =
                  areAllQuestionsAnswered(d.questions_for_hanka ?? []) &&
                  areAllQuestionsAnswered(d.questions_for_kata ?? []);
                // GATE: Karlův podpis je u krizové porady aktivní jen poté,
                // co proběhla FRESH syntéza nad aktuálními odpověďmi.
                // Po každé nové odpovědi / diskusní zprávě se karel_synthesis
                // automaticky vynuluje (viz useTeamDeliberations.invalidateSynthesis),
                // takže Karel musí syntetizovat znova.
                const karelGateBlocked =
                  who === "karel" &&
                  d.deliberation_type === "crisis" &&
                  (!crisisAnswersReady || !d.karel_synthesis);
                const disabled = !!signed || signing === who || karelGateBlocked;
                return (
                  <Button
                    key={who}
                    size="sm"
                    variant={signed ? "secondary" : "default"}
                    disabled={disabled}
                    title={karelGateBlocked
                      ? 'Karel musí (znovu) syntetizovat odpovědi terapeutek — viz tlačítko „Spustit Karlovu syntézu".'
                      : undefined}
                    className="h-8 text-[11px] flex-1"
                    onClick={() => handleSign(who)}
                  >
                    {signing === who ? (
                      <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                    ) : signed ? (
                      <CheckCircle2 className="w-3 h-3 mr-1 text-primary" />
                    ) : null}
                    {signed ? `${who === "hanka" ? "Hanička" : who === "kata" ? "Káťa" : "Karel"} ✓` : `Podepsat za ${who === "hanka" ? "Haničku" : who === "kata" ? "Káťu" : "Karla"}`}
                  </Button>
                );
              })}
            </div>
            {(d.status === "approved" || bridgedPlanId) && d.deliberation_type === "session_plan" && (
              <Button
                size="sm"
                className="w-full h-8 text-[11px]"
                onClick={goToLiveSession}
                disabled={!bridgedPlanId && !d.linked_live_session_id}
              >
                Otevřít DID live sezení <ArrowRight className="w-3 h-3 ml-1" />
              </Button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default DeliberationRoom;

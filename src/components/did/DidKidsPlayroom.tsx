import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { ArrowLeft, Camera, FileText, Image as ImageIcon, Loader2, Mic, Send, Square, Video, X, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { getAuthHeaders } from "@/lib/auth";
import { pragueTodayISO } from "@/lib/dateOnlyTaskHelpers";
import { toast } from "sonner";
import tundrupekPlayroomBg from "@/assets/tundrupek-playroom-bg.jpg";
import { buildAttachmentContent, useUniversalUpload, type PendingAttachment } from "@/hooks/useUniversalUpload";
import { handleApiError, parseSSEStream } from "@/lib/chatHelpers";
import { useAudioRecorder } from "@/hooks/useAudioRecorder";

const PREFERRED_PLAN_ID = "8d2deb4f-4e9e-48a2-8abc-c3f5be8d7914";

interface PlayroomPlanRow {
  id: string;
  selected_part: string;
  status?: string;
  program_status?: string;
  urgency_breakdown: Record<string, any>;
  plan_markdown?: string;
  created_at?: string;
}

interface PlayroomThread {
  id: string;
  messages: { role: "user" | "assistant"; content: any }[];
}

const blockedChildText = /(Karel-only|DID\/Kluci\/Herna|M[ůu][žz]e\s+tu\s+b[ýy]t|konkr[ée]tn[íi]\s+motivy|nab[íi]dka,?\s+ne\s+jako\s+tvrzen[íi]|preference|voln[ée]\s+m[íi]sto\s+pro\s+symbol|Karel\s+je\s+v\s+m[íi]stnosti\s+p[řr][íi]tomen|theme_source|playroom_plan|clinical_goal|evidence|diagnostik|trauma|terapeutick[ýy]\s+pl[áa]n|Hani[čc]ka|K[áa][ťt]a|intern[íi]|writeback|risk_assessment|forbidden_methods)/i;

const childSafe = (value: unknown) => {
  const text = String(value ?? "").trim();
  return text && !blockedChildText.test(text) ? text : "";
};

const toList = (value: unknown) => {
  if (Array.isArray(value)) return value.map(childSafe).filter(Boolean).slice(0, 5);
  const safe = childSafe(value);
  return safe ? [safe] : [];
};

const getChildAddress = (partName: string) => partName.toLocaleUpperCase("cs-CZ") === "TUNDRUPEK" ? "TUNDRUPKU" : partName;

const firstChoices = ["jde to", "nejde to", "nevím", "chci jen ticho"];
const PLAYROOM_TECH_FALLBACK = "Slyším tě. Teď se mi na chvilku zasekl hlas, ale zůstávám tady u dveří a nic nemusíš opravovat. Vyber jen jednu věc: mám být blíž, dál, nebo úplně potichu?";

const getRoomBackground = (partName: string) => {
  if (partName.toLocaleUpperCase("cs-CZ") === "TUNDRUPEK") return tundrupekPlayroomBg;
  return tundrupekPlayroomBg;
};

const contentText = (content: any) => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => part?.text || (part?.image_url ? "Přiložený obrázek" : "Příloha")).filter(Boolean).join("\n");
  return "";
};

const attachmentLabel: Record<PendingAttachment["category"], string> = {
  image: "fotka",
  audio: "hlas",
  video: "video",
  document: "soubor",
  screenshot: "screenshot",
};

const cleanPlanForPlayroom = (markdown?: string) => (markdown || "")
  .split("\n")
  .filter((line) => !/čeká\s+na\s+schválení|nesmí\s+otevřít|účel\s+dokumentu|nikoli\s+child-facing/i.test(line))
  .join("\n")
  .trim();

const getProgramSteps = (plan: PlayroomPlanRow | null) => {
  const steps = plan?.urgency_breakdown?.playroom_plan?.therapeutic_program;
  return Array.isArray(steps) ? steps : [];
};

const stepLine = (step: any) => [
  `${step.step || "?"}. ${step.title || "krok"}`,
  step.method ? `metoda: ${step.method}` : null,
  step.child_facing_prompt_draft ? `dětská replika: ${step.child_facing_prompt_draft}` : null,
  step.karel_response_strategy ? `strategie: ${step.karel_response_strategy}` : null,
  Array.isArray(step.expected_response_range) ? `možné reakce: ${step.expected_response_range.join(", ")}` : null,
  Array.isArray(step.stop_if) ? `stop při: ${step.stop_if.join(", ")}` : null,
  step.fallback ? `fallback: ${step.fallback}` : null,
].filter(Boolean).join(" | ");

const currentStepForThread = (plan: PlayroomPlanRow | null, currentThread?: PlayroomThread | null) => {
  const steps = getProgramSteps(plan);
  if (!steps.length) return null;
  const userTurns = currentThread?.messages?.filter((message) => message.role === "user").length || 1;
  return steps[Math.min(Math.max(userTurns, 1) - 1, steps.length - 1)];
};

const planContract = (plan: PlayroomPlanRow | null, currentThread?: PlayroomThread | null) => {
  const steps = getProgramSteps(plan);
  const currentStep = currentStepForThread(plan, currentThread);
  return `SCHVÁLENÝ PROGRAM HERNY PRO DNEŠEK — AKTIVNÍ, ODSOUHLASENÝ TERAPEUTKAMI.
PLAN_ID: ${plan?.id || "neznámý"}
ČÁST: ${plan?.selected_part || plan?.urgency_breakdown?.target_part || "neznámá"}
REVIEW_STATE: ${plan?.urgency_breakdown?.review_state || plan?.urgency_breakdown?.approval?.review_state || "neznámý"}
POVOLENÁ HLOUBKA: ${plan?.urgency_breakdown?.allowed_depth || plan?.urgency_breakdown?.playroom_plan?.allowed_depth || "check_in_only"}

${cleanPlanForPlayroom(plan?.plan_markdown)}

STRUKTUROVANÝ PROGRAM — POUŽIJ JAKO SKRYTÝ ŘÍDICÍ PLÁN, NEUKAZUJ DÍTĚTI:
${steps.length ? steps.map(stepLine).join("\n") : "Programové kroky nejsou ve strukturovaných datech; drž se plan_markdown a nejnižší možné hloubky."}

AKTUÁLNÍ KROK TEĎ:
${currentStep ? stepLine(currentStep) : "krok 1: bezpečný vstup a volba vzdálenosti"}

HERNA KONTRAKT PRO KARLA:
- Nejde o běžné vlákno. Vedeš strukturované terapeutické Herna sezení podle schváleného programu.
- V každé odpovědi zvol konkrétní další krok programu, ale ihned ho přizpůsob aktuálnímu stavu dítěte.
- Každá replika má mít: 1) naladění na odpověď nebo přílohu, 2) jemnou motivaci, 3) jednu konkrétní mikro-aktivitu / test / volbu A/B.
- Nesmíš být pasivní. Neptej se prázdně „co chceš dělat“. Veď, ale nech kontrolu dítěti.
- Odpověď má být krátká, konkrétní a profesionální: max 5 krátkých vět, vždy jeden krok, nikdy obecné povídání.
- Nikdy dítěti neukazuj interní plán, názvy diagnostiky, terapeutek ani technické vrstvy.
- Nikdy sám nenabízej posílání vzkazů mamince/Haničce/Kátě/e-mailem. Jen pokud si o to dítě výslovně řekne nebo je bezprostřední bezpečnostní riziko.
- Reaguj na text, hlas, fotku, video, screenshot i dokument jako na materiál ze sezení, ne jako na běžnou přílohu.
- U obrázku/screenshotu můžeš reagovat na viditelný obsah; u hlasu, videa a dokumentu nikdy nepředstírej obsah, pokud ho v datech nevidíš — reaguj na odeslání materiálu a udělej bezpečný další krok.`;
};

const getRoomTone = (plan: PlayroomPlanRow | null, thread: PlayroomThread | null) => {
  const raw = `${plan?.urgency_breakdown?.readiness_today || ""} ${plan?.urgency_breakdown?.playroom_theme || ""} ${contentText(thread?.messages?.at(-1)?.content)}`.toLocaleLowerCase("cs-CZ");
  if (/nejde|ticho|stop|unaven|strach|red|kriz/.test(raw)) return "quiet";
  if (/jde|hra|zvědav|aktiv|green|kontakt/.test(raw)) return "open";
  return "listening";
};

const getStepPrompt = (plan: PlayroomPlanRow | null, thread: PlayroomThread | null) => {
  const step = currentStepForThread(plan, thread);
  return childSafe(step?.child_facing_prompt_draft) || "Mám být blíž, dál, nebo úplně potichu u dveří?";
};

const DidKidsPlayroom = ({ onBack }: { onBack: () => void }) => {
  const [plan, setPlan] = useState<PlayroomPlanRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const [thread, setThread] = useState<PlayroomThread | null>(null);
  const [reply, setReply] = useState("");
  const [saving, setSaving] = useState(false);
  const [ending, setEnding] = useState(false);
  const uploads = useUniversalUpload();
  const recorder = useAudioRecorder();
  const photoInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const documentInputRef = useRef<HTMLInputElement>(null);

  const targetPart = plan?.selected_part || plan?.urgency_breakdown?.target_part || "";
  const childAddress = useMemo(() => getChildAddress(targetPart), [targetPart]);
  const roomBackground = useMemo(() => getRoomBackground(targetPart), [targetPart]);
  const roomTone = useMemo(() => getRoomTone(plan, thread), [plan, thread]);
  const opener = useMemo(() => childSafe(contentText(thread?.messages?.find((message) => message.role === "assistant")?.content)) || "Jsem tady. Zkusíme dnes jen jeden malý krok.", [thread]);
  const stepPrompt = useMemo(() => getStepPrompt(plan, thread), [plan, thread]);

  const loadApprovedPlan = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await (supabase as any)
        .from("did_daily_session_plans")
        .select("id, selected_part, status, program_status, urgency_breakdown, plan_markdown, created_at")
        .eq("plan_date", pragueTodayISO())
        .order("created_at", { ascending: false });
      if (error) throw error;

      const candidates = ((data as PlayroomPlanRow[]) || []).filter((row) => {
        const c = row.urgency_breakdown || {};
        return c.session_actor === "karel_direct"
          && c.lead_entity === "karel"
          && c.ui_surface === "did_kids_playroom"
          && c.approved_for_child_session === true
          && ["approved", "ready_to_start", "in_progress"].includes(row.program_status || c.review_state || c.approval?.review_state || "");
      });
      setPlan(candidates.find((row) => row.id === PREFERRED_PLAN_ID) || candidates[0] || null);
    } catch (error) {
      console.error("[DidKidsPlayroom] plan load failed", error);
      setPlan(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadApprovedPlan(); }, [loadApprovedPlan]);

  const enterPlayroom = async (firstReply?: string) => {
    if (!plan || !targetPart) return;
    setOpening(true);
    try {
      const headers = await getAuthHeaders();
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-part-session-prepare`, {
        method: "POST",
        headers,
        body: JSON.stringify({ part_name: targetPart, plan_id: plan.id }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.thread_id) throw new Error(payload.message || payload.error || "Herna nejde otevřít.");

      const { data, error } = await (supabase as any)
        .from("did_threads")
        .select("id, messages")
        .eq("id", payload.thread_id)
        .maybeSingle();
      if (error || !data) throw error || new Error("Vlákno Herny se nenašlo.");
      const loadedThread = { id: data.id, messages: ((data.messages || []) as PlayroomThread["messages"]).map((message) => ({ ...message, content: childSafe(contentText(message.content)) || "Jsem tady. Můžeme zůstat potichu." })) };
      setThread(loadedThread);
      if (firstReply) {
        await saveReply(loadedThread, firstReply);
      }
    } catch (error: any) {
      toast.error(error?.message || "Herna dnes nejde otevřít.");
    } finally {
      setOpening(false);
    }
  };

  const saveReply = async (currentThread: PlayroomThread, content: string, currentAttachments: PendingAttachment[] = []) => {
    if (!content.trim() && currentAttachments.length === 0) return;
    setSaving(true);
    const userContent = buildAttachmentContent(content.trim() || "Posílám přílohu.", currentAttachments);
    const nextMessages: PlayroomThread["messages"] = [
      ...currentThread.messages,
      { role: "user", content: userContent },
    ];
    try {
      setThread({ ...currentThread, messages: [...nextMessages, { role: "assistant", content: "" }] });
      const headers = await getAuthHeaders();
      const body = {
        messages: nextMessages.slice(-18),
        mode: "childcare",
        didSubMode: "playroom",
        didPartName: targetPart,
        didThreadLabel: targetPart,
        didInitialContext: planContract(plan, currentThread),
      };
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-chat`, { method: "POST", headers, body: JSON.stringify(body) });
      if (!response.ok) handleApiError(response);
      if (!response.body) throw new Error("Karel neodpověděl.");
      const assistantContent = await parseSSEStream(response.body, (partial) => {
        setThread((prev) => prev ? { ...prev, messages: [...nextMessages, { role: "assistant", content: childSafe(partial) || partial }] } : prev);
      });
      const safeAssistantContent = childSafe(assistantContent) || assistantContent || PLAYROOM_TECH_FALLBACK;
      const savedMessages = [...nextMessages, { role: "assistant" as const, content: safeAssistantContent }];
      const { error } = await (supabase as any).from("did_threads").update({ messages: savedMessages, last_activity_at: new Date().toISOString(), is_processed: false }).eq("id", currentThread.id);
      if (error) throw error;
      setThread({ ...currentThread, messages: savedMessages });
      setReply("");
      uploads.clearAttachments();
    } catch (error) {
      console.error("[DidKidsPlayroom] message save failed", error);
      const fallbackMessages = [...nextMessages, { role: "assistant" as const, content: PLAYROOM_TECH_FALLBACK }];
      setThread({ ...currentThread, messages: fallbackMessages });
      await (supabase as any).from("did_threads").update({ messages: fallbackMessages, last_activity_at: new Date().toISOString(), is_processed: false }).eq("id", currentThread.id);
      setReply("");
      uploads.clearAttachments();
      toast.error(error instanceof Error ? error.message : "Karel se na chvíli zasekl, ale Herna zůstává otevřená.");
    } finally {
      setSaving(false);
    }
  };

  const sendReply = async (content: string) => {
    if (!thread) return;
    await saveReply(thread, content, uploads.attachments);
  };

  const attachRecording = async () => {
    const base64 = await recorder.getBase64();
    if (!base64) return;
    uploads.addAttachment({ id: `voice-${Date.now()}`, name: "hlas_tundrupka.webm", type: "audio/webm", size: Math.round(base64.length * 0.75), category: "audio", dataUrl: `data:audio/webm;base64,${base64}` });
    recorder.discardRecording();
  };

  const handlePickedFiles = (event: ChangeEvent<HTMLInputElement>, category?: PendingAttachment["category"]) => {
    Array.from(event.target.files || []).forEach((file) => void uploads.processFile(file, category));
    event.target.value = "";
  };

  if (loading) {
    return <div className="flex-1 grid place-items-center"><Loader2 className="h-7 w-7 animate-spin text-primary" /></div>;
  }

  if (!plan) {
    return (
      <div className="min-h-full bg-background px-4 py-6">
        <div className="mx-auto max-w-2xl space-y-4">
          <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft className="mr-2 h-4 w-4" />Zpět</Button>
          <section className="rounded-lg border border-border bg-card p-6 text-center shadow-sm">
            <h1 className="text-2xl font-serif text-foreground">Herna</h1>
            <p className="mt-3 text-sm text-muted-foreground">Herna dnes ještě není otevřená.</p>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full bg-background">
      <section className="relative min-h-[calc(100vh-4rem)] overflow-hidden px-4 py-5">
        <img
          src={roomBackground}
          alt="Klidná herna s dveřmi, malým světlem a místem k sezení"
          className="absolute inset-0 h-full w-full object-cover"
          width={1344}
          height={768}
          fetchPriority="high"
        />
        <div className={roomTone === "quiet" ? "absolute inset-0 bg-background/12" : roomTone === "open" ? "absolute inset-0 bg-primary/5" : "absolute inset-0 bg-background/8"} />
        <div className="relative z-10 mx-auto flex min-h-[calc(100vh-6.5rem)] max-w-4xl flex-col space-y-3">
          <Button variant="secondary" size="sm" onClick={onBack} className="w-fit bg-background/45 text-foreground/70 backdrop-blur-sm"><ArrowLeft className="mr-2 h-4 w-4" />Zpět</Button>

          <header className="space-y-1 text-center drop-shadow-sm">
            <h1 className="text-3xl font-serif text-foreground">Herna</h1>
          </header>

          <div className="flex flex-1 items-center justify-center pb-8 pt-3">
            <div className="w-full max-w-lg space-y-4 rounded-lg border border-border/35 bg-background/38 p-5 text-center shadow-sm backdrop-blur-[3px]">
              <div className="space-y-3 text-foreground/72">
                {thread ? opener.split("\n").filter(Boolean).slice(0, 4).map((line, index) => (
                  <p key={index} className="text-base leading-relaxed">{line}</p>
                )) : <>
                  <p className="text-base leading-relaxed">Ahoj, {childAddress}.</p>
                  <p className="text-base leading-relaxed">Dnes tu nemusíš nic dokazovat.</p>
                  <p className="text-base leading-relaxed">Můžu být jen chvíli poblíž?</p>
                </>}
              </div>

              {thread ? (
                <div className="rounded-lg border border-border/20 bg-background/20 px-3 py-2 text-sm text-foreground/62 backdrop-blur-[2px]">
                  {stepPrompt}
                </div>
              ) : null}

              {!thread && (
                <div className="grid grid-cols-2 gap-2 pt-2">
                  {firstChoices.map((choice) => (
                    <Button key={choice} variant="secondary" onClick={() => enterPlayroom(choice)} disabled={opening} className="bg-card/58 text-foreground/78 backdrop-blur-sm">
                      {opening ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                      {choice}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          </div>

        {thread ? (
          <section className="mt-auto space-y-3 rounded-lg border border-border/25 bg-background/22 p-3 shadow-sm backdrop-blur-[2px]">
            <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
              {thread.messages.slice(1).map((message, index) => (
                <div key={`${index}-${message.role}`} className={message.role === "assistant" ? "mr-12 rounded-lg bg-secondary/24 p-3 text-sm text-secondary-foreground/66 backdrop-blur-[1px]" : "ml-12 rounded-lg bg-primary/34 p-3 text-sm text-primary-foreground/78 backdrop-blur-[1px]"}>
                  {contentText(message.content) || (saving && message.role === "assistant" ? "…" : "")}
                </div>
              ))}
            </div>
            <div className="space-y-2">
              <div className="flex gap-2">
                <Textarea value={reply} onChange={(event) => setReply(event.target.value)} placeholder="Napiš, nahraj hlas, video, fotku, screenshot nebo dokument." className="min-h-16 resize-none border-border/20 bg-background/18 text-foreground/68 placeholder:text-muted-foreground/50 backdrop-blur-[2px]" />
                <Button size="icon" onClick={() => sendReply(reply)} disabled={saving || uploads.attachments.some((attachment) => attachment.uploading) || (!reply.trim() && uploads.attachments.length === 0)} className="h-16 w-16 shrink-0 bg-primary/72 text-primary-foreground/90 backdrop-blur-[2px]" aria-label="Odeslat">
                  {saving ? <Loader2 className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
                </Button>
              </div>
              <input ref={photoInputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(event) => handlePickedFiles(event, "image")} />
              <input ref={videoInputRef} type="file" accept="video/*" capture="environment" className="hidden" onChange={(event) => handlePickedFiles(event, "video")} />
              <input ref={documentInputRef} type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.md,.json,.xml" multiple className="hidden" onChange={(event) => handlePickedFiles(event, "document")} />
            </div>
            {uploads.attachments.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {uploads.attachments.map((attachment) => (
                  <button key={attachment.id} type="button" onClick={() => uploads.removeAttachment(attachment.id)} className="inline-flex items-center gap-1.5 rounded-md border border-border/25 bg-background/24 px-2.5 py-1.5 text-xs text-foreground/70 backdrop-blur-[2px]">
                    <span>{attachmentLabel[attachment.category]}</span>
                    <span className="max-w-32 truncate">{attachment.name}</span>
                    {attachment.uploading ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => photoInputRef.current?.click()} disabled={saving} className="bg-background/30 text-foreground/72 backdrop-blur-[2px]"><ImageIcon className="mr-2 h-4 w-4" />Fotka</Button>
              <Button variant="secondary" onClick={() => videoInputRef.current?.click()} disabled={saving} className="bg-background/30 text-foreground/72 backdrop-blur-[2px]"><Video className="mr-2 h-4 w-4" />Video</Button>
              <Button variant="secondary" onClick={uploads.captureScreenshot} disabled={saving} className="bg-background/30 text-foreground/72 backdrop-blur-[2px]"><Camera className="mr-2 h-4 w-4" />Screenshot</Button>
              <Button variant="secondary" onClick={() => documentInputRef.current?.click()} disabled={saving} className="bg-background/30 text-foreground/72 backdrop-blur-[2px]"><FileText className="mr-2 h-4 w-4" />Dokument</Button>
              {recorder.state === "recording" ? <Button variant="secondary" onClick={recorder.stopRecording} className="bg-background/30 text-foreground/72 backdrop-blur-[2px]"><Square className="mr-2 h-4 w-4" />Zastavit hlas</Button> : <Button variant="secondary" onClick={recorder.startRecording} disabled={saving} className="bg-background/30 text-foreground/72 backdrop-blur-[2px]"><Mic className="mr-2 h-4 w-4" />Hlas</Button>}
              {recorder.state === "recorded" ? <Button variant="outline" onClick={attachRecording} className="bg-background/22 text-foreground/72 backdrop-blur-[2px]"><Mic className="mr-2 h-4 w-4" />Přiložit hlas</Button> : null}
              <Button onClick={() => sendReply(reply)} disabled={saving || uploads.attachments.some((attachment) => attachment.uploading) || (!reply.trim() && uploads.attachments.length === 0)} className="bg-primary/62 text-primary-foreground/88 backdrop-blur-[2px]"><Send className="mr-2 h-4 w-4" />Odeslat</Button>
              <Button variant="secondary" onClick={() => sendReply("Dnes nechci.")} disabled={saving}>Dnes nechci</Button>
              <Button variant="outline" onClick={onBack} disabled={saving}><XCircle className="mr-2 h-4 w-4" />Skončit</Button>
            </div>
          </section>
          ) : null}
        </div>
      </section>
    </div>
  );
};

export default DidKidsPlayroom;
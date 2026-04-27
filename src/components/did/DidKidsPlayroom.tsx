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

interface PlayroomProgressState {
  currentBlockIndex: number;
  completedBlockIndexes: number[];
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
const PLAYROOM_PROGRESS_MARKER_RE = /\[PLAYROOM_PROGRESS:(stay|advance|fallback|stop)\]/i;
const PREMATURE_CLOSING_RE = /(na[šs]e\s+sezen[íi]\s+v\s+hern[ěe]\s+.*kon[čc][íi]|pro\s+dne[sš]ek\s+(se\s+)?(lou[čc][íi]me|kon[čc][íi]me|budeme\s+lou[čc]it)|pomalou[čc]ku\s+se\s+.*lou[čc]it|p[řr]eju\s+ti\s+.*zbytek\s+dne|m[eě]j\s+se\s+moc\s+hezky|kdykoliv\s+bude[šs]\s+cht[íi]t,?\s+jsem\s+tady|jsem\s+moc\s+r[áa]d,?\s+[žz]e\s+jsme\s+.*dnes\s+.*na[šs]li|[čc]as\s+.*hern[uy]\s+zav[řr][íi]t|sezen[íi]\s+.*zav[řr][íi]t)/i;
const CONTINUE_PROGRAM_RE = /(nekon[čc][íi]|nekon[čc][íi]me|mus[íi]me\s+pokra[čc]ovat|pokra[čc]uj|pokra[čc]ovat|co\s+d[áa]l|zat[íi]m\s+jsme\s+ud[eě]lali\s+jen|jenom?\s+kous[íi]nek|podle\s+programu)/i;

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

const sanitizeAssistantForPlayroom = (value: string) => value.replace(PLAYROOM_PROGRESS_MARKER_RE, "").trim();

const progressCommandFrom = (value: string) => (value.match(PLAYROOM_PROGRESS_MARKER_RE)?.[1] || "stay").toLowerCase();

const isStopRequest = (value: string) => /(^|\b)(stop|kon[čc][íi]m|nechci\s+pokra[čc]ovat|dnes\s+nechci|sta[čc][íi]|ukon[čc]it)(\b|$)/i.test(value);

const buildProgressItems = (steps: any[], completedIndexes: number[]) => steps.map((step, index) => ({
  id: `playroom-${index + 1}`,
  text: `${step?.title || `Blok ${index + 1}`}${step?.duration_min ? ` (${step.duration_min}′)` : ""}`,
  done: completedIndexes.includes(index),
  observation: "",
}));

const nextProgressState = (progress: PlayroomProgressState, steps: any[], command: string, lastUserText: string): PlayroomProgressState => {
  if (!steps.length || command !== "advance" || isStopRequest(lastUserText)) return progress;
  const completed = Array.from(new Set([...progress.completedBlockIndexes, progress.currentBlockIndex])).sort((a, b) => a - b);
  const firstOpen = steps.findIndex((_, index) => !completed.includes(index));
  return { currentBlockIndex: firstOpen >= 0 ? firstOpen : Math.max(steps.length - 1, 0), completedBlockIndexes: completed };
};

const progressAfterChildAnswer = (progress: PlayroomProgressState, steps: any[], lastUserText: string): PlayroomProgressState => {
  if (!steps.length || isStopRequest(lastUserText)) return progress;
  const completed = Array.from(new Set([...progress.completedBlockIndexes, progress.currentBlockIndex])).sort((a, b) => a - b);
  const firstOpen = steps.findIndex((_, index) => !completed.includes(index));
  return { currentBlockIndex: firstOpen >= 0 ? firstOpen : Math.max(steps.length - 1, 0), completedBlockIndexes: completed };
};

const inferProgressFromThread = (steps: any[], messages: PlayroomThread["messages"], savedCompleted: number[]): PlayroomProgressState => {
  if (!steps.length) return { currentBlockIndex: 0, completedBlockIndexes: [] };
  if (savedCompleted.length) {
    const firstOpen = steps.findIndex((_, index) => !savedCompleted.includes(index));
    return { currentBlockIndex: firstOpen >= 0 ? firstOpen : Math.max(steps.length - 1, 0), completedBlockIndexes: savedCompleted };
  }
  const userTurns = messages.filter((message) => message.role === "user" && !isStopRequest(contentText(message.content))).length;
  const inferredCompleted = Array.from({ length: Math.min(userTurns, steps.length) }, (_, index) => index);
  const firstOpen = steps.findIndex((_, index) => !inferredCompleted.includes(index));
  return { currentBlockIndex: firstOpen >= 0 ? firstOpen : Math.max(steps.length - 1, 0), completedBlockIndexes: inferredCompleted };
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

const currentStepForThread = (plan: PlayroomPlanRow | null, currentThread?: PlayroomThread | null, progress?: PlayroomProgressState) => {
  const steps = getProgramSteps(plan);
  if (!steps.length) return null;
  if (progress) return steps[Math.min(Math.max(progress.currentBlockIndex, 0), steps.length - 1)];
  const userTurns = currentThread?.messages?.filter((message) => message.role === "user").length || 1;
  return steps[Math.min(Math.max(userTurns, 1) - 1, steps.length - 1)];
};

const planContract = (plan: PlayroomPlanRow | null, currentThread?: PlayroomThread | null, progress?: PlayroomProgressState) => {
  const steps = getProgramSteps(plan);
  const currentStep = currentStepForThread(plan, currentThread, progress);
  const completed = progress?.completedBlockIndexes || [];
  return `SCHVÁLENÝ PROGRAM HERNY PRO DNEŠEK — AKTIVNÍ, ODSOUHLASENÝ TERAPEUTKAMI.
PLAN_ID: ${plan?.id || "neznámý"}
ČÁST: ${plan?.selected_part || plan?.urgency_breakdown?.target_part || "neznámá"}
REVIEW_STATE: ${plan?.urgency_breakdown?.review_state || plan?.urgency_breakdown?.approval?.review_state || "neznámý"}
POVOLENÁ HLOUBKA: ${plan?.urgency_breakdown?.allowed_depth || plan?.urgency_breakdown?.playroom_plan?.allowed_depth || "check_in_only"}
JAZYK HERNY: čeština. Nepřepínej do norštiny/angličtiny bez výslovné žádosti dítěte nebo jasné souvislé cizojazyčné komunikace.

VLASTNÍ PROGRAM HERNY:
${plan?.urgency_breakdown?.playroom_plan ? JSON.stringify(plan.urgency_breakdown.playroom_plan, null, 2).slice(0, 5000) : "CHYBÍ — bez explicitního playroom_plan nesmí Karel použít plán terapeutického sezení jako program Herny."}

STRUKTUROVANÝ PROGRAM — POUŽIJ JAKO SKRYTÝ ŘÍDICÍ PLÁN, NEUKAZUJ DÍTĚTI:
${steps.length ? steps.map(stepLine).join("\n") : "Programové kroky Herny nejsou ve strukturovaných datech; nepřebírej plán Sezení. Zůstaň jen u bezpečného krátkého check-inu."}

STAV PRŮBĚHU:
- aktuální blok index: ${progress?.currentBlockIndex ?? 0} z ${Math.max(steps.length - 1, 0)}
- dokončené bloky indexy: ${completed.length ? completed.join(", ") : "žádné"}
- formální ukončení smí nastat jen tlačítkem „Ukončit hernu“, jasným stopem dítěte nebo bezpečnostním důvodem.

AKTUÁLNÍ BLOK TEĎ — DRŽ SE HO, DOKUD NENÍ SPLNĚNÝ:
${currentStep ? stepLine(currentStep) : "krok 1: bezpečný vstup a volba vzdálenosti"}

HERNA KONTRAKT PRO KARLA:
- Nejde o běžné vlákno. Vedeš strukturované terapeutické Herna sezení podle schváleného programu.
- V každé odpovědi zvol konkrétní další krok programu, ale ihned ho přizpůsob aktuálnímu stavu dítěte.
- Neukončuj Hernu sám. Neluč se a neříkej „pro dnešek“ mimo poslední blok a bez explicitního stopu dítěte.
- Pokud dítě mluví symbolicky o odchodu vzhůru / hvězdičce / Bohu, nejprve bezpečně ukotvi a pokračuj v aktuálním bloku; nepoužij to jako důvod k uzavření.
- Každá replika má mít: 1) naladění na odpověď nebo přílohu, 2) jemnou motivaci, 3) jednu konkrétní mikro-aktivitu / test / volbu A/B.
- Nesmíš být pasivní. Neptej se prázdně „co chceš dělat“. Veď, ale nech kontrolu dítěti.
- Odpověď má být krátká, konkrétní a profesionální: max 5 krátkých vět, vždy jeden krok, nikdy obecné povídání.
- Na úplný konec odpovědi přidej skrytou značku přesně v jednom tvaru: [PLAYROOM_PROGRESS:stay] pokud pokračuješ ve stejném bloku, [PLAYROOM_PROGRESS:advance] pokud je blok dostatečně splněný a příště má začít další, [PLAYROOM_PROGRESS:fallback] pokud se vracíš do bezpečí, [PLAYROOM_PROGRESS:stop] jen při jasném stopu/bezpečnostním stopu.
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

const getStepPrompt = (plan: PlayroomPlanRow | null, thread: PlayroomThread | null, progress?: PlayroomProgressState) => {
  const step = currentStepForThread(plan, thread, progress);
  return childSafe(step?.child_facing_prompt_draft) || "Mám být blíž, dál, nebo úplně potichu u dveří?";
};

const buildProgramContinuationReply = (plan: PlayroomPlanRow | null, progress: PlayroomProgressState, childAddress: string) => {
  const step = currentStepForThread(plan, null, progress);
  const prompt = childSafe(step?.child_facing_prompt_draft) || childSafe(step?.karel_response_strategy) || "Vyber jeden malý další krok: A) zůstaneme blízko u světla, B) světlo nám ukáže jedny bezpečné dveře.";
  return `Máš pravdu, ${childAddress}, nekončíme. Udělali jsme zatím jen kousínek a já se vracím k naší dnešní hře, krok po kroku. Teď nic nezavíráme ani nikam neodcházíme. ${prompt}`;
};

const DidKidsPlayroom = ({ onBack }: { onBack: () => void }) => {
  const [plan, setPlan] = useState<PlayroomPlanRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const [thread, setThread] = useState<PlayroomThread | null>(null);
  const [reply, setReply] = useState("");
  const [saving, setSaving] = useState(false);
  const [ending, setEnding] = useState(false);
  const [progress, setProgress] = useState<PlayroomProgressState>({ currentBlockIndex: 0, completedBlockIndexes: [] });
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
  const stepPrompt = useMemo(() => getStepPrompt(plan, thread), [plan, thread, progress]);

  const persistPlayroomProgress = useCallback(async (state: PlayroomProgressState, sourceThread: PlayroomThread | null, finalizedReason?: "completed" | "partial") => {
    if (!plan) return;
    const steps = getProgramSteps(plan);
    if (!steps.length) return;
    const { data: authData } = await supabase.auth.getUser();
    const userId = authData.user?.id;
    if (!userId) return;
    const now = new Date().toISOString();
    const messagesForAudit = sourceThread?.messages || [];
    const { error } = await (supabase as any).from("did_live_session_progress").upsert({
      user_id: userId,
      plan_id: plan.id,
      part_name: targetPart,
      therapist: "karel",
      items: buildProgressItems(steps, state.completedBlockIndexes),
      turns_by_block: { [state.currentBlockIndex]: messagesForAudit.map((message) => ({ from: message.role === "assistant" ? "karel" : "child", text: contentText(message.content) })) },
      artifacts_by_block: {},
      completed_blocks: state.completedBlockIndexes.length,
      total_blocks: steps.length,
      last_activity_at: now,
      finalized_at: finalizedReason ? now : null,
      finalized_reason: finalizedReason ?? null,
    }, { onConflict: "plan_id" });
    if (error) console.warn("[DidKidsPlayroom] progress sync failed", error);
  }, [plan, targetPart]);

  const loadApprovedPlan = useCallback(async () => {
    setLoading(true);
    try {
      let preferredPlanId: string | null = null;
      let preferredThreadId: string | null = null;
      try {
        preferredPlanId = sessionStorage.getItem("karel_playroom_plan_id");
        preferredThreadId = sessionStorage.getItem("karel_playroom_thread_id");
      } catch { /* ignore */ }

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
          && c.playroom_plan && typeof c.playroom_plan === "object"
          && c.approved_for_child_session === true
          && ["approved", "ready_to_start", "in_progress"].includes(row.program_status || c.review_state || c.approval?.review_state || "");
      });
      const selectedPlan = (preferredPlanId ? candidates.find((row) => row.id === preferredPlanId) : null) || candidates[0] || null;
      setPlan(selectedPlan);
      if (selectedPlan) {
        const { data: progressRow } = await (supabase as any)
          .from("did_live_session_progress")
          .select("items, completed_blocks")
          .eq("plan_id", selectedPlan.id)
          .maybeSingle();
        const completedIndexes = Array.isArray(progressRow?.items)
          ? progressRow.items.map((item: any, index: number) => item?.done ? index : -1).filter((index: number) => index >= 0)
          : [];
        const steps = getProgramSteps(selectedPlan);
        const firstOpen = steps.findIndex((_, index) => !completedIndexes.includes(index));
        setProgress({ currentBlockIndex: firstOpen >= 0 ? firstOpen : 0, completedBlockIndexes: completedIndexes });
      }

      if (preferredThreadId) {
        const { data: threadRow, error: threadError } = await (supabase as any)
          .from("did_threads")
          .select("id, messages")
          .eq("id", preferredThreadId)
          .eq("sub_mode", "karel_part_session")
          .maybeSingle();
        if (!threadError && threadRow) {
          setThread({
            id: threadRow.id,
            messages: ((threadRow.messages || []) as PlayroomThread["messages"]).map((message) => ({
              ...message,
              content: childSafe(contentText(message.content)) || "Jsem tady. Můžeme zůstat potichu.",
            })),
          });
        }
      }
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
      await persistPlayroomProgress(progress, loadedThread);
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
        didInitialContext: planContract(plan, currentThread, progress),
      };
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-chat`, { method: "POST", headers, body: JSON.stringify(body) });
      if (!response.ok) handleApiError(response);
      if (!response.body) throw new Error("Karel neodpověděl.");
      const assistantContent = await parseSSEStream(response.body, (partial) => {
        setThread((prev) => prev ? { ...prev, messages: [...nextMessages, { role: "assistant", content: childSafe(partial) || partial }] } : prev);
      });
      const command = progressCommandFrom(assistantContent);
      const sanitizedAiContent = sanitizeAssistantForPlayroom(assistantContent);
      const steps = getProgramSteps(plan);
      const isLastBlock = progress.currentBlockIndex >= Math.max(steps.length - 1, 0);
      const lastUserText = contentText(userContent);
      const wantsProgramContinuation = CONTINUE_PROGRAM_RE.test(lastUserText) && !isStopRequest(lastUserText);
      const prematureClose = (PREMATURE_CLOSING_RE.test(sanitizedAiContent) || wantsProgramContinuation) && !isLastBlock && !isStopRequest(lastUserText);
      const safeAssistantContent = prematureClose
        ? buildProgramContinuationReply(plan, progress, childAddress)
        : childSafe(sanitizedAiContent) || sanitizedAiContent || PLAYROOM_TECH_FALLBACK;
      const savedMessages = [...nextMessages, { role: "assistant" as const, content: safeAssistantContent }];
      const { error } = await (supabase as any).from("did_threads").update({ messages: savedMessages, last_activity_at: new Date().toISOString(), is_processed: false }).eq("id", currentThread.id);
      if (error) throw error;
      const nextThread = { ...currentThread, messages: savedMessages };
      const nextState = nextProgressState(progress, steps, prematureClose ? "stay" : command, lastUserText);
      setProgress(nextState);
      await persistPlayroomProgress(nextState, nextThread);
      setThread(nextThread);
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

  const endPlayroom = async () => {
    if (!plan || !thread || ending) return;
    setEnding(true);
    try {
      const userTurns = thread.messages.filter((message) => message.role === "user").length;
      const totalBlocks = Math.max(getProgramSteps(plan).length, 1);
      const completedBlocks = Math.min(progress.completedBlockIndexes.length || userTurns, totalBlocks);
      await persistPlayroomProgress(progress, thread, completedBlocks >= totalBlocks ? "completed" : "partial");
      const { data, error } = await supabase.functions.invoke("karel-did-session-evaluate", {
        body: {
          planId: plan.id,
          completedBlocks,
          totalBlocks,
          endedReason: completedBlocks >= totalBlocks ? "completed" : "partial",
          turnsByBlock: { 0: thread.messages.map((message) => ({ from: message.role === "assistant" ? "karel" : "hana", text: contentText(message.content) })) },
          observationsByBlock: { 0: "Herna ukončena tlačítkem v dětském režimu; vyhodnoť pouze skutečné zprávy a přílohy v transcriptu." },
        },
      });
      if (error) throw error;
      if ((data as any)?.ok === false) throw new Error((data as any)?.error || "Vyhodnocení Herny selhalo.");
      toast.success("Herna je ukončená. Karel ji zahrne do zítřejšího přehledu.");
      onBack();
    } catch (error: any) {
      console.error("[DidKidsPlayroom] end failed", error);
      toast.error(error?.message || "Herna se nepodařila vyhodnotit, ale záznam zůstává uložený.");
    } finally {
      setEnding(false);
    }
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
              <Button variant="outline" onClick={endPlayroom} disabled={saving || ending}><XCircle className="mr-2 h-4 w-4" />{ending ? "Ukončuji" : "Ukončit hernu"}</Button>
            </div>
          </section>
          ) : null}
        </div>
      </section>
    </div>
  );
};

export default DidKidsPlayroom;
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Loader2, Mic, Paperclip, Send, Square, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { getAuthHeaders } from "@/lib/auth";
import { pragueTodayISO } from "@/lib/dateOnlyTaskHelpers";
import { toast } from "sonner";
import tundrupekPlayroomBg from "@/assets/tundrupek-playroom-bg.jpg";
import UniversalAttachmentBar from "@/components/UniversalAttachmentBar";
import { buildAttachmentContent, useUniversalUpload, type PendingAttachment } from "@/hooks/useUniversalUpload";
import { handleApiError, parseSSEStream } from "@/lib/chatHelpers";
import { useAudioRecorder } from "@/hooks/useAudioRecorder";

const PREFERRED_PLAN_ID = "8d2deb4f-4e9e-48a2-8abc-c3f5be8d7914";

interface PlayroomPlanRow {
  id: string;
  selected_part: string;
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

const getRoomBackground = (partName: string) => {
  if (partName.toLocaleUpperCase("cs-CZ") === "TUNDRUPEK") return tundrupekPlayroomBg;
  return tundrupekPlayroomBg;
};

const contentText = (content: any) => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => part?.text || (part?.image_url ? "Přiložený obrázek" : "Příloha")).filter(Boolean).join("\n");
  return "";
};

const getRoomTone = (plan: PlayroomPlanRow | null, thread: PlayroomThread | null) => {
  const raw = `${plan?.urgency_breakdown?.readiness_today || ""} ${plan?.urgency_breakdown?.playroom_theme || ""} ${contentText(thread?.messages?.at(-1)?.content)}`.toLocaleLowerCase("cs-CZ");
  if (/nejde|ticho|stop|unaven|strach|red|kriz/.test(raw)) return "quiet";
  if (/jde|hra|zvědav|aktiv|green|kontakt/.test(raw)) return "open";
  return "listening";
};

const DidKidsPlayroom = ({ onBack }: { onBack: () => void }) => {
  const [plan, setPlan] = useState<PlayroomPlanRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const [thread, setThread] = useState<PlayroomThread | null>(null);
  const [reply, setReply] = useState("");
  const [saving, setSaving] = useState(false);

  const targetPart = plan?.selected_part || plan?.urgency_breakdown?.target_part || "";
  const childAddress = useMemo(() => getChildAddress(targetPart), [targetPart]);
  const roomBackground = useMemo(() => getRoomBackground(targetPart), [targetPart]);

  const loadApprovedPlan = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await (supabase as any)
        .from("did_daily_session_plans")
        .select("id, selected_part, urgency_breakdown, created_at")
        .eq("plan_date", pragueTodayISO())
        .order("created_at", { ascending: false });
      if (error) throw error;

      const candidates = ((data as PlayroomPlanRow[]) || []).filter((row) => {
        const c = row.urgency_breakdown || {};
        return c.session_actor === "karel_direct"
          && c.lead_entity === "karel"
          && c.ui_surface === "did_kids_playroom"
          && c.approved_for_child_session === true;
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
      const loadedThread = { id: data.id, messages: ((data.messages || []) as PlayroomThread["messages"]).map((message) => ({ ...message, content: childSafe(message.content) || "Jsem tady. Můžeme zůstat potichu." })) };
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

  const saveReply = async (currentThread: PlayroomThread, content: string) => {
    if (!content.trim()) return;
    setSaving(true);
    const nextMessages: PlayroomThread["messages"] = [
      ...currentThread.messages,
      { role: "user", content: content.trim() },
      { role: "assistant", content: "Děkuju. Můžeme zůstat jen u tohohle a nemusíme nikam spěchat. Chceš ještě jedno slovo, barvu, nebo dnes končíme?" },
    ];
    try {
      const { error } = await (supabase as any)
        .from("did_threads")
        .update({ messages: nextMessages, last_activity_at: new Date().toISOString(), is_processed: false })
        .eq("id", currentThread.id);
      if (error) throw error;
      setThread({ ...currentThread, messages: nextMessages });
      setReply("");
    } catch (error) {
      console.error("[DidKidsPlayroom] message save failed", error);
      toast.error("Odpověď se nepodařilo uložit.");
    } finally {
      setSaving(false);
    }
  };

  const sendReply = async (content: string) => {
    if (!thread) return;
    await saveReply(thread, content);
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
        <div className="absolute inset-0 bg-background/20" />
        <div className="relative z-10 mx-auto flex min-h-[calc(100vh-6.5rem)] max-w-3xl flex-col space-y-4">
          <Button variant="secondary" size="sm" onClick={onBack} className="w-fit bg-background/75 backdrop-blur-sm"><ArrowLeft className="mr-2 h-4 w-4" />Zpět</Button>

          <header className="space-y-1 text-center drop-shadow-sm">
            <h1 className="text-3xl font-serif text-foreground">Herna</h1>
          </header>

          <div className="flex flex-1 items-center justify-center pb-10 pt-4">
            <div className="w-full max-w-md space-y-4 rounded-lg border border-border/70 bg-background/72 p-5 text-center shadow-sm backdrop-blur-md">
              <div className="space-y-3">
                <p className="text-base leading-relaxed text-foreground">Ahoj, {childAddress}.</p>
                <p className="text-base leading-relaxed text-foreground">Dnes tu nemusíš nic dokazovat.</p>
                <p className="text-base leading-relaxed text-foreground">Můžu být jen chvíli poblíž?</p>
              </div>

              {!thread && (
                <div className="grid grid-cols-2 gap-2 pt-2">
                  {firstChoices.map((choice) => (
                    <Button key={choice} variant="secondary" onClick={() => enterPlayroom(choice)} disabled={opening} className="bg-card/85 backdrop-blur-sm">
                      {opening ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                      {choice}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          </div>

        {thread ? (
          <section className="space-y-3 rounded-lg border border-border/70 bg-background/78 p-4 shadow-sm backdrop-blur-md">
            <div className="space-y-3">
              {thread.messages.map((message, index) => (
                <div key={`${index}-${message.role}`} className={message.role === "assistant" ? "mr-8 rounded-lg bg-secondary p-3 text-sm text-secondary-foreground" : "ml-8 rounded-lg bg-primary p-3 text-sm text-primary-foreground"}>
                  {message.content}
                </div>
              ))}
            </div>
            <Textarea value={reply} onChange={(event) => setReply(event.target.value)} placeholder="Můžeš napsat jedno slovo, barvu, nebo jen jde to / nejde to / nevím." className="min-h-24 resize-none" />
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => sendReply(reply)} disabled={saving || !reply.trim()}><Send className="mr-2 h-4 w-4" />Odpovědět</Button>
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
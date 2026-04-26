import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Loader2, Send, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { getAuthHeaders } from "@/lib/auth";
import { pragueTodayISO } from "@/lib/dateOnlyTaskHelpers";
import { toast } from "sonner";

const PREFERRED_PLAN_ID = "8d2deb4f-4e9e-48a2-8abc-c3f5be8d7914";

interface PlayroomPlanRow {
  id: string;
  selected_part: string;
  urgency_breakdown: Record<string, any>;
  created_at?: string;
}

interface PlayroomThread {
  id: string;
  messages: { role: "user" | "assistant"; content: string }[];
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

const DidKidsPlayroom = ({ onBack }: { onBack: () => void }) => {
  const [plan, setPlan] = useState<PlayroomPlanRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const [thread, setThread] = useState<PlayroomThread | null>(null);
  const [reply, setReply] = useState("");
  const [saving, setSaving] = useState(false);

  const targetPart = plan?.selected_part || plan?.urgency_breakdown?.target_part || "";
  const childAddress = useMemo(() => getChildAddress(targetPart), [targetPart]);

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
    <div className="min-h-full bg-background px-4 py-5">
      <div className="mx-auto max-w-3xl space-y-4">
        <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft className="mr-2 h-4 w-4" />Zpět</Button>

        <header className="space-y-1 text-center">
          <h1 className="text-3xl font-serif text-foreground">Herna</h1>
          <p className="text-sm text-muted-foreground">Dnes je tu místo pro {targetPart}</p>
        </header>

        <section className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
          <div className="relative min-h-[18rem] p-5 sm:p-7">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_18%,hsl(var(--primary)/0.22),transparent_38%),linear-gradient(180deg,hsl(var(--secondary)/0.72),hsl(var(--background)))]" />
            <div className="relative z-10 space-y-5">
              <div className="mx-auto h-20 w-20 rounded-full border border-primary/35 bg-primary/15 shadow-[0_0_42px_hsl(var(--primary)/0.32)]" aria-label="klidné modré světýlko" />
              <div className="rounded-lg border border-border/70 bg-background/70 p-4 backdrop-blur-sm">
                <p className="text-sm leading-relaxed text-foreground">
                  {themeSource === "confirmed_part_card" ? "Je tu" : "Může tu být"} {themeText}.
                </p>
                <p className="mt-2 text-sm text-muted-foreground">Je tu i volné místo pro symbol, který si {targetPart} vybere až tady.</p>
              </div>

              {(openingScene || safeObjects.length > 0 || symbols.length > 0 || exitSymbol) && (
                <div className="grid gap-3 sm:grid-cols-2">
                  {openingScene && <RoomTile icon={<Sparkles className="h-4 w-4" />} text={openingScene} />}
                  {safeObjects.map((item) => <RoomTile key={item} text={item} />)}
                  {symbols.map((item) => <RoomTile key={item} text={item} />)}
                  {exitSymbol && <RoomTile icon={<DoorOpen className="h-4 w-4" />} text={exitSymbol} />}
                </div>
              )}
            </div>
          </div>
        </section>

        {!thread ? (
          <div className="flex justify-center">
            <Button onClick={enterPlayroom} disabled={opening} className="min-w-44">
              {opening ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <DoorOpen className="mr-2 h-4 w-4" />}
              Vstup do herny
            </Button>
          </div>
        ) : (
          <section className="space-y-3 rounded-lg border border-border bg-card p-4 shadow-sm">
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
        )}
      </div>
    </div>
  );
};

const RoomTile = ({ text, icon }: { text: string; icon?: React.ReactNode }) => (
  <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-background/60 px-3 py-2 text-sm text-foreground backdrop-blur-sm">
    {icon || <span className="h-2 w-2 rounded-full bg-primary/70" />}
    <span>{text}</span>
  </div>
);

export default DidKidsPlayroom;
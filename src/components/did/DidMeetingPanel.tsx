import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ArrowLeft, Send, Loader2, Users, CheckCircle2, Plus } from "lucide-react";
import ThemeQuickButton from "@/components/ThemeQuickButton";
import { supabase } from "@/integrations/supabase/client";
import { getAuthHeaders } from "@/lib/auth";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";

interface Meeting {
  id: string;
  topic: string;
  agenda: string;
  status: string;
  messages: any[];
  created_at: string;
  hanka_joined_at: string | null;
  kata_joined_at: string | null;
  finalized_at: string | null;
  outcome_summary: string;
  outcome_tasks: any[];
}

interface Props {
  meetingId?: string | null;
  therapist: "hanka" | "kata";
  onBack: () => void;
}

const DidMeetingPanel = ({ meetingId: initialMeetingId, therapist, onBack }: Props) => {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [activeMeeting, setActiveMeeting] = useState<Meeting | null>(null);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [showNewMeeting, setShowNewMeeting] = useState(false);
  const [newTopic, setNewTopic] = useState("");
  const [newAgenda, setNewAgenda] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (initialMeetingId) {
      loadMeeting(initialMeetingId);
    } else {
      loadMeetings();
    }
  }, [initialMeetingId]);

  // ── Realtime subscription for active meeting ──
  useEffect(() => {
    if (!activeMeeting?.id) return;

    const channel = supabase
      .channel(`meeting-${activeMeeting.id}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "did_meetings",
          filter: `id=eq.${activeMeeting.id}`,
        },
        (payload) => {
          const updated = payload.new as any;
          setActiveMeeting(prev => {
            if (!prev) return prev;
            return {
              ...prev,
              messages: Array.isArray(updated.messages) ? updated.messages : prev.messages,
              status: updated.status || prev.status,
              hanka_joined_at: updated.hanka_joined_at ?? prev.hanka_joined_at,
              kata_joined_at: updated.kata_joined_at ?? prev.kata_joined_at,
              finalized_at: updated.finalized_at ?? prev.finalized_at,
              outcome_summary: updated.outcome_summary ?? prev.outcome_summary,
              outcome_tasks: updated.outcome_tasks ?? prev.outcome_tasks,
            };
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [activeMeeting?.id]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [activeMeeting?.messages]);

  const callMeetingApi = async (body: any) => {
    const headers = await getAuthHeaders();
    const resp = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-meeting`,
      { method: "POST", headers, body: JSON.stringify(body) }
    );
    if (!resp.ok) throw new Error(`API error: ${resp.status}`);
    return resp.json();
  };

  const loadMeetings = async () => {
    setIsLoading(true);
    try {
      const data = await callMeetingApi({ action: "list" });
      setMeetings(data.meetings || []);
    } catch (e) {
      console.error("Load meetings error:", e);
    } finally {
      setIsLoading(false);
    }
  };

  const loadMeeting = async (id: string) => {
    setIsLoading(true);
    try {
      const data = await callMeetingApi({ action: "get", meetingId: id });
      if (data.meeting) {
        setActiveMeeting(data.meeting);
      }
    } catch (e) {
      console.error("Load meeting error:", e);
      toast.error("Nepodařilo se načíst poradu.");
    } finally {
      setIsLoading(false);
    }
  };

  const sendMessage = async () => {
    if (!input.trim() || !activeMeeting) return;
    setIsSending(true);
    try {
      const data = await callMeetingApi({
        action: "post_message",
        meetingId: activeMeeting.id,
        message: input.trim(),
        therapist,
      });
      if (data.success) {
        setActiveMeeting(prev => prev ? { ...prev, messages: data.messages } : prev);
        setInput("");
      }
    } catch (e) {
      console.error("Send message error:", e);
      toast.error("Nepodařilo se odeslat příspěvek.");
    } finally {
      setIsSending(false);
    }
  };

  const finalizeMeeting = async () => {
    if (!activeMeeting) return;
    setIsFinalizing(true);
    try {
      const data = await callMeetingApi({
        action: "finalize",
        meetingId: activeMeeting.id,
      });
      if (data.success) {
        toast.success("Porada uzavřena. Úkoly přidány do nástěnky.");
        setActiveMeeting(prev => prev ? {
          ...prev,
          status: "finalized",
          outcome_summary: data.summary,
          outcome_tasks: data.tasks,
        } : prev);
      }
    } catch (e) {
      console.error("Finalize error:", e);
      toast.error("Nepodařilo se uzavřít poradu.");
    } finally {
      setIsFinalizing(false);
    }
  };

  const createMeeting = async () => {
    if (!newTopic.trim()) return;
    setIsLoading(true);
    try {
      const data = await callMeetingApi({
        action: "create",
        message: newTopic.trim(),
        therapist: newAgenda.trim(),
      });
      if (data.success && data.meeting) {
        setActiveMeeting(data.meeting);
        setShowNewMeeting(false);
        setNewTopic("");
        setNewAgenda("");
        toast.success("Porada vytvořena, pozvánky odeslány.");
      }
    } catch (e) {
      console.error("Create meeting error:", e);
      toast.error("Nepodařilo se vytvořit poradu.");
    } finally {
      setIsLoading(false);
    }
  };

  // ═══ MEETING LIST VIEW ═══
  if (!activeMeeting && !showNewMeeting) {
    const openMeetings = meetings.filter(m => m.status === "open");
    const closedMeetings = meetings.filter(m => m.status === "finalized");

    return (
      <div className="max-w-2xl mx-auto px-3 sm:px-4 py-4">
        <div className="flex items-center justify-between mb-4">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft className="w-4 h-4 mr-1" /> Zpět
          </Button>
          <div className="flex items-center gap-1.5">
            <ThemeQuickButton />
            <Button size="sm" onClick={() => setShowNewMeeting(true)}>
              <Plus className="w-4 h-4 mr-1" /> Nová porada
            </Button>
          </div>
        </div>

        <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
          <Users className="w-4 h-4 text-primary" /> Porady týmu
        </h3>

        {isLoading && (
          <div className="flex justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        )}

        {!isLoading && openMeetings.length === 0 && closedMeetings.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-8">
            Zatím neproběhla žádná porada.
          </p>
        )}

        {openMeetings.length > 0 && (
          <div className="mb-4">
            <p className="text-xs font-medium text-muted-foreground mb-2">🔴 Otevřené</p>
            {openMeetings.map(m => (
              <button
                key={m.id}
                onClick={() => loadMeeting(m.id)}
                className="w-full text-left p-3 rounded-lg border border-border bg-card hover:border-primary/50 transition-all mb-2"
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-foreground">{m.topic}</span>
                  <Badge variant="destructive" className="text-[10px] h-5">Otevřená</Badge>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  {new Date(m.created_at).toLocaleString("cs-CZ", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                  {" · "}{Array.isArray(m.messages) ? m.messages.length : 0} příspěvků
                  {m.hanka_joined_at && " · Hanka ✓"}
                  {m.kata_joined_at && " · Káťa ✓"}
                </p>
              </button>
            ))}
          </div>
        )}

        {closedMeetings.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">✅ Uzavřené</p>
            {closedMeetings.slice(0, 5).map(m => (
              <button
                key={m.id}
                onClick={() => loadMeeting(m.id)}
                className="w-full text-left p-3 rounded-lg border border-border bg-card/50 hover:border-primary/30 transition-all mb-2 opacity-70"
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-foreground">{m.topic}</span>
                  <Badge variant="secondary" className="text-[10px] h-5">Uzavřená</Badge>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  {m.finalized_at ? new Date(m.finalized_at).toLocaleString("cs-CZ", { day: "numeric", month: "short" }) : ""}
                </p>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ═══ NEW MEETING FORM ═══
  if (showNewMeeting) {
    return (
      <div className="max-w-2xl mx-auto px-3 sm:px-4 py-4">
        <div className="mb-4 flex items-center justify-between gap-2">
          <Button variant="ghost" size="sm" onClick={() => setShowNewMeeting(false)}>
            <ArrowLeft className="w-4 h-4 mr-1" /> Zpět na seznam
          </Button>
          <ThemeQuickButton />
        </div>

        <h3 className="text-sm font-semibold text-foreground mb-4">Nová porada</h3>

        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Téma porady</label>
            <Textarea
              value={newTopic}
              onChange={e => setNewTopic(e.target.value)}
              placeholder="O čem chceš jednat?"
              className="min-h-[60px] text-sm"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Agenda (volitelné)</label>
            <Textarea
              value={newAgenda}
              onChange={e => setNewAgenda(e.target.value)}
              placeholder="Body k projednání..."
              className="min-h-[80px] text-sm"
            />
          </div>
          <Button onClick={createMeeting} disabled={!newTopic.trim() || isLoading} className="w-full">
            {isLoading ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Users className="w-4 h-4 mr-1" />}
            Vytvořit poradu a pozvat tým
          </Button>
        </div>
      </div>
    );
  }

  // ═══ ACTIVE MEETING VIEW ═══
  const msgs = Array.isArray(activeMeeting?.messages) ? activeMeeting.messages : [];

  return (
    <div className="flex flex-col h-full max-w-2xl mx-auto">
      {/* Header */}
      <div className="px-3 sm:px-4 py-3 border-b border-border bg-card/50">
        <div className="flex items-center justify-between">
          <Button variant="ghost" size="sm" onClick={() => setActiveMeeting(null)}>
            <ArrowLeft className="w-4 h-4 mr-1" /> Porady
          </Button>
          <div className="flex items-center gap-2">
            <ThemeQuickButton />
            {activeMeeting?.hanka_joined_at && <Badge variant="outline" className="text-[10px] h-5 border-pink-500/30 text-pink-600">Hanka ✓</Badge>}
            {activeMeeting?.kata_joined_at && <Badge variant="outline" className="text-[10px] h-5 border-blue-500/30 text-blue-600">Káťa ✓</Badge>}
            {activeMeeting?.status === "finalized" && <Badge className="text-[10px] h-5 bg-green-600">Uzavřená</Badge>}
          </div>
        </div>
        <h3 className="text-sm font-semibold text-foreground mt-1">{activeMeeting?.topic}</h3>
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1 px-3 sm:px-4 py-3" ref={scrollRef}>
        <div className="space-y-3">
          {msgs.map((m: any, i: number) => {
            const isKarel = m.therapist === "karel";
            const isMe = m.therapist === therapist;
            const name = isKarel ? "Karel" : m.therapist === "hanka" ? "Hanička" : "Káťa";
            const bgClass = isKarel
              ? "bg-primary/10 border-primary/20"
              : isMe
                ? "bg-card border-border"
                : "bg-muted/50 border-muted";

            return (
              <div key={i} className={`rounded-lg border p-3 ${bgClass}`}>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-semibold text-foreground">{name}</span>
                  <span className="text-[10px] text-muted-foreground">
                    {new Date(m.timestamp).toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>
                <div className="text-sm text-foreground/90 prose prose-sm dark:prose-invert max-w-none">
                  <ReactMarkdown>{m.content}</ReactMarkdown>
                </div>
              </div>
            );
          })}
        </div>

        {/* Finalized outcome */}
        {activeMeeting?.status === "finalized" && activeMeeting.outcome_summary && (
          <div className="mt-4 rounded-lg border-2 border-green-500/30 bg-green-500/5 p-4">
            <h4 className="text-xs font-semibold text-foreground flex items-center gap-1.5 mb-2">
              <CheckCircle2 className="w-4 h-4 text-green-600" /> Výstup porady
            </h4>
            <div className="text-sm text-foreground/90 prose prose-sm dark:prose-invert max-w-none">
              <ReactMarkdown>{activeMeeting.outcome_summary}</ReactMarkdown>
            </div>
            {Array.isArray(activeMeeting.outcome_tasks) && activeMeeting.outcome_tasks.length > 0 && (
              <div className="mt-3 pt-3 border-t border-green-500/20">
                <p className="text-xs font-medium text-muted-foreground mb-1">Úkoly přidány do nástěnky:</p>
                {activeMeeting.outcome_tasks.map((t: any, i: number) => (
                  <p key={i} className="text-xs text-foreground/80">
                    ► {t.task} <span className="text-muted-foreground">({t.assigned_to})</span>
                  </p>
                ))}
              </div>
            )}
          </div>
        )}
      </ScrollArea>

      {/* Input (only if meeting is open) */}
      {activeMeeting?.status === "open" && (
        <div className="px-3 sm:px-4 py-3 border-t border-border bg-card/50">
          <div className="flex gap-2">
            <Textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder={`Tvůj příspěvek k poradě (${therapist === "hanka" ? "Hanička" : "Káťa"})...`}
              className="min-h-[60px] text-sm flex-1"
              onKeyDown={e => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendMessage();
                }
              }}
            />
            <div className="flex flex-col gap-2">
              <Button size="sm" onClick={sendMessage} disabled={!input.trim() || isSending}>
                {isSending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              </Button>
              {activeMeeting.hanka_joined_at && activeMeeting.kata_joined_at && (
                <Button size="sm" variant="outline" onClick={finalizeMeeting} disabled={isFinalizing} className="text-[10px] h-7">
                  {isFinalizing ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default DidMeetingPanel;

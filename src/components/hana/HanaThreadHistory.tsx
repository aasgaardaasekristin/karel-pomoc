import { useState, useEffect, useCallback } from "react";
import { History, Trash2, MessageCircle, Plus, Database, Loader2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useAuthReady } from "@/hooks/useAuthReady";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface HanaThread {
  id: string;
  isActive: boolean;
  lastActivityAt: string;
  startedAt: string;
  preview: string;
  threadLabel: string;
  messageCount: number;
}

interface Props {
  currentConversationId: string | null;
  onSwitchThread: (threadId: string, messages: { role: string; content: string }[]) => void;
  onNewThread: () => void;
  onMirrorToDrive: () => Promise<void>;
}

const getTopicLabel = (thread: HanaThread): string => {
  const base = thread.threadLabel?.trim() || thread.preview?.trim();
  if (!base) return "Nová konverzace";
  const sentence = base.split(/[.!?\n]/)[0].trim();
  return sentence.length > 50 ? sentence.slice(0, 47) + "…" : sentence;
};

const formatDate = (isoStr: string) => {
  return new Date(isoStr).toLocaleDateString("cs-CZ", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const HanaThreadHistory = ({ currentConversationId, onSwitchThread, onNewThread, onMirrorToDrive }: Props) => {
  const [threads, setThreads] = useState<HanaThread[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<HanaThread | null>(null);
  const [isMirroring, setIsMirroring] = useState(false);
  const [hasFetchedThreads, setHasFetchedThreads] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const { isAuthReady, session, authEventCount } = useAuthReady();
  const PAGE_SIZE = 20;

  useEffect(() => {
    console.warn(`[F15-debug] Auth state: ready=${isAuthReady}, session=${session ? "exists" : "null"}`);
  }, [isAuthReady, session]);

  const fetchThreads = useCallback(async (trigger: "mount" | "auth_event" | "retry", offset = 0, append = false) => {
    console.warn(`[F15-debug] Fetch triggered: authReady=${isAuthReady}, trigger=${trigger}`);

    if (!isAuthReady) return;

    if (!session) {
      setHasFetchedThreads(false);
      return;
    }

    const { data, error } = await supabase
      .from("karel_hana_conversations")
      .select("id, is_active, last_activity_at, started_at, preview, thread_label, message_count")
      .order("last_activity_at", { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) {
      console.error("[HanaThreadHistory] Fetch error:", error);
      return;
    }

    console.warn(`[F15-debug] Fetch result: rows=${data?.length ?? 0}, sessionExists=${session ? "true" : "false"}`);

    if (data) {
      setHasFetchedThreads(true);
      setHasMore(data.length === PAGE_SIZE);
      const mapped = data.map(r => ({
        id: r.id,
        isActive: r.is_active,
        lastActivityAt: r.last_activity_at,
        startedAt: r.started_at,
        preview: r.preview ?? "",
        threadLabel: r.thread_label ?? "",
        messageCount: r.message_count ?? 0,
      }));
      setThreads(prev => append ? [...prev, ...mapped] : mapped);
    }
  }, [isAuthReady, session]);

  useEffect(() => {
    if (!isAuthReady || !session) return;
    void fetchThreads("retry");
  }, [isAuthReady, session, fetchThreads]);

  useEffect(() => {
    if (!isAuthReady) return;

    if (!session) {
      setThreads([]);
      setHasFetchedThreads(false);
      setHasMore(false);
      return;
    }

    void fetchThreads(authEventCount > 0 ? "auth_event" : "mount");

    const channel = supabase
      .channel(`hana_threads_realtime_${authEventCount}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "karel_hana_conversations" },
        () => { void fetchThreads("retry"); }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [isAuthReady, session, authEventCount, fetchThreads]);

  const handleDeleteClick = (e: React.MouseEvent, thread: HanaThread) => {
    e.stopPropagation();
    setDeleteTarget(thread);
  };

  const handleMirrorThenDelete = async () => {
    if (!deleteTarget) return;
    setIsMirroring(true);
    try {
      await onMirrorToDrive();
      await supabase.from("karel_hana_conversations").delete().eq("id", deleteTarget.id);
      setThreads(prev => prev.filter(t => t.id !== deleteTarget.id));
      setDeleteTarget(null);
    } finally {
      setIsMirroring(false);
    }
  };

  const handleDeleteWithout = async () => {
    if (!deleteTarget) return;
    await supabase.from("karel_hana_conversations").delete().eq("id", deleteTarget.id);
    setThreads(prev => prev.filter(t => t.id !== deleteTarget.id));
    if (deleteTarget.id === currentConversationId) {
      onNewThread();
    }
    setDeleteTarget(null);
  };

  const handleSelectThread = async (thread: HanaThread) => {
    const { data, error } = await supabase
      .from("karel_hana_conversations")
      .select("messages")
      .eq("id", thread.id)
      .single();

    if (error) {
      console.error("[HanaThreadHistory] Load thread error:", error);
      return;
    }

    onSwitchThread(thread.id, ((data?.messages ?? []) as { role: string; content: string }[]));
  };

  const handleLoadMore = async () => {
    if (isFetchingMore || !hasMore) return;
    setIsFetchingMore(true);
    try {
      await fetchThreads("retry", threads.length, true);
    } finally {
      setIsFetchingMore(false);
    }
  };

  const meaningfulThreads = threads.filter(t => t.messageCount > 1 || t.preview.trim().length > 0);

  return (
    <>
      <div className="rounded-2xl border border-border bg-card/80 px-4 py-4 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-medium text-foreground flex items-center gap-2">
            <History className="w-4 h-4 text-primary" />
            Vlákna konverzací
          </h3>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={onNewThread}
              className="h-8 text-xs gap-1.5 rounded-xl"
            >
              <Plus className="w-3.5 h-3.5" />
              Nové vlákno
            </Button>
          </div>
        </div>

        {!isAuthReady || (session && !hasFetchedThreads) ? (
          <div className="rounded-xl border border-dashed border-border bg-muted/30 px-4 py-6 text-sm text-muted-foreground text-center">
            Načítám vlákna…
          </div>
        ) : meaningfulThreads.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-muted/30 px-4 py-6 text-sm text-muted-foreground text-center">
            Zatím žádná vlákna. Začni novou konverzaci.
          </div>
        ) : (
          <div className="space-y-2">
            <div className="space-y-1.5 max-h-[24rem] overflow-y-auto pr-1">
              {meaningfulThreads.map(thread => {
                const isCurrent = thread.id === currentConversationId;
                return (
                  <div
                    key={thread.id}
                    className={`flex items-center gap-3 px-3 py-2.5 rounded-xl cursor-pointer transition-colors group ${
                      isCurrent
                        ? "bg-primary/8 border border-primary/20"
                        : "hover:bg-muted/50 border border-transparent"
                    }`}
                    onClick={() => !isCurrent && void handleSelectThread(thread)}
                  >
                    <MessageCircle className="w-4 h-4 text-primary/60 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-foreground truncate leading-snug">
                        {getTopicLabel(thread)}
                      </div>
                      <div className="text-[0.6875rem] text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span>{formatDate(thread.startedAt)}</span>
                        <span>{thread.messageCount} zpráv</span>
                        {isCurrent && <span className="text-primary font-medium">● aktivní</span>}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                      onClick={(e) => handleDeleteClick(e, thread)}
                    >
                      <Trash2 className="w-3.5 h-3.5 text-destructive" />
                    </Button>
                  </div>
                );
              })}
            </div>

            {hasMore && (
              <div className="flex justify-center pt-1">
                <Button variant="outline" size="sm" className="rounded-xl" disabled={isFetchingMore} onClick={() => void handleLoadMore()}>
                  {isFetchingMore ? <Loader2 className="animate-spin" /> : null}
                  Načíst další
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent className="rounded-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-amber-500" />
              Smazat vlákno?
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-3">
              <p>
                Haničko, chceš, aby si Karel toto vlákno <strong>zapamatoval</strong>?
              </p>
              <p className="text-sm">
                Pokud ano, klikni na <strong>„Zrcadlit a smazat"</strong> – Karel si zpracuje informace do paměti a pak ho bezpečně smaže.
              </p>
              <p className="text-sm text-muted-foreground">
                Pokud ne, klikni na <strong>„Smazat bez zrcadlení"</strong>.
              </p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col sm:flex-row gap-2">
            <AlertDialogCancel className="rounded-xl">Zrušit</AlertDialogCancel>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleDeleteWithout}
              className="gap-1 rounded-xl"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Smazat bez zrcadlení
            </Button>
            <Button
              onClick={handleMirrorThenDelete}
              disabled={isMirroring}
              className="gap-1 rounded-xl"
            >
              {isMirroring ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Database className="w-3.5 h-3.5" />}
              Zrcadlit a smazat
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

export default HanaThreadHistory;

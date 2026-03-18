import { useState, useEffect, useCallback } from "react";
import { History, Trash2, MessageCircle, Plus, Database, Loader2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
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
  messages: { role: string; content: string }[];
  isActive: boolean;
  lastActivityAt: string;
  startedAt: string;
}

interface Props {
  currentConversationId: string | null;
  onSwitchThread: (threadId: string, messages: { role: string; content: string }[]) => void;
  onNewThread: () => void;
  onMirrorToDrive: () => Promise<void>;
}

/** Extract a short topic label from the conversation content */
const getTopicLabel = (thread: HanaThread): string => {
  // Find first user message as topic indicator
  const firstUser = thread.messages.find(m => m.role === "user");
  if (firstUser && typeof firstUser.content === "string") {
    const text = firstUser.content.trim();
    // Take first sentence or first 50 chars
    const sentence = text.split(/[.!?\n]/)[0].trim();
    return sentence.length > 50 ? sentence.slice(0, 47) + "…" : sentence;
  }
  return "Nová konverzace";
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
  const [isOpen, setIsOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<HanaThread | null>(null);
  const [isMirroring, setIsMirroring] = useState(false);

  const fetchThreads = useCallback(async () => {
    const { data } = await supabase
      .from("karel_hana_conversations")
      .select("id, messages, is_active, last_activity_at, started_at")
      .order("last_activity_at", { ascending: false })
      .limit(20);

    if (data) {
      setThreads(data.map(r => ({
        id: r.id,
        messages: (r.messages ?? []) as { role: string; content: string }[],
        isActive: r.is_active,
        lastActivityAt: r.last_activity_at,
        startedAt: r.started_at,
      })));
    }
  }, []);

  useEffect(() => {
    if (isOpen) fetchThreads();
  }, [isOpen, fetchThreads]);

  // Realtime subscription for cross-device sync
  useEffect(() => {
    const channel = supabase
      .channel("hana_threads_realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "karel_hana_conversations" },
        () => { if (isOpen) fetchThreads(); }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [isOpen, fetchThreads]);

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

  const handleSelectThread = (thread: HanaThread) => {
    onSwitchThread(thread.id, thread.messages as { role: string; content: string }[]);
    setIsOpen(false);
  };

  if (!isOpen) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => setIsOpen(true)}
        className="h-8 px-3 text-xs gap-1.5 rounded-xl"
      >
        <History className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">Vlákna</span>
      </Button>
    );
  }

  // Filter out threads with only the welcome message (no real content)
  const meaningfulThreads = threads.filter(t => t.messages.some(m => m.role === "user"));

  return (
    <>
      <div className="border-b border-border bg-background/80 backdrop-blur-sm">
        <div className="max-w-5xl mx-auto px-3 sm:px-4 py-3">
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
                  onClick={() => { onNewThread(); setIsOpen(false); }}
                  className="h-8 text-xs gap-1.5 rounded-xl"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Nové vlákno
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setIsOpen(false)}
                  className="h-8 text-xs rounded-xl"
                >
                  Zavřít
                </Button>
              </div>
            </div>

            {meaningfulThreads.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border bg-muted/30 px-4 py-6 text-sm text-muted-foreground text-center">
                Zatím žádná vlákna. Začni novou konverzaci.
              </div>
            ) : (
              <div className="space-y-1.5 max-h-[320px] overflow-y-auto">
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
                      onClick={() => !isCurrent && handleSelectThread(thread)}
                    >
                      <MessageCircle className="w-4 h-4 text-primary/60 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-foreground truncate leading-snug">
                          {getTopicLabel(thread)}
                        </div>
                        <div className="text-[11px] text-muted-foreground mt-0.5">
                          {formatDate(thread.startedAt)}
                          {isCurrent && <span className="text-primary ml-2 font-medium">● aktivní</span>}
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
            )}
          </div>
        </div>
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

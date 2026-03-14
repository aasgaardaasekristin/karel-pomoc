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

  const formatTime = (isoStr: string) => {
    const diff = Date.now() - new Date(isoStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "právě teď";
    if (mins < 60) return `před ${mins} min`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `před ${hours} h`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `před ${days} d`;
    return new Date(isoStr).toLocaleDateString("cs-CZ", {
      day: "numeric", month: "short",
    });
  };

  const getPreview = (thread: HanaThread): string => {
    const lastUser = [...thread.messages].reverse().find(m => m.role === "user");
    if (lastUser && typeof lastUser.content === "string") return lastUser.content.slice(0, 60);
    const lastAssistant = [...thread.messages].reverse().find(m => m.role === "assistant");
    if (lastAssistant && typeof lastAssistant.content === "string") return lastAssistant.content.slice(0, 60);
    return "Nová konverzace";
  };

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

  return (
    <>
      <div className="border-b border-border bg-card/50 backdrop-blur-sm">
        <div className="max-w-4xl mx-auto px-3 sm:px-4 py-3">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-foreground flex items-center gap-2">
              <History className="w-4 h-4 text-primary" />
              Vlákna konverzací
            </h3>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => { onNewThread(); setIsOpen(false); }} className="h-7 text-xs gap-1">
                <Plus className="w-3 h-3" />
                Nové
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setIsOpen(false)} className="h-7 text-xs">
                Zavřít
              </Button>
            </div>
          </div>

          {threads.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border bg-card/30 px-3 py-4 text-xs text-muted-foreground text-center">
              Žádná uložená vlákna.
            </div>
          ) : (
            <div className="space-y-1.5 max-h-[300px] overflow-y-auto">
              {threads.map(thread => {
                const isCurrent = thread.id === currentConversationId;
                return (
                  <div
                    key={thread.id}
                    className={`flex items-center gap-2 sm:gap-3 p-2.5 rounded-lg border cursor-pointer transition-colors group ${
                      isCurrent
                        ? "border-primary/40 bg-primary/5"
                        : "border-border bg-card/50 hover:bg-card"
                    }`}
                    onClick={() => !isCurrent && handleSelectThread(thread)}
                  >
                    <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                      <MessageCircle className="w-3.5 h-3.5 text-primary" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-xs sm:text-sm text-foreground truncate">
                        {getPreview(thread)}
                        {isCurrent && <span className="text-[10px] text-primary ml-1.5">● aktivní</span>}
                      </div>
                      <div className="text-[10px] text-muted-foreground flex items-center gap-2">
                        <span>{formatTime(thread.lastActivityAt)}</span>
                        <span>{thread.messages.length} zpráv</span>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity shrink-0"
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

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
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
                Pokud ano, klikni nejdřív na <strong>„Zrcadlit a smazat"</strong> – Karel si zpracuje informace z vlákna do své paměti na Drive a pak ho bezpečně smaže.
              </p>
              <p className="text-sm text-muted-foreground">
                Pokud ne, klikni na <strong>„Smazat bez zrcadlení"</strong> – vlákno bude smazáno a Karel si ho nebude pamatovat.
              </p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col sm:flex-row gap-2">
            <AlertDialogCancel>Zrušit</AlertDialogCancel>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleDeleteWithout}
              className="gap-1"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Smazat bez zrcadlení
            </Button>
            <Button
              onClick={handleMirrorThenDelete}
              disabled={isMirroring}
              className="gap-1"
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

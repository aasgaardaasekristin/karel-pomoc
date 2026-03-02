import { MessageCircle, Clock, Globe, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DidThread } from "@/hooks/useDidThreads";

interface Props {
  threads: DidThread[];
  onSelectThread: (thread: DidThread) => void;
  onDeleteThread: (threadId: string) => void;
  onNewThread: () => void;
}

const languageLabels: Record<string, string> = {
  cs: "čeština",
  no: "norština",
  en: "angličtina",
  "old-no": "staronorština",
};

const DidThreadList = ({ threads, onSelectThread, onDeleteThread, onNewThread }: Props) => {
  const formatTime = (isoStr: string) => {
    const diff = Date.now() - new Date(isoStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "právě teď";
    if (mins < 60) return `před ${mins} min`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `před ${hours} h`;
    return new Date(isoStr).toLocaleDateString("cs-CZ", {
      day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
    });
  };

  return (
    <div className="max-w-2xl mx-auto px-3 sm:px-4 mt-4 pb-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
          <MessageCircle className="w-4 h-4" />
          Aktivní vlákna částí (24h)
        </h3>
        <Button variant="outline" size="sm" onClick={onNewThread} className="h-8 text-xs">
          + Nové vlákno
        </Button>
      </div>

      {threads.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-card/30 px-3 py-4 text-xs text-muted-foreground text-center">
          Zatím žádná aktivní vlákna. Klikni na „Nové vlákno" pro zahájení rozhovoru s částí.
        </div>
      ) : (
        <div className="space-y-2">
          {threads.map((thread) => (
            <div
              key={thread.id}
              className="flex items-center gap-3 p-3 rounded-lg border border-border bg-card/50 hover:bg-card cursor-pointer transition-colors group"
              onClick={() => onSelectThread(thread)}
            >
              <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                <span className="text-sm font-medium text-primary">
                  {thread.partName.charAt(0).toUpperCase()}
                </span>
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-foreground truncate">
                  {thread.partName}
                </div>
                <div className="flex items-center gap-2 text-[10px] sm:text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {formatTime(thread.lastActivityAt)}
                  </span>
                  <span className="flex items-center gap-1">
                    <Globe className="w-3 h-3" />
                    {languageLabels[thread.partLanguage] || thread.partLanguage}
                  </span>
                  <span>{thread.messages.length} zpráv</span>
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity shrink-0"
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteThread(thread.id);
                }}
              >
                <Trash2 className="w-3.5 h-3.5 text-destructive" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default DidThreadList;

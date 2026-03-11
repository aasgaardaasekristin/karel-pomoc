import { Button } from "@/components/ui/button";
import { Trash2, Plus, MessageSquare, Clock } from "lucide-react";
import type { ResearchThread } from "@/hooks/useResearchThreads";

interface Props {
  threads: ResearchThread[];
  onSelect: (thread: ResearchThread) => void;
  onDelete: (id: string) => void;
  onNew: () => void;
  loading?: boolean;
}

const formatTimeAgo = (dateStr: string) => {
  const diff = Date.now() - new Date(dateStr).getTime();
  const hours = Math.floor(diff / 3600000);
  if (hours < 1) return "právě teď";
  if (hours < 24) return `před ${hours}h`;
  const days = Math.floor(hours / 24);
  return `před ${days}d`;
};

const ResearchThreadList = ({ threads, onSelect, onDelete, onNew, loading }: Props) => {
  return (
    <div className="max-w-2xl mx-auto px-3 sm:px-4 py-6">
      <div className="text-center mb-6">
        <h2 className="text-lg font-serif font-semibold text-foreground">🔬 Profesní zdroje</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Vlákna výzkumů a odborných rešerší
        </p>
      </div>

      <Button onClick={onNew} className="w-full mb-4 gap-2" variant="outline">
        <Plus className="w-4 h-4" />
        Nové téma
      </Button>

      {loading ? (
        <div className="text-center text-sm text-muted-foreground py-8">Načítám vlákna...</div>
      ) : threads.length === 0 ? (
        <div className="text-center text-sm text-muted-foreground py-8 bg-muted/30 rounded-xl">
          Žádná aktivní vlákna. Klikni na "Nové téma" a začni rešerši.
        </div>
      ) : (
        <div className="space-y-2">
          {threads.map(thread => (
            <div
              key={thread.id}
              className="flex items-center gap-3 p-3 rounded-xl border border-border bg-card hover:bg-card/80 transition-all cursor-pointer group"
              onClick={() => onSelect(thread)}
            >
              <MessageSquare className="w-5 h-5 text-accent shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="font-medium text-foreground text-sm truncate">{thread.topic}</div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                  <span>{thread.createdBy}</span>
                  <span>•</span>
                  <span>{thread.messages.length} zpráv</span>
                  <span>•</span>
                  <Clock className="w-3 h-3" />
                  <span>{formatTimeAgo(thread.lastActivityAt)}</span>
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                onClick={(e) => { e.stopPropagation(); onDelete(thread.id); }}
              >
                <Trash2 className="w-4 h-4 text-destructive" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default ResearchThreadList;

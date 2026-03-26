import { History, Trash2, MessageCircle, Heart, BookOpen, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { SavedConversation } from "@/hooks/useConversationHistory";

interface Props {
  conversations: SavedConversation[];
  onLoad: (id: string) => void;
  onDelete: (id: string) => void;
}

const DidConversationHistory = ({ conversations, onLoad, onDelete }: Props) => {

  const iconMap: Record<string, typeof Heart> = {
    mamka: Heart,
    cast: MessageCircle,
    general: BookOpen,
  };

  const formatTimeAgo = (timestamp: number) => {
    const diff = Date.now() - timestamp;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "právě teď";
    if (mins < 60) return `před ${mins} min`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `před ${hours} h`;
    const date = new Date(timestamp);
    return date.toLocaleDateString("cs-CZ", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <div className="max-w-2xl mx-auto px-3 sm:px-4 mt-4 sm:mt-6 pb-4">
      <div className="flex items-center justify-between mb-2 sm:mb-3">
        <div className="flex items-center gap-2">
          <History className="w-4 h-4 text-muted-foreground" />
          <h3 className="text-xs sm:text-sm font-medium text-muted-foreground">Poslední rozhovory</h3>
        </div>
        <div className="flex items-center gap-1 text-[0.625rem] sm:text-xs text-muted-foreground/60">
          <Save className="w-3 h-3" />
          <span>autosave</span>
        </div>
      </div>
      <div className="space-y-1.5 sm:space-y-2">
        {conversations.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-card/30 px-3 py-3 text-[0.6875rem] sm:text-xs text-muted-foreground">
            Zatím tu není žádný uložený rozhovor.
          </div>
        ) : (
          conversations.map((conv) => {
            const Icon = iconMap[conv.subMode] || MessageCircle;
            const timeStr = formatTimeAgo(conv.savedAt);
            return (
              <div
                key={conv.id}
                className="flex items-center gap-2 sm:gap-3 p-2.5 sm:p-3 rounded-lg border border-border bg-card/50 hover:bg-card active:bg-card transition-colors cursor-pointer group"
                onClick={() => onLoad(conv.id)}
              >
                <Icon className="w-4 h-4 text-primary shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-xs sm:text-sm font-medium text-foreground truncate">
                    {conv.label}: {conv.preview}…
                  </div>
                  <div className="text-[0.625rem] sm:text-xs text-muted-foreground">{timeStr}</div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity shrink-0"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(conv.id);
                  }}
                >
                  <Trash2 className="w-3.5 h-3.5 text-destructive" />
                </Button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

export default DidConversationHistory;

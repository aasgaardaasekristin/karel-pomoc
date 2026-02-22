import { History, Trash2, MessageCircle, Heart } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { SavedConversation } from "@/hooks/useConversationHistory";

interface Props {
  conversations: SavedConversation[];
  onLoad: (id: string) => void;
  onDelete: (id: string) => void;
}

const DidConversationHistory = ({ conversations, onLoad, onDelete }: Props) => {
  if (conversations.length === 0) return null;

  const iconMap: Record<string, typeof Heart> = {
    mamka: Heart,
    cast: MessageCircle,
  };

  return (
    <div className="max-w-2xl mx-auto px-4 mt-6">
      <div className="flex items-center gap-2 mb-3">
        <History className="w-4 h-4 text-muted-foreground" />
        <h3 className="text-sm font-medium text-muted-foreground">Poslední rozhovory</h3>
      </div>
      <div className="space-y-2">
        {conversations.map((conv) => {
          const Icon = iconMap[conv.subMode] || MessageCircle;
          const date = new Date(conv.savedAt);
          const timeStr = date.toLocaleDateString("cs-CZ", {
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
          });
          return (
            <div
              key={conv.id}
              className="flex items-center gap-3 p-3 rounded-lg border border-border bg-card/50 hover:bg-card transition-colors cursor-pointer group"
              onClick={() => onLoad(conv.id)}
            >
              <Icon className="w-4 h-4 text-primary shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-foreground truncate">
                  {conv.label}: {conv.preview}…
                </div>
                <div className="text-xs text-muted-foreground">{timeStr}</div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(conv.id);
                }}
              >
                <Trash2 className="w-3.5 h-3.5 text-destructive" />
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default DidConversationHistory;

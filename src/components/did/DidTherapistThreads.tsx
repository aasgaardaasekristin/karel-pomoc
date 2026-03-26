import { MessageCircle, Clock, Trash2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DidThread } from "@/hooks/useDidThreads";
import DidPersonalizedSessionPrep from "./DidPersonalizedSessionPrep";

interface Props {
  therapistName: string;
  threads: DidThread[];
  onSelectThread: (thread: DidThread) => void;
  onDeleteThread: (threadId: string) => void;
  onNewThread: () => void;
  onBack: () => void;
}

const DidTherapistThreads = ({ therapistName, threads, onSelectThread, onDeleteThread, onNewThread, onBack }: Props) => {
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

  // Extract preview from thread messages
  const getPreview = (thread: DidThread): string => {
    const lastUser = [...thread.messages].reverse().find(m => m.role === "user");
    if (lastUser) return typeof lastUser.content === "string" ? lastUser.content.slice(0, 80) : "...";
    const lastAssistant = [...thread.messages].reverse().find(m => m.role === "assistant");
    if (lastAssistant) return typeof lastAssistant.content === "string" ? lastAssistant.content.slice(0, 80) : "...";
    return "Nový rozhovor";
  };

  return (
    <div className="max-w-2xl mx-auto px-3 sm:px-4 py-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-base font-semibold" style={{ color: "rgba(255, 255, 255, 0.95)", textShadow: "0 1px 3px rgba(0,0,0,0.4)" }}>{therapistName}</h3>
          <p className="text-xs" style={{ color: "rgba(255, 255, 255, 0.6)" }}>Témata a rozhovory s Karlem</p>
        </div>
        <div className="flex items-center gap-1.5">
          <DidPersonalizedSessionPrep therapistName={therapistName as "Hanička" | "Káťa"} />
          <Button
            variant="outline"
            size="sm"
            onClick={onNewThread}
            className="h-8 text-xs gap-1"
            style={{
              background: "rgba(255, 255, 255, 0.1)",
              backdropFilter: "blur(8px)",
              WebkitBackdropFilter: "blur(8px)",
              border: "1px solid rgba(255, 255, 255, 0.2)",
              color: "rgba(255, 255, 255, 0.9)",
            }}
          >
            <Plus className="w-3.5 h-3.5" />
            Nové téma
          </Button>
        </div>
      </div>

      {threads.length === 0 ? (
        <div
          className="rounded-2xl px-4 py-8 text-center"
          style={{
            background: "rgba(0, 0, 0, 0.08)",
            backdropFilter: "blur(10px)",
            WebkitBackdropFilter: "blur(10px)",
            border: "1px dashed rgba(255, 255, 255, 0.15)",
          }}
        >
          <MessageCircle className="w-8 h-8 mx-auto mb-2" style={{ color: "rgba(255, 255, 255, 0.35)" }} />
          <p className="text-sm" style={{ color: "rgba(255, 255, 255, 0.7)" }}>Zatím žádné rozhovory</p>
          <p className="text-xs mt-1" style={{ color: "rgba(255, 255, 255, 0.5)" }}>Klikni na „Nové téma" pro zahájení rozhovoru s Karlem</p>
        </div>
      ) : (
        <div className="space-y-2">
          {threads.map((thread) => (
            <div
              key={thread.id}
              className="flex items-center gap-3 p-3 rounded-2xl cursor-pointer transition-all duration-200 group"
              style={{
                background: "rgba(0, 0, 0, 0.1)",
                backdropFilter: "blur(10px)",
                WebkitBackdropFilter: "blur(10px)",
                border: "1px solid rgba(255, 255, 255, 0.12)",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "rgba(0, 0, 0, 0.18)";
                e.currentTarget.style.borderColor = "rgba(255, 255, 255, 0.2)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "rgba(0, 0, 0, 0.1)";
                e.currentTarget.style.borderColor = "rgba(255, 255, 255, 0.12)";
              }}
              onClick={() => onSelectThread(thread)}
            >
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center shrink-0"
                style={{ background: "rgba(255, 255, 255, 0.12)" }}
              >
                <MessageCircle className="w-4 h-4" style={{ color: "rgba(255, 255, 255, 0.7)" }} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm truncate" style={{ color: "rgba(255, 255, 255, 0.9)" }}>
                  {getPreview(thread)}
                </div>
                <div className="flex items-center gap-2 text-[0.625rem] mt-0.5" style={{ color: "rgba(255, 255, 255, 0.5)" }}>
                  <span className="flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {formatTime(thread.lastActivityAt)}
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

export default DidTherapistThreads;

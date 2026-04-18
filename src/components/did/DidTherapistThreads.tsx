import { MessageCircle, Clock, Trash2, Plus, ClipboardList, HelpCircle, CalendarDays } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DidThread } from "@/hooks/useDidThreads";
import DidPersonalizedSessionPrep from "./DidPersonalizedSessionPrep";

/**
 * BUGFIX (FÁZE 3 stabilization): meta no longer derived via regex from the
 * intro message. Caller provides a typed map (workspaceMeta) populated from
 * the actual workspace row (tasks.assigned_to / questions.directed_to /
 * session.selected_part). When the entry is missing the row degrades
 * gracefully to label + preview — no fabricated meta.
 */
export interface DidWorkspaceMeta {
  assignee?: string;
  partName?: string;
  detailLine?: string;
}

interface Props {
  therapistName: string;
  threads: DidThread[];
  onSelectThread: (thread: DidThread) => void;
  onDeleteThread: (threadId: string) => void;
  onNewThread: () => void;
  onBack: () => void;
  workspaceMeta?: Record<string, DidWorkspaceMeta>;
}

const WORKSPACE_TYPE_META: Record<string, { label: string; icon: typeof ClipboardList; tone: string }> = {
  task: { label: "Úkol", icon: ClipboardList, tone: "rgba(255, 200, 120, 0.85)" },
  question: { label: "Otázka", icon: HelpCircle, tone: "rgba(160, 200, 255, 0.85)" },
  session: { label: "Sezení", icon: CalendarDays, tone: "rgba(180, 230, 180, 0.85)" },
};

const lastTextMessage = (thread: DidThread): string => {
  const lastUser = [...thread.messages].reverse().find(m => m.role === "user");
  if (lastUser && typeof lastUser.content === "string") return lastUser.content;
  const lastAssistant = [...thread.messages].reverse().find(m => m.role === "assistant");
  if (lastAssistant && typeof lastAssistant.content === "string") return lastAssistant.content;
  return "";
};

const truncate = (s: string, n: number) => s.length > n ? s.slice(0, n - 1) + "…" : s;

const DidTherapistThreads = ({ therapistName, threads, onSelectThread, onDeleteThread, onNewThread, onBack, workspaceMeta }: Props) => {
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
    <div className="max-w-2xl mx-auto px-3 sm:px-4 py-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-base font-serif font-medium tracking-wide" style={{ color: "rgba(255, 255, 255, 0.92)", textShadow: "0 1px 3px rgba(0,0,0,0.3)" }}>{therapistName}</h3>
          <p className="text-xs font-light tracking-wide" style={{ color: "rgba(255, 255, 255, 0.55)" }}>Témata a rozhovory s Karlem</p>
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
          {threads.map((thread) => {
            const meta = thread.workspaceType ? WORKSPACE_TYPE_META[thread.workspaceType] : null;
            const lastMsg = lastTextMessage(thread);
            // For system workspaces: title = threadLabel (assigned identity).
            // For ad-hoc therapist threads: title = first non-empty user/assistant snippet.
            const primaryTitle = meta
              ? (thread.threadLabel || `${meta.label}`)
              : (thread.threadLabel || truncate(lastMsg, 80) || "Nový rozhovor");
            const previewLine = meta
              ? truncate(lastMsg.replace(/\s+/g, " ").trim(), 90)
              : "";
            const Icon = meta?.icon || MessageCircle;
            const iconTone = meta?.tone || "rgba(255, 255, 255, 0.7)";

            return (
              <div
                key={thread.id}
                className="flex items-start gap-3 p-3 rounded-2xl cursor-pointer transition-all duration-200 group"
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
                  className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 mt-0.5"
                  style={{ background: "rgba(255, 255, 255, 0.12)" }}
                >
                  <Icon className="w-4 h-4" style={{ color: iconTone }} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {meta && (
                      <span
                        className="inline-flex items-center text-[0.55rem] uppercase tracking-wider px-1.5 py-0 rounded-full"
                        style={{
                          background: "rgba(255, 255, 255, 0.08)",
                          color: iconTone,
                          border: "1px solid rgba(255, 255, 255, 0.12)",
                        }}
                      >
                        {meta.label}
                      </span>
                    )}
                    <span className="text-sm truncate font-medium" style={{ color: "rgba(255, 255, 255, 0.92)" }}>
                      {primaryTitle}
                    </span>
                  </div>
                  {previewLine && (
                    <div className="text-[0.6875rem] mt-0.5 truncate" style={{ color: "rgba(255, 255, 255, 0.55)" }}>
                      {previewLine}
                    </div>
                  )}
                  <div className="flex items-center gap-2 text-[0.625rem] mt-0.5" style={{ color: "rgba(255, 255, 255, 0.5)" }}>
                    <span className="flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {formatTime(thread.lastActivityAt)}
                    </span>
                    <span>{thread.messages.length} zpráv</span>
                    {meta && workspaceMeta?.[thread.id]?.assignee && (
                      <span className="px-1.5 py-0 rounded-full" style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)" }}>
                        → {workspaceMeta[thread.id].assignee}
                      </span>
                    )}
                    {meta && workspaceMeta?.[thread.id]?.partName && (
                      <span className="px-1.5 py-0 rounded-full" style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)" }}>
                        {workspaceMeta[thread.id].partName}
                      </span>
                    )}
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
            );
          })}
        </div>
      )}
    </div>
  );
};

export default DidTherapistThreads;

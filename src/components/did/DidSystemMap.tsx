import { useState, useMemo } from "react";
import { Clock, AlertTriangle, CheckCircle, Moon, ChevronDown, ChevronUp, Activity, MessageCircle, Trash2 } from "lucide-react";

interface PartActivity {
  name: string;
  lastSeen: string | null;
  status: "active" | "sleeping" | "warning";
}

interface ActiveThreadSummary {
  id: string;
  partName: string;
  lastActivityAt: string;
  messageCount: number;
}

interface Props {
  parts: PartActivity[];
  activeThreads?: ActiveThreadSummary[];
  onQuickThread?: (threadId: string, partName: string) => void;
  onDeletePart?: (partName: string) => void;
}

const STATUS_CONFIG = {
  active: {
    bg: "bg-green-500/15",
    border: "border-green-500/40",
    ring: "ring-green-400/30",
    dot: "bg-green-500",
    pulse: "animate-pulse",
    label: "aktivní",
    icon: CheckCircle,
    iconColor: "text-green-500",
  },
  sleeping: {
    bg: "bg-muted/30",
    border: "border-border",
    ring: "ring-muted/20",
    dot: "bg-muted-foreground/40",
    pulse: "",
    label: "spí",
    icon: Moon,
    iconColor: "text-muted-foreground",
  },
  warning: {
    bg: "bg-yellow-500/10",
    border: "border-yellow-500/50",
    ring: "ring-yellow-400/20",
    dot: "bg-yellow-500",
    pulse: "animate-pulse",
    label: "⚠️ neaktivní 7+ dní",
    icon: AlertTriangle,
    iconColor: "text-yellow-500",
  },
};

const formatTimeAgo = (isoStr: string | null) => {
  if (!isoStr) return "nikdy";
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "právě teď";
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  return `${days} d`;
};

const formatDate = (isoStr: string | null) => {
  if (!isoStr) return "—";
  const d = new Date(isoStr);
  return d.toLocaleDateString("cs-CZ", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
};

const DidSystemMap = ({ parts, activeThreads, onQuickThread, onDeletePart }: Props) => {
  const [expanded, setExpanded] = useState(true);

  const sorted = useMemo(() => {
    const order = { active: 0, warning: 1, sleeping: 2 };
    return [...parts].sort((a, b) => order[a.status] - order[b.status]);
  }, [parts]);

  const stats = useMemo(() => ({
    active: parts.filter(p => p.status === "active").length,
    sleeping: parts.filter(p => p.status === "sleeping").length,
    warning: parts.filter(p => p.status === "warning").length,
  }), [parts]);

  // Map part names to their active threads for quick lookup
  const threadByPart = useMemo(() => {
    const map = new Map<string, ActiveThreadSummary>();
    if (activeThreads) {
      for (const t of activeThreads) {
        // Use the first (most recent) thread for each part
        if (!map.has(t.partName)) {
          map.set(t.partName, t);
        }
      }
    }
    return map;
  }, [activeThreads]);

  if (parts.length === 0) return null;

  return (
    <div className="mt-4">
      <button
        onClick={() => setExpanded(e => !e)}
        className="flex items-center gap-2 text-sm font-medium text-foreground mb-3 hover:text-primary transition-colors w-full"
      >
        <Activity className="w-4 h-4 text-primary" />
        Mapa systému
        <span className="text-[10px] text-muted-foreground ml-1">
          ({stats.active} aktivních, {stats.sleeping} spí{stats.warning > 0 ? `, ${stats.warning} ⚠️` : ""})
        </span>
        {expanded ? <ChevronUp className="w-3.5 h-3.5 ml-auto" /> : <ChevronDown className="w-3.5 h-3.5 ml-auto" />}
      </button>

      {expanded && (
        <div className="space-y-2">
          {/* Visual node map */}
          <div className="flex flex-wrap gap-2 justify-center p-3 rounded-lg bg-card/50 border border-border">
            {sorted.map((part) => {
              const cfg = STATUS_CONFIG[part.status];
              const thread = threadByPart.get(part.name);
              const isClickable = !!thread && !!onQuickThread;

              return (
                <div
                  key={part.name}
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    if (thread && onQuickThread) {
                      onQuickThread(thread.id, thread.partName);
                    }
                  }}
                  className={`relative group flex flex-col items-center gap-1 p-2 rounded-xl ${cfg.bg} ${cfg.border} border ring-1 ${cfg.ring} transition-all min-w-[80px] max-w-[110px] ${
                    isClickable
                      ? "cursor-pointer hover:scale-110 hover:ring-2 hover:ring-primary/40 hover:shadow-md"
                      : "cursor-default hover:scale-105"
                  }`}
                >
                  {/* Status dot */}
                  <div className={`w-3 h-3 rounded-full ${cfg.dot} ${cfg.pulse}`} />
                  
                  {/* Name + delete */}
                  <div className="flex items-center gap-0.5 w-full justify-center">
                    <span className="text-xs font-medium text-foreground text-center leading-tight truncate">
                      {part.name}
                    </span>
                    {onDeletePart && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm(`Smazat všechna vlákna pro "${part.name}" z mapy?`)) {
                            onDeletePart(part.name);
                          }
                        }}
                        className="flex-shrink-0 p-0.5 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive transition-colors"
                        title={`Smazat ${part.name} z mapy`}
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                  
                  {/* Time + thread indicator */}
                  <span className="text-[9px] text-muted-foreground flex items-center gap-0.5">
                    {isClickable && <MessageCircle className="w-2.5 h-2.5 text-primary" />}
                    <Clock className="w-2.5 h-2.5" />
                    {formatTimeAgo(part.lastSeen)}
                  </span>

                  {/* Tooltip on hover */}
                  <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 bg-popover border border-border rounded-md px-2 py-1 text-[10px] text-popover-foreground shadow-md opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-10">
                    {isClickable ? "Klikni pro navázání rozhovoru" : cfg.label} • {formatDate(part.lastSeen)}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Timeline */}
          <div className="rounded-lg border border-border bg-card/30 p-3">
            <h4 className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-2">
              Chronologie aktivity
            </h4>
            <div className="space-y-1.5">
              {sorted
                .filter(p => p.lastSeen)
                .sort((a, b) => new Date(b.lastSeen!).getTime() - new Date(a.lastSeen!).getTime())
                .slice(0, 8)
                .map((part) => {
                  const cfg = STATUS_CONFIG[part.status];
                  const Icon = cfg.icon;
                  return (
                    <div key={part.name} className="flex items-center gap-2 text-xs">
                      <Icon className={`w-3 h-3 flex-shrink-0 ${cfg.iconColor}`} />
                      <span className="font-medium text-foreground truncate flex-1">{part.name}</span>
                      <span className="text-muted-foreground text-[10px] flex-shrink-0">
                        {formatDate(part.lastSeen)}
                      </span>
                    </div>
                  );
                })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default DidSystemMap;

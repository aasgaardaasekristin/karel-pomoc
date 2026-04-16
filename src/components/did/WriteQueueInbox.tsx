import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Loader2, FileText, ChevronDown, ChevronUp } from "lucide-react";
import {
  toWriteQueueItemView,
  extractQualityLabels,
  getBadgeTone,
  BADGE_TONE_STYLES,
  contentTypeLabel,
  subjectTypeLabel,
  type WriteQueueItemView,
} from "@/lib/governedWriteDecoder";

interface Props {
  refreshTrigger?: number;
}

const WriteQueueInbox = ({ refreshTrigger = 0 }: Props) => {
  const [items, setItems] = useState<WriteQueueItemView[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<"pending" | "all">("pending");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      let query = supabase
        .from("did_pending_drive_writes")
        .select("id, target_document, content, priority, status, created_at")
        .order("created_at", { ascending: false })
        .limit(50);

      if (statusFilter === "pending") {
        query = query.eq("status", "pending");
      }

      const { data, error } = await query;
      if (error) throw error;

      setItems((data || []).map((row: any) => toWriteQueueItemView(row)));
    } catch (e) {
      console.error("[WriteQueueInbox] load failed:", e);
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => { load(); }, [load, refreshTrigger]);

  if (loading) {
    return (
      <div className="flex justify-center py-6">
        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium flex items-center gap-1.5">
          <FileText className="w-3.5 h-3.5 text-primary" />
          Fronta zápisů ({items.length})
        </h3>
        <div className="flex gap-1">
          {(["pending", "all"] as const).map(f => (
            <button
              key={f}
              onClick={() => setStatusFilter(f)}
              className={`px-2 py-0.5 text-[10px] rounded transition-colors ${
                statusFilter === f
                  ? "bg-background shadow-sm text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {f === "pending" ? "Čeká" : "Vše"}
            </button>
          ))}
        </div>
      </div>

      {items.length === 0 && (
        <p className="text-xs text-muted-foreground text-center py-4">
          Žádné zápisy ve frontě.
        </p>
      )}

      {items.map(item => {
        const isExpanded = expandedId === item.id;
        const labels = extractQualityLabels(item.payloadFull);
        const statusColor =
          item.status === "pending" ? "bg-amber-500/20 text-amber-700" :
          item.status === "completed" || item.status === "done" ? "bg-emerald-500/15 text-emerald-700" :
          item.status === "failed" ? "bg-destructive/15 text-destructive" :
          "bg-muted text-muted-foreground";

        return (
          <div
            key={item.id}
            className="rounded-lg border border-border/60 bg-card/40 overflow-hidden"
          >
            <button
              onClick={() => setExpandedId(isExpanded ? null : item.id)}
              className="w-full text-left p-2.5 flex items-start gap-2 hover:bg-accent/20 transition-colors"
            >
              <div className="flex-1 min-w-0 space-y-1">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[11px] font-medium text-foreground truncate max-w-[200px]">
                    {item.targetDocument}
                  </span>
                  <Badge className={`text-[8px] h-3.5 px-1 border ${statusColor}`}>
                    {item.status || "?"}
                  </Badge>
                  {item.priority === "high" && (
                    <Badge className="text-[8px] h-3.5 px-1 bg-destructive/15 text-destructive border-destructive/30">
                      vysoká
                    </Badge>
                  )}
                </div>
                <p className="text-[10px] text-muted-foreground truncate">
                  {item.payloadPreview.split("\n")[0]}
                </p>
                {labels.length > 0 && (
                  <div className="flex gap-0.5 flex-wrap">
                    {labels.slice(0, 5).map((label, i) => (
                      <Badge
                        key={i}
                        className={`text-[7px] h-3 px-1 border ${BADGE_TONE_STYLES[getBadgeTone(label)]}`}
                      >
                        {label}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <span className="text-[9px] text-muted-foreground">
                  {item.createdAt ? new Date(item.createdAt).toLocaleString("cs", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" }) : ""}
                </span>
                {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              </div>
            </button>

            {isExpanded && (
              <div className="border-t border-border/40 p-2.5 space-y-2 bg-muted/20 animate-in fade-in-0 slide-in-from-top-1 duration-150">
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px]">
                  <div><span className="text-muted-foreground">Typ obsahu:</span> <span className="font-medium">{contentTypeLabel(item.contentType)}</span></div>
                  <div><span className="text-muted-foreground">Subjekt:</span> <span className="font-medium">{subjectTypeLabel(item.subjectType)}</span></div>
                  <div><span className="text-muted-foreground">ID subjektu:</span> <span className="font-medium">{item.subjectId || "—"}</span></div>
                  <div><span className="text-muted-foreground">Zdroj:</span> <span className="font-medium">{item.sourceType || "—"}</span></div>
                </div>
                <div className="rounded bg-background/60 p-2 text-[10px] text-foreground/80 whitespace-pre-line leading-relaxed max-h-[200px] overflow-y-auto">
                  {item.payloadFull}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default WriteQueueInbox;

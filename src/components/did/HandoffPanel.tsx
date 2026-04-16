import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Loader2, ArrowRightLeft } from "lucide-react";
import {
  toWriteQueueItemView,
  extractQualityLabels,
  getBadgeTone,
  BADGE_TONE_STYLES,
} from "@/lib/governedWriteDecoder";
import { buildHandoff, type HandoffSection } from "@/lib/operationalBuilders";

interface Props {
  refreshTrigger?: number;
}

const TONE_BORDER: Record<HandoffSection["tone"], string> = {
  neutral: "border-l-primary/40",
  warning: "border-l-amber-500",
  critical: "border-l-destructive",
};

const HandoffPanel = ({ refreshTrigger = 0 }: Props) => {
  const [sections, setSections] = useState<HandoffSection[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString();

      const [writesRes, tasksRes] = await Promise.all([
        supabase
          .from("did_pending_drive_writes")
          .select("id, target_document, content, priority, status, created_at")
          .gte("created_at", threeDaysAgo)
          .order("created_at", { ascending: false })
          .limit(100),
        supabase
          .from("did_therapist_tasks")
          .select("task, priority, status")
          .in("status", ["pending", "active", "in_progress", "blocked"])
          .limit(20),
      ]);

      const writes = (writesRes.data || []).map((r: any) => toWriteQueueItemView(r));
      const tasks = (tasksRes.data || []).map((t: any) => ({
        task: t.task,
        priority: t.priority,
        status: t.status,
      }));

      setSections(buildHandoff({ recentWrites: writes, tasks }));
    } catch (e) {
      console.error("[HandoffPanel] load failed:", e);
    } finally {
      setLoading(false);
    }
  }, []);

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
      <h3 className="text-xs font-medium flex items-center gap-1.5">
        <ArrowRightLeft className="w-3.5 h-3.5 text-primary" />
        Předávka (Handoff)
      </h3>

      {sections.length === 0 && (
        <p className="text-xs text-muted-foreground text-center py-4">
          Žádná data pro předávku — systém je aktuální.
        </p>
      )}

      {sections.map((section, i) => (
        <div
          key={i}
          className={`rounded-lg border border-border/60 border-l-4 ${TONE_BORDER[section.tone]} bg-card/30 p-3 space-y-1.5`}
        >
          <h4 className="text-[11px] font-medium text-foreground/80">{section.title}</h4>
          {section.items.map((item, j) => {
            const labels = extractQualityLabels(item);
            return (
              <div key={j} className="text-[10px] text-foreground/70 leading-relaxed">
                {labels.length > 0 && (
                  <span className="inline-flex gap-0.5 mr-1">
                    {labels.slice(0, 3).map((l, k) => (
                      <span
                        key={k}
                        className={`inline-block text-[7px] px-1 py-0 rounded border ${BADGE_TONE_STYLES[getBadgeTone(l)]}`}
                      >
                        {l}
                      </span>
                    ))}
                  </span>
                )}
                {item.replace(/\[.*?\]/g, "").trim()}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
};

export default HandoffPanel;

import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Loader2, HeartPulse, AlertTriangle, Info } from "lucide-react";
import { isNonDidEntity } from "@/lib/didPartNaming";
import {
  toWriteQueueItemView,
  extractQualityLabels,
} from "@/lib/governedWriteDecoder";
import { buildRecoveryItems, type RecoveryItem } from "@/lib/operationalBuilders";

interface Props {
  refreshTrigger?: number;
}

const LEVEL_STYLES: Record<RecoveryItem["level"], { icon: typeof AlertTriangle; border: string; bg: string; text: string }> = {
  info: { icon: Info, border: "border-l-primary/40", bg: "bg-primary/5", text: "text-primary" },
  warning: { icon: AlertTriangle, border: "border-l-amber-500", bg: "bg-amber-500/5", text: "text-amber-700" },
  critical: { icon: AlertTriangle, border: "border-l-destructive", bg: "bg-destructive/5", text: "text-destructive" },
};

const RecoveryPanel = ({ refreshTrigger = 0 }: Props) => {
  const [items, setItems] = useState<RecoveryItem[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString();

      const [registryRes, writesRes, tasksRes, pendingCountRes] = await Promise.all([
        (supabase as any)
          .from("did_part_registry")
          .select("part_name, last_seen_at, status")
          .in("status", ["active", "crisis", "stabilizing", "sleeping"]),
        supabase
          .from("did_pending_drive_writes")
          .select("id, target_document, content, priority, status, created_at")
          .gte("created_at", threeDaysAgo)
          .order("created_at", { ascending: false })
          .limit(100),
        supabase
          .from("did_therapist_tasks")
          .select("task, status, priority")
          .in("status", ["pending", "active", "in_progress", "blocked"])
          .limit(30),
        supabase
          .from("did_pending_drive_writes")
          .select("id", { count: "exact", head: true })
          .eq("status", "pending"),
      ]);

      const writes = (writesRes.data || []).map((r: any) => toWriteQueueItemView(r));
      const openQuestions = writes.filter(w => {
        const labels = extractQualityLabels(w.payloadFull);
        return labels.some(l => l === "VYŽADUJE OVĚŘENÍ" || l === "NEOVĚŘENO" || l === "KONFLIKT");
      });

      const staleParts = ((registryRes.data as any[]) || [])
        .filter(r => !isNonDidEntity(r.part_name || ""))
        .map(r => ({ name: r.part_name, lastSeen: r.last_seen_at }));

      const tasks = (tasksRes.data || []).map((t: any) => ({
        task: t.task,
        status: t.status,
        priority: t.priority,
      }));

      setItems(buildRecoveryItems({
        openQuestions,
        tasks,
        staleParts,
        pendingWriteCount: pendingCountRes.count ?? 0,
      }));
    } catch (e) {
      console.error("[RecoveryPanel] load failed:", e);
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
        <HeartPulse className="w-3.5 h-3.5 text-primary" />
        Recovery / Kontinuita
      </h3>

      {items.length === 0 && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-center">
          <p className="text-[11px] text-emerald-700 font-medium">✅ Systém je v pořádku</p>
          <p className="text-[10px] text-muted-foreground">Žádné ztráty kontinuity ani backlog.</p>
        </div>
      )}

      {items.map((item, i) => {
        const style = LEVEL_STYLES[item.level];
        const Icon = style.icon;
        return (
          <div
            key={i}
            className={`rounded-lg border border-border/60 border-l-4 ${style.border} ${style.bg} p-3 space-y-1`}
          >
            <div className="flex items-center gap-1.5">
              <Icon className={`w-3.5 h-3.5 ${style.text}`} />
              <span className={`text-[11px] font-medium ${style.text}`}>{item.title}</span>
            </div>
            <p className="text-[10px] text-foreground/60 pl-5">{item.reason}</p>
          </div>
        );
      })}
    </div>
  );
};

export default RecoveryPanel;

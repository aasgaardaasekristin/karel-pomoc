import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { isNonDidEntity } from "@/lib/didPartNaming";
import { Loader2, Package, AlertTriangle, CheckCircle2, HelpCircle, ClipboardList, Eye } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  toWriteQueueItemView,
  extractQualityLabels,
  getBadgeTone,
  BADGE_TONE_STYLES,
  type WriteQueueItemView,
} from "@/lib/governedWriteDecoder";
import {
  buildSessionPacket,
  toDirectActivitySignals,
  type SessionPacket,
  type WatchItem,
} from "@/lib/operationalBuilders";

interface Props {
  refreshTrigger?: number;
}

const WATCH_SOURCE_ICON: Record<WatchItem["source"], string> = {
  write: "📝",
  continuity: "⏳",
  task: "📋",
};

const SessionPacketPanel = ({ refreshTrigger = 0 }: Props) => {
  const [packet, setPacket] = useState<SessionPacket | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString();

      const [writesRes, tasksRes, partsRes] = await Promise.all([
        supabase
          .from("did_pending_drive_writes")
          .select("id, target_document, content, priority, status, created_at")
          .gte("created_at", threeDaysAgo)
          .order("created_at", { ascending: false })
          .limit(100),
        supabase
          .from("did_therapist_tasks")
          .select("id, task, assigned_to, status, priority, category")
          .in("status", ["pending", "active", "in_progress", "blocked"])
          .order("priority", { ascending: true })
          .limit(20),
        supabase
          .from("did_part_registry")
          .select("part_name, last_seen_at")
          .limit(50),
      ]);

      const writes = (writesRes.data || []).map((r: any) => toWriteQueueItemView(r));
      const tasks = (tasksRes.data || []).map((t: any) => ({
        id: t.id,
        task: t.task,
        assigned_to: t.assigned_to,
        status: t.status,
        priority: t.priority,
        category: t.category,
      }));
      const directActivitySignals = toDirectActivitySignals(
        (partsRes.data || [])
          .filter((p: any) => !isNonDidEntity(p.part_name || ""))
          .map((p: any) => ({
            part_name: p.part_name,
            last_seen_at: p.last_seen_at,
          }))
      );

      setPacket(buildSessionPacket({ recentWrites: writes, tasks, directActivitySignals }));
    } catch (e) {
      console.error("[SessionPacketPanel] load failed:", e);
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

  if (!packet) return null;

  const writeSections = [
    {
      key: "whatChanged",
      title: "Co se změnilo",
      icon: <Package className="w-3.5 h-3.5 text-primary" />,
      items: packet.whatChanged,
      empty: "Žádné nové změny.",
    },
    {
      key: "urgentNow",
      title: "Akutní",
      icon: <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />,
      items: packet.urgentNow,
      empty: "Žádné akutní signály.",
    },
    {
      key: "openQuestions",
      title: "Otevřené otázky / ověření",
      icon: <HelpCircle className="w-3.5 h-3.5 text-amber-600" />,
      items: packet.openQuestions,
      empty: "Žádné otevřené otázky.",
    },
  ];

  return (
    <div className="space-y-3">
      <h3 className="text-xs font-medium flex items-center gap-1.5">
        <Package className="w-3.5 h-3.5 text-primary" />
        Session Packet
      </h3>

      {writeSections.map(section => (
        <div key={section.key} className="space-y-1.5">
          <h4 className="text-[11px] font-medium flex items-center gap-1.5 text-foreground/80">
            {section.icon}
            {section.title}
            {section.items.length > 0 && (
              <Badge className="text-[8px] h-3.5 px-1 bg-muted text-muted-foreground border-border">
                {section.items.length}
              </Badge>
            )}
          </h4>
          {section.items.length === 0 ? (
            <p className="text-[10px] text-muted-foreground italic pl-5">{section.empty}</p>
          ) : (
            <div className="space-y-1 pl-5">
              {section.items.map(item => {
                const labels = extractQualityLabels(item.payloadFull);
                return (
                  <div key={item.id} className="rounded border border-border/50 bg-card/30 p-2 space-y-1">
                    <div className="flex items-center gap-1 flex-wrap">
                      <span className="text-[9px] text-muted-foreground">{item.targetDocument}</span>
                      {labels.slice(0, 3).map((l, i) => (
                        <Badge key={i} className={`text-[7px] h-3 px-0.5 border ${BADGE_TONE_STYLES[getBadgeTone(l)]}`}>
                          {l}
                        </Badge>
                      ))}
                    </div>
                    <p className="text-[10px] text-foreground/80 leading-relaxed whitespace-pre-line">
                      {item.payloadPreview}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ))}

      {/* Watch Items — "Co si hlídat" */}
      <div className="space-y-1.5">
        <h4 className="text-[11px] font-medium flex items-center gap-1.5 text-foreground/80">
          <Eye className="w-3.5 h-3.5 text-amber-600" />
          Co si hlídat
          {packet.watchItems.length > 0 && (
            <Badge className="text-[8px] h-3.5 px-1 bg-amber-500/15 text-amber-700 border-amber-500/30">
              {packet.watchItems.length}
            </Badge>
          )}
        </h4>
        {packet.watchItems.length === 0 ? (
          <p className="text-[10px] text-muted-foreground italic pl-5">Nic k hlídání.</p>
        ) : (
          <div className="space-y-1 pl-5">
            {packet.watchItems.map(item => (
              <div key={item.id} className="rounded border border-border/50 bg-card/30 p-2 space-y-0.5">
                <div className="flex items-center gap-1 flex-wrap">
                  <span className="text-[9px]">{WATCH_SOURCE_ICON[item.source]}</span>
                  {item.labels.slice(0, 3).map((l, i) => (
                    <Badge key={i} className={`text-[7px] h-3 px-0.5 border ${BADGE_TONE_STYLES[getBadgeTone(l)]}`}>
                      {l}
                    </Badge>
                  ))}
                </div>
                <p className="text-[10px] font-medium text-foreground/80">{item.title}</p>
                <p className="text-[9px] text-muted-foreground">{item.reason}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Active Tasks */}
      <div className="space-y-1.5">
        <h4 className="text-[11px] font-medium flex items-center gap-1.5 text-foreground/80">
          <ClipboardList className="w-3.5 h-3.5 text-primary" />
          Aktivní úkoly
          {packet.activeTasks.length > 0 && (
            <Badge className="text-[8px] h-3.5 px-1 bg-muted text-muted-foreground border-border">
              {packet.activeTasks.length}
            </Badge>
          )}
        </h4>
        {packet.activeTasks.length === 0 ? (
          <p className="text-[10px] text-muted-foreground italic pl-5">Žádné aktivní úkoly.</p>
        ) : (
          <div className="space-y-0.5 pl-5">
            {packet.activeTasks.map(t => (
              <div key={t.id} className="flex items-center gap-1.5 text-[10px] py-0.5">
                {t.priority === "urgent" && <span className="text-destructive">🔴</span>}
                <span className="text-foreground/80 truncate">{t.task}</span>
                <span className="text-[9px] text-muted-foreground ml-auto shrink-0">
                  {t.assigned_to === "both" ? "H+K" : t.assigned_to === "kata" ? "K" : "H"}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default SessionPacketPanel;

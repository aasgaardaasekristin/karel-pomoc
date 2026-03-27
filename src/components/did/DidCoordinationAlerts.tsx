import { useState, useEffect } from "react";
import { AlertTriangle, Users, Clock, Flame } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";

interface Alert {
  type: "overlap" | "intensity" | "overdue";
  partName: string;
  message: string;
}

const ALERT_ICONS = {
  overlap: Users,
  intensity: Flame,
  overdue: Clock,
};

const DidCoordinationAlerts = ({ refreshTrigger }: { refreshTrigger: number }) => {
  const [alerts, setAlerts] = useState<Alert[]>([]);

  useEffect(() => {
    loadAlerts();
  }, [refreshTrigger]);

  const loadAlerts = async () => {
    const result: Alert[] = [];

    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();

    const [sessionsRes, registryRes, tasksRes] = await Promise.all([
      supabase
        .from("did_part_sessions")
        .select("part_name, therapist, session_date")
        .gte("created_at", twoDaysAgo)
        .order("created_at", { ascending: false }),
      supabase
        .from("did_part_registry")
        .select("part_name, last_emotional_intensity, updated_at")
        .gte("last_emotional_intensity", 4)
        .order("last_emotional_intensity", { ascending: false }),
      supabase
        .from("did_therapist_tasks")
        .select("task, assigned_to, created_at, category")
        .in("status", ["pending", "not_started"])
        .lt("created_at", fiveDaysAgo)
        .limit(10),
    ]);

    // 1. Overlap: both therapists worked with same part in 48h
    if (sessionsRes.data) {
      const byPart = new Map<string, Set<string>>();
      for (const s of sessionsRes.data) {
        if (!byPart.has(s.part_name)) byPart.set(s.part_name, new Set());
        byPart.get(s.part_name)!.add(s.therapist);
      }
      for (const [partName, therapists] of byPart) {
        if (therapists.size >= 2) {
          result.push({
            type: "overlap",
            partName,
            message: `Obě terapeutky pracovaly s ${partName} v posledních 48h — zvažte krátkou poradu.`,
          });
        }
      }
    }

    // 2. High emotional intensity
    if (registryRes.data) {
      for (const part of registryRes.data.slice(0, 2)) {
        result.push({
          type: "intensity",
          partName: part.part_name,
          message: `${part.part_name} má vysokou emoční intenzitu (${part.last_emotional_intensity}/5) — vyžaduje pozornost.`,
        });
      }
    }

    // 3. Overdue tasks
    if (tasksRes.data && tasksRes.data.length > 0) {
      const count = tasksRes.data.length;
      result.push({
        type: "overdue",
        partName: "",
        message: `${count} nesplněn${count === 1 ? "ý" : count < 5 ? "é" : "ých"} úkol${count === 1 ? "" : count < 5 ? "y" : "ů"} starší${count === 1 ? "" : "ch"} než 5 dní.`,
      });
    }

    setAlerts(result.slice(0, 3));
  };

  if (alerts.length === 0) return null;

  return (
    <div className="mb-4 space-y-1.5">
      {alerts.map((alert, i) => {
        const Icon = ALERT_ICONS[alert.type];
        return (
          <div
            key={i}
            className="flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/5 p-2.5 text-[0.6875rem] text-foreground"
          >
            <Icon className="w-3.5 h-3.5 text-primary shrink-0 mt-0.5" />
            <span>{alert.message}</span>
          </div>
        );
      })}
    </div>
  );
};

export default DidCoordinationAlerts;

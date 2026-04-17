import { useEffect, useState } from "react";
import { Users, Clock, Flame, ArrowRight } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";

/**
 * DidCoordinationAlerts — kompaktní operační upozornění s:
 *   - owner       (kdo dluží / koho se to týká)
 *   - deadline    (kdy mělo být)
 *   - lastUpdate  (jak je to staré)
 *   - reason      (proč je to nahoře)
 *
 * Cíl: na první pohled je vidět "kdo dluží co, jak je to staré, a proč je to nahoře".
 */

interface Alert {
  type: "overlap" | "intensity" | "overdue";
  icon: typeof Users;
  partName: string;
  owner: string | null;
  deadline: string | null;
  lastUpdate: string | null;
  reason: string;
  ctaPath?: string;
}

const formatRel = (iso: string | null): string => {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "—";
  const h = Math.round(ms / 3_600_000);
  if (h < 1) return "před chvílí";
  if (h < 24) return `před ${h}h`;
  const d = Math.round(h / 24);
  return d === 1 ? "včera" : `před ${d}d`;
};

const formatDeadline = (iso: string | null): string | null => {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("cs", { day: "2-digit", month: "2-digit" });
  } catch {
    return null;
  }
};

const detectOwner = (raw: string | null | undefined): string => {
  const low = (raw || "").toLowerCase();
  if (low.includes("han")) return "Hanička";
  if (low.includes("kát") || low.includes("kata")) return "Káťa";
  if (low.includes("both") || low.includes("obě")) return "obě";
  return "tým";
};

const DidCoordinationAlerts = ({
  refreshTrigger,
}: {
  refreshTrigger: number;
}) => {
  const navigate = useNavigate();
  const [alerts, setAlerts] = useState<Alert[]>([]);

  useEffect(() => {
    loadAlerts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTrigger]);

  const loadAlerts = async () => {
    const result: Alert[] = [];

    const twoDaysAgo = new Date(
      Date.now() - 48 * 60 * 60 * 1000,
    ).toISOString();
    const fiveDaysAgo = new Date(
      Date.now() - 5 * 24 * 60 * 60 * 1000,
    ).toISOString();

    // FÁZE 3 — canonical operational queue: primárně did_plan_items, adjunct did_therapist_tasks.
    // Manual tasks linked to plan_item are skipped (deduped against canonical).
    const [sessionsRes, registryRes, planItemsRes, tasksRes] = await Promise.all([
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
      // Primary: canonical Karel-generated action items
      supabase
        .from("did_plan_items")
        .select("id, action_required, priority, plan_type, section, created_at, review_at")
        .eq("status", "active")
        .in("priority", ["high", "urgent", "critical"])
        .order("created_at", { ascending: true })
        .limit(6),
      // Adjunct: manual tasks NOT linked to a canonical plan_item (dedup)
      supabase
        .from("did_therapist_tasks")
        .select("id, task, assigned_to, created_at, due_date, category, plan_item_id")
        .in("status", ["pending", "not_started"])
        .is("plan_item_id", null)
        .lt("created_at", fiveDaysAgo)
        .order("created_at", { ascending: true })
        .limit(6),
    ]);

    // 1. OVERLAP — both therapists worked with same part in 48h
    if (sessionsRes.data) {
      const byPart = new Map<
        string,
        { therapists: Set<string>; latest: string | null }
      >();
      for (const s of sessionsRes.data as any[]) {
        const key = s.part_name;
        if (!byPart.has(key))
          byPart.set(key, { therapists: new Set(), latest: null });
        const bucket = byPart.get(key)!;
        bucket.therapists.add(s.therapist);
        if (
          !bucket.latest ||
          (s.session_date && s.session_date > bucket.latest)
        ) {
          bucket.latest = s.session_date;
        }
      }
      for (const [partName, b] of byPart) {
        if (b.therapists.size >= 2) {
          result.push({
            type: "overlap",
            icon: Users,
            partName,
            owner: "obě",
            deadline: null,
            lastUpdate: b.latest,
            reason: "obě terapeutky pracovaly s touto částí v posledních 48h",
          });
        }
      }
    }

    // 2. INTENSITY — high emotional intensity (only entries updated in last 48h)
    if (registryRes.data) {
      const recentCutoff = new Date(
        Date.now() - 48 * 60 * 60 * 1000,
      ).toISOString();
      const seen = new Set<string>();
      for (const part of registryRes.data as any[]) {
        if (part.updated_at && part.updated_at < recentCutoff) continue;
        const key = (part.part_name || "").toUpperCase();
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({
          type: "intensity",
          icon: Flame,
          partName: part.part_name,
          owner: "tým",
          deadline: null,
          lastUpdate: part.updated_at,
          reason: `emoční intenzita ${part.last_emotional_intensity}/5`,
        });
        if (seen.size >= 3) break;
      }
    }

    // 3a. PLAN ITEMS (canonical) — Karel-generated overdue / high-priority actions
    if (planItemsRes.data) {
      for (const pi of planItemsRes.data as any[]) {
        result.push({
          type: "overdue",
          icon: Clock,
          partName: pi.section || pi.plan_type || "",
          owner: "tým",
          deadline: pi.review_at,
          lastUpdate: pi.created_at,
          reason: `[${(pi.priority || "high").toUpperCase()}] ${(pi.action_required || "akce bez popisu").slice(0, 90)}`,
          ctaPath: `/chat?did_submode=mamka&plan_item_id=${pi.id}`,
        });
      }
    }

    // 3b. MANUAL TASKS (adjunct, deduped) — only those NOT linked to canonical plan_item
    if (tasksRes.data) {
      for (const t of tasksRes.data as any[]) {
        const implicitDeadline =
          t.due_date ||
          new Date(
            new Date(t.created_at).getTime() + 5 * 86400000,
          ).toISOString();
        result.push({
          type: "overdue",
          icon: Clock,
          partName: "",
          owner: detectOwner(t.assigned_to),
          deadline: implicitDeadline,
          lastUpdate: t.created_at,
          reason: `(manuální) ${(t.task || "úkol bez popisu").slice(0, 90)}`,
          ctaPath: `/chat?did_submode=mamka&task_id=${t.id}`,
        });
      }
    }

    setAlerts(result.slice(0, 6));
  };

  if (alerts.length === 0) return null;

  return (
    <div className="mb-4 space-y-1.5">
      {alerts.map((alert, i) => {
        const Icon = alert.icon;
        const deadline = formatDeadline(alert.deadline);
        const lastUpd = formatRel(alert.lastUpdate);
        return (
          <div
            key={i}
            className="flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/5 p-2.5 text-[11.5px] text-foreground"
          >
            <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />

            <div className="min-w-0 flex-1 space-y-1">
              {/* Top meta row — owner / deadline / lastUpdate / partName */}
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                {alert.partName && (
                  <span className="font-medium text-foreground/85">
                    {alert.partName}
                  </span>
                )}
                {alert.owner && (
                  <span className="rounded-md bg-accent/15 px-1.5 py-0.5 text-[10.5px] font-medium text-foreground/80">
                    {alert.owner}
                  </span>
                )}
                {deadline && (
                  <span className="text-[10.5px] uppercase tracking-wide">
                    deadline {deadline}
                  </span>
                )}
                <span className="text-[10.5px] uppercase tracking-wide">
                  · {lastUpd}
                </span>
              </div>

              {/* Reason */}
              <div className="text-[11.5px] leading-5 text-foreground/85">
                {alert.reason}
              </div>

              {/* CTA */}
              {alert.ctaPath && (
                <button
                  onClick={() => {
                    try {
                      sessionStorage.setItem("karel_hub_section", "did");
                    } catch {
                      /* ignore */
                    }
                    navigate(alert.ctaPath!);
                  }}
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
                >
                  Otevřít
                  <ArrowRight className="h-3 w-3" />
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default DidCoordinationAlerts;

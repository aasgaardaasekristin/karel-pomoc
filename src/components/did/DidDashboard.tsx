import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Loader2, ListChecks, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { getAuthHeaders } from "@/lib/auth";
import { toast } from "sonner";
import type { DidSubMode } from "./DidSubModeSelector";
import DidSystemMap from "./DidSystemMap";
import DidSystemOverview from "./DidSystemOverview";
import DidTherapistTaskBoard from "./DidTherapistTaskBoard";
import DidAgreementsPanel from "./DidAgreementsPanel";
import DidMonthlyPanel from "./DidMonthlyPanel";
import DidPulseCheck from "./DidPulseCheck";
import DidColleagueView from "./DidColleagueView";
import DidSprava from "./DidSprava";

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
  onManualUpdate: () => void;
  isUpdating: boolean;
  syncProgress?: { current: number; total: number; currentName: string } | null;
  onQuickSubMode?: (subMode: DidSubMode) => void;
  onQuickThread?: (threadId: string, partName: string) => void;
  contextDocs?: string;
}

const DidDashboard = ({ onManualUpdate, isUpdating, syncProgress, onQuickThread }: Props) => {
  const [parts, setParts] = useState<PartActivity[]>([]);
  const [activeThreads, setActiveThreads] = useState<ActiveThreadSummary[]>([]);
  const [pendingWriteCount, setPendingWriteCount] = useState(0);
  const [isBootstrapping, setIsBootstrapping] = useState(false);
  const [isAuditing, setIsAuditing] = useState(false);
  const [isReformatting, setIsReformatting] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [loading, setLoading] = useState(true);

  const loadDashboardData = useCallback(async () => {
    setLoading(true);
    try {
      const [threadsRes, pendingWritesRes] = await Promise.all([
        supabase
          .from("did_threads")
          .select("id, part_name, last_activity_at, messages")
          .eq("sub_mode", "cast")
          .order("last_activity_at", { ascending: false }),
        supabase
          .from("did_pending_drive_writes")
          .select("id", { count: "exact", head: true })
          .eq("status", "pending"),
      ]);

      const threads = threadsRes.data || [];
      const now = Date.now();
      const latestByPart = new Map<string, ActiveThreadSummary>();
      const partRows: PartActivity[] = [];

      for (const thread of threads) {
        const lastSeen = thread.last_activity_at || null;
        const diffDays = lastSeen ? (now - new Date(lastSeen).getTime()) / (1000 * 60 * 60 * 24) : Number.POSITIVE_INFINITY;
        const status: PartActivity["status"] = diffDays <= 1 ? "active" : diffDays > 7 ? "warning" : "sleeping";

        if (!latestByPart.has(thread.part_name)) {
          latestByPart.set(thread.part_name, {
            id: thread.id,
            partName: thread.part_name,
            lastActivityAt: thread.last_activity_at,
            messageCount: Array.isArray(thread.messages) ? thread.messages.length : 0,
          });

          partRows.push({ name: thread.part_name, lastSeen, status });
        }
      }

      setParts(partRows);
      setActiveThreads(Array.from(latestByPart.values()));
      setPendingWriteCount(pendingWritesRes.count || 0);
    } catch (error) {
      console.error("Failed to load DID dashboard data:", error);
      toast.error("Nepodařilo se načíst DID dashboard");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadDashboardData(); }, [loadDashboardData, refreshTrigger]);

  const runDidBootstrap = useCallback(async () => {
    setIsBootstrapping(true);
    try {
      const headers = await getAuthHeaders();
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-memory-bootstrap`,
        { method: "POST", headers, body: JSON.stringify({ phase: "scan" }) }
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || "Bootstrap selhal");
      toast.success("Bootstrap DID paměti spuštěn");
      setRefreshTrigger((prev) => prev + 1);
    } catch (error: any) {
      console.error("Bootstrap failed:", error);
      toast.error(error?.message || "Bootstrap DID paměti selhal");
    } finally {
      setIsBootstrapping(false);
    }
  }, []);

  const runHealthAudit = useCallback(async () => {
    setIsAuditing(true);
    try {
      const headers = await getAuthHeaders();
      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-kartoteka-health`,
        { method: "POST", headers, body: JSON.stringify({}) }
      );
      if (!resp.ok) throw new Error(await resp.text());
      const data = await resp.json();
      toast.success(`Audit dokončen: ${data.cardsAudited} karet, ${data.tasksCreated} nových úkolů`);
      setRefreshTrigger((prev) => prev + 1);
    } catch (e: any) {
      toast.error("Audit kartotéky selhal");
    } finally {
      setIsAuditing(false);
    }
  }, []);

  const runReformat = useCallback(async () => {
    setIsReformatting(true);
    try {
      const headers = await getAuthHeaders();
      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-reformat-cards`,
        { method: "POST", headers, body: JSON.stringify({}) }
      );
      if (!resp.ok) throw new Error(await resp.text());
      const data = await resp.json();
      toast.success(`Přeformátováno: ${data.reformatted || 0} karet`);
      setRefreshTrigger((prev) => prev + 1);
    } catch (e: any) {
      toast.error("Přeformátování selhalo");
    } finally {
      setIsReformatting(false);
    }
  }, []);

  const warningParts = useMemo(() => parts.filter((part) => part.status === "warning"), [parts]);

  return (
    <div className="max-w-2xl mx-auto px-3 sm:px-4 py-4" data-no-swipe-back="true">
      <div className="mb-4 rounded-[calc(var(--radius)+0.5rem)] border border-border/70 bg-card/36 p-3 shadow-[0_10px_30px_hsl(var(--primary)/0.08)] backdrop-blur-md sm:p-4">
        {/* Správa button at top */}
        <div className="flex justify-end mb-3">
          <DidSprava
            onBootstrap={runDidBootstrap}
            isBootstrapping={isBootstrapping}
            onHealthAudit={runHealthAudit}
            isAuditing={isAuditing}
            onReformat={runReformat}
            isReformatting={isReformatting}
            onManualUpdate={onManualUpdate}
            isUpdating={isUpdating}
            refreshTrigger={refreshTrigger}
            onSelectPart={onQuickThread ? (partName) => onQuickThread("", partName) : undefined}
          />
        </div>

        <DidSystemOverview refreshTrigger={refreshTrigger} onTasksSynced={() => setRefreshTrigger((prev) => prev + 1)} />

        <div className="mb-4 rounded-lg border border-border/70 bg-card/38 p-3 backdrop-blur-sm sm:p-4">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-xs font-medium text-foreground flex items-center gap-1.5">
              <ListChecks className="w-3.5 h-3.5 text-primary" />
              Úkoly pro terapeutky
            </h4>
            {pendingWriteCount > 0 && (
              <Badge variant="secondary" className="text-[8px] h-4 px-1.5 flex items-center gap-1">
                <Upload className="w-2.5 h-2.5" />
                {pendingWriteCount} čeká na Drive
              </Badge>
            )}
          </div>
          <DidTherapistTaskBoard refreshTrigger={refreshTrigger} />
        </div>

        <div className="mb-4 rounded-lg border border-border/70 bg-card/38 p-3 backdrop-blur-sm sm:p-4">
          <DidAgreementsPanel refreshTrigger={refreshTrigger} onWeeklyCycleComplete={() => setRefreshTrigger((prev) => prev + 1)} />
        </div>

        <div className="mb-4 rounded-lg border border-border/70 bg-card/38 p-3 backdrop-blur-sm sm:p-4">
          <DidMonthlyPanel refreshTrigger={refreshTrigger} />
        </div>

        <div className="mb-4">
          <DidPulseCheck refreshTrigger={refreshTrigger} />
        </div>

        <div className="mb-4">
          <DidColleagueView refreshTrigger={refreshTrigger} />
        </div>

        {/* DidRegistryOverview and DidKartotekaHealth moved to DidSprava tabs */}

        {!loading && parts.length > 0 && (
          <DidSystemMap
            parts={parts}
            activeThreads={activeThreads}
            onQuickThread={onQuickThread}
            onDeletePart={async (partName) => {
              const { error } = await supabase
                .from("did_threads")
                .delete()
                .eq("part_name", partName)
                .eq("sub_mode", "cast");

              if (error) {
                toast.error(`Nepodařilo se smazat vlákna pro ${partName}`);
                return;
              }

              toast.success(`Vlákna pro „${partName}" smazána z mapy`);
              setParts((prev) => prev.filter((part) => part.name !== partName));
              setActiveThreads((prev) => prev.filter((thread) => thread.partName !== partName));
            }}
          />
        )}

        {warningParts.length > 0 && (
          <div className="mt-3 rounded-lg border border-border/70 bg-card/38 p-3 backdrop-blur-sm">
            <div className="mb-1 flex items-center gap-2 text-sm font-medium text-foreground">
              <AlertTriangle className="w-4 h-4 text-primary" />
              Upozornění na neaktivní části
            </div>
            <p className="text-xs text-muted-foreground">
              {warningParts.map((part) => part.name).join(", ")} – neaktivní více než 7 dní. Zvažte oslovení.
            </p>
          </div>
        )}
      </div>

      {loading && (
        <div className="mt-4 flex items-center justify-center py-6 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin mr-2" />
          Načítám dashboard...
        </div>
      )}
    </div>
  );
};

export default DidDashboard;

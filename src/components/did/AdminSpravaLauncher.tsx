/**
 * AdminSpravaLauncher — Slice 3A (2026-04-21).
 *
 * Před tímto passem visel <DidSprava /> Dialog launcher z hlavičky
 * `DidDashboard` (= z Pracovny). To byla inverze: admin tooling 1 click
 * pod hlavní pracovní plochou. Spec Slice 2 (sekce G) tuto plochu zamkl
 * jako Inspect/Admin layer. Tento launcher proto:
 *
 *   - drží veškerý wiring pro `<DidSprava>` (bootstrap / audit / reformat
 *     / centrum-sync / cleanup-tasks / refresh-memory)
 *   - renderuje samotný `<DidSprava>` Dialog launcher
 *   - žije v `AdminSurface` (DidContentRouter), takže Pracovna je čistá
 *
 * Žádné UI se tím nemění — Dialog se otevírá stejně jako dřív, jen se
 * tlačítko „Správa" přesunulo z headeru Pracovny do Admin plochy.
 */
import { useCallback, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getAuthHeaders } from "@/lib/auth";
import { toast } from "sonner";
import DidSprava from "./DidSprava";
import { pragueTodayISO } from "@/lib/dateOnlyTaskHelpers";

interface Props {
  onManualUpdate: () => void;
  isUpdating: boolean;
  onRefreshMemory?: () => void;
  isRefreshingMemory?: boolean;
}

export default function AdminSpravaLauncher({
  onManualUpdate,
  isUpdating,
  onRefreshMemory,
  isRefreshingMemory,
}: Props) {
  const [isBootstrapping, setIsBootstrapping] = useState(false);
  const [isAuditing, setIsAuditing] = useState(false);
  const [isReformatting, setIsReformatting] = useState(false);
  const [isCentrumSyncing, setIsCentrumSyncing] = useState(false);
  const [isCleaningTasks, setIsCleaningTasks] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  const runDidBootstrap = useCallback(async () => {
    setIsBootstrapping(true);
    try {
      const headers = await getAuthHeaders();
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-memory-bootstrap`,
        { method: "POST", headers, body: JSON.stringify({ phase: "scan" }) },
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || "Bootstrap selhal");
      toast.success("Bootstrap DID paměti spuštěn");
      setRefreshTrigger((p) => p + 1);
    } catch (e: any) {
      toast.error(e?.message || "Bootstrap DID paměti selhal");
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
        { method: "POST", headers, body: JSON.stringify({}) },
      );
      if (!resp.ok) throw new Error(await resp.text());
      const data = await resp.json();
      toast.success(`Audit dokončen: ${data.cardsAudited} karet, ${data.tasksCreated} nových úkolů`);
      setRefreshTrigger((p) => p + 1);
    } catch {
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
        { method: "POST", headers, body: JSON.stringify({}) },
      );
      if (!resp.ok) throw new Error(await resp.text());
      const data = await resp.json();
      toast.success(`Přeformátováno: ${data.reformatted || 0} karet`);
      setRefreshTrigger((p) => p + 1);
    } catch {
      toast.error("Přeformátování selhalo");
    } finally {
      setIsReformatting(false);
    }
  }, []);

  const runCentrumSync = useCallback(async () => {
    setIsCentrumSyncing(true);
    try {
      const headers = await getAuthHeaders();
      const today = pragueTodayISO();
      const [centrumResp, dashboardResp] = await Promise.allSettled([
        fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-centrum-sync`, {
          method: "POST", headers, body: JSON.stringify({}),
        }),
        fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-daily-dashboard`, {
          method: "POST", headers, body: JSON.stringify({ date: today, trigger: "manual" }),
        }),
      ]);
      const results: string[] = [];
      if (centrumResp.status === "fulfilled" && centrumResp.value.ok) {
        const data = await centrumResp.value.json();
        results.push(data.summary || "Centrum ✅");
      } else {
        results.push("Centrum ❌");
      }
      if (dashboardResp.status === "fulfilled" && dashboardResp.value.ok) results.push("Dashboard ✅");
      toast.success(results.join(" | "));
      setRefreshTrigger((p) => p + 1);
    } catch {
      toast.error("Synchronizace Centra selhala");
    } finally {
      setIsCentrumSyncing(false);
    }
  }, []);

  const runCleanupTasks = useCallback(async () => {
    setIsCleaningTasks(true);
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      const { data, error } = await supabase
        .from("did_therapist_tasks")
        .update({ status: "archived" } as any)
        .in("status", ["not_started", "pending"] as any)
        .lt("created_at", sevenDaysAgo)
        .select("id");
      if (error) throw error;
      toast.success(`Archivováno ${data?.length || 0} starých úkolů`);
      setRefreshTrigger((p) => p + 1);
    } catch {
      toast.error("Čištění úkolů selhalo");
    } finally {
      setIsCleaningTasks(false);
    }
  }, []);

  return (
    <DidSprava
      onBootstrap={runDidBootstrap}
      isBootstrapping={isBootstrapping}
      onHealthAudit={runHealthAudit}
      isAuditing={isAuditing}
      onReformat={runReformat}
      isReformatting={isReformatting}
      onManualUpdate={onManualUpdate}
      isUpdating={isUpdating}
      onCentrumSync={runCentrumSync}
      isCentrumSyncing={isCentrumSyncing}
      onCleanupTasks={runCleanupTasks}
      isCleaningTasks={isCleaningTasks}
      onRefreshMemory={onRefreshMemory}
      isRefreshingMemory={isRefreshingMemory}
      refreshTrigger={refreshTrigger}
    />
  );
}

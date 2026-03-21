import { useState, useRef, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getAuthHeaders } from "@/lib/auth";
import { toast } from "sonner";
import { clearMessages, DID_DOCS_LOADED_KEY, DID_SESSION_ID_KEY } from "@/lib/chatHelpers";
import type { DidThread } from "@/hooks/useDidThreads";
import type { DidFlowState } from "@/lib/chatHelpers";

export interface SyncProgress {
  current: number;
  total: number;
  currentName: string;
}

interface UseManualUpdateDeps {
  activeThread: DidThread | null;
  messages: { role: string; content: string }[];
  didSubMode: string | null;
  didInitialContext: string;
  didSessionId: string | null;
  didThreads: { updateThreadMessages: (id: string, msgs: { role: string; content: string }[]) => Promise<void> };
  saveConversation: (subMode: string, messages: any[], context: string, sessionId?: string) => Promise<void>;
  refreshHistory: () => Promise<void>;
  setActiveThread: React.Dispatch<React.SetStateAction<DidThread | null>>;
  setMessages: React.Dispatch<React.SetStateAction<{ role: "user" | "assistant"; content: string }[]>>;
  setDidSubMode: React.Dispatch<React.SetStateAction<any>>;
  setDidInitialContext: React.Dispatch<React.SetStateAction<string>>;
  setDidDocsLoaded: React.Dispatch<React.SetStateAction<boolean>>;
  setDidSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  setDidFlowState: React.Dispatch<React.SetStateAction<DidFlowState>>;
}

export const useManualUpdate = (deps: UseManualUpdateDeps) => {
  const [isLoading, setIsLoading] = useState(false);
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);

  // Refs for values read inside async polling loop
  const activeThreadRef = useRef(deps.activeThread);
  const messagesRef = useRef(deps.messages);
  const didSubModeRef = useRef(deps.didSubMode);
  const didInitialContextRef = useRef(deps.didInitialContext);
  const didSessionIdRef = useRef(deps.didSessionId);
  const didThreadsRef = useRef(deps.didThreads);

  useEffect(() => { activeThreadRef.current = deps.activeThread; }, [deps.activeThread]);
  useEffect(() => { messagesRef.current = deps.messages; }, [deps.messages]);
  useEffect(() => { didSubModeRef.current = deps.didSubMode; }, [deps.didSubMode]);
  useEffect(() => { didInitialContextRef.current = deps.didInitialContext; }, [deps.didInitialContext]);
  useEffect(() => { didSessionIdRef.current = deps.didSessionId; }, [deps.didSessionId]);
  useEffect(() => { didThreadsRef.current = deps.didThreads; }, [deps.didThreads]);

  const isLoadingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  // Stable setter refs (these never change but we destructure for clarity)
  const {
    saveConversation, refreshHistory,
    setActiveThread, setMessages, setDidSubMode, setDidInitialContext,
    setDidDocsLoaded, setDidSessionId, setDidFlowState,
  } = deps;

  useEffect(() => {
    return () => { abortRef.current?.abort(); };
  }, []);

  const run = useCallback(async () => {
    if (isLoadingRef.current) return;
    isLoadingRef.current = true;
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    const signal = abortRef.current.signal;
    setIsLoading(true);

    const GLOBAL_TIMEOUT_MS = 10 * 60 * 1000;
    const globalDeadline = Date.now() + GLOBAL_TIMEOUT_MS;

    try {
      // Pre-save current data
      const at = activeThreadRef.current;
      const msgs = messagesRef.current;
      const subMode = didSubModeRef.current;
      const ctx = didInitialContextRef.current;
      const sessId = didSessionIdRef.current;

      if (at && msgs.length >= 2) {
        await didThreadsRef.current.updateThreadMessages(at.id, msgs);
      }
      if (subMode && msgs.length >= 2) {
        await saveConversation(subMode, msgs, ctx, sessId ?? undefined);
      }
      await new Promise(r => setTimeout(r, 500));

      if (signal.aborted) return;

      const headers = await getAuthHeaders();

      // Force cleanup stale mirror jobs
      const staleCutoff = new Date(Date.now() - 3 * 60 * 1000).toISOString();
      await supabase.from("karel_memory_logs")
        .update({ log_type: "mirror_failed", summary: "Frontend force cleanup", updated_at: new Date().toISOString() } as any)
        .eq("log_type", "mirror_job")
        .lt("updated_at", staleCutoff);

      if (signal.aborted) return;

      // Phase 1: Mirror
      let mirrorDone = false;
      let mirrorSkipped = false;
      try {
        console.log("[mirror] Starting mirror init call with force=true");
        const initRes = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-memory-mirror`, {
          method: "POST", headers, body: JSON.stringify({ force: true }),
        });
        console.log("[mirror] Init response status:", initRes.status);
        if (!initRes.ok) {
          const errorBody = await initRes.text();
          console.error("[mirror] Init call failed:", initRes.status, errorBody.slice(0, 300));
          toast.error(`Mirror chyba ${initRes.status}`);
        } else {
          const initData = await initRes.json();
          console.log("[mirror] Init response data:", JSON.stringify(initData).slice(0, 500));

          if (initData.status === "skipped") {
            console.warn("[mirror] Mirror skipped:", initData.reason);
            toast.info(initData.reason || "Mirror přeskočen.");
            mirrorSkipped = true;
          } else if (!initData.jobId) {
            console.error("[mirror] No jobId in response:", initData);
            toast.error(initData.error || "Nepodařilo se vytvořit mirror job.");
          } else {
            const jobId = initData.jobId;
            console.log("[mirror] Job created:", jobId);
            toast.success("Mirror spuštěn...");

            let consecutiveErrors = 0;
            for (let i = 0; i < 120; i++) {
              if (signal.aborted) return;
              if (Date.now() > globalDeadline) {
                console.warn("[mirror] Global 10min timeout reached");
                toast.warning("Mirror trvá příliš dlouho, pokračuji dál...");
                break;
              }
              if (i > 0) await new Promise(r => setTimeout(r, 2000));

              try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 55_000);
                const step = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-memory-mirror`, {
                  method: "POST", headers, body: JSON.stringify({ mode: "continue", jobId }),
                  signal: controller.signal,
                }).then(r => { clearTimeout(timeout); return r.json(); });
                consecutiveErrors = 0;
                console.log(`[mirror] Continue #${i} response:`, JSON.stringify(step).slice(0, 300));

                if (step.status === "done") {
                  toast.success(`Mirror dokončen: ${step.summary?.slice(0, 100) || "OK"}`);
                  mirrorDone = true;
                  break;
                }
                if (step.status === "error") {
                  console.error("[mirror] Job error:", step.summary);
                  toast.error(step.summary || "Chyba mirror jobu.");
                  break;
                }
                if (step.status === "idle") {
                  console.log("[mirror] Job idle (already finished)");
                  toast.info("Mirror dokončen.");
                  mirrorDone = true;
                  break;
                }
              } catch (stepError: any) {
                consecutiveErrors++;
                console.error(`[mirror] Continue error #${consecutiveErrors}:`, stepError.message);
                if (consecutiveErrors >= 5) {
                  toast.error("Mirror: příliš mnoho chyb, pokračuji na registr...");
                  break;
                }
                await new Promise(r => setTimeout(r, 3000));
              }
            }
          }
        }
      } catch (mirrorError: any) {
        console.error("[mirror] Unexpected error:", mirrorError);
        toast.error(`Mirror selhal: ${mirrorError.message?.slice(0, 100)}`);
      }

      if (signal.aborted) return;

      console.log("[mirror] Mirror phase complete. mirrorDone:", mirrorDone, "mirrorSkipped:", mirrorSkipped);

      // Phase 2: Registry sync
      const REGISTRY_TIMEOUT_MS = 3 * 60 * 1000;
      const registrySyncWork = async () => {
        console.log("[registry-sync] registrySyncWork:start", {
          now: Date.now(), globalDeadline,
          hasGlobalDeadline: typeof globalDeadline === "number" && Number.isFinite(globalDeadline),
          remainingMs: typeof globalDeadline === "number" ? globalDeadline - Date.now() : null,
        });
        const syncHeaders = await getAuthHeaders();
        const listController = new AbortController();
        const listTimeout = setTimeout(() => listController.abort(), 30_000);
        const listRes = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-daily-cycle`, {
          method: "POST", headers: syncHeaders,
          body: JSON.stringify({ syncRegistry: true, syncMode: "list" }),
          signal: listController.signal,
        });
        clearTimeout(listTimeout);
        const listData = await listRes.json();
        const entries = listData.entries || [];
        const total = entries.length;
        console.log("[registry-sync] list loaded", {
          total, globalDeadline,
          hasGlobalDeadline: typeof globalDeadline === "number" && Number.isFinite(globalDeadline),
        });
        if (total === 0) return { synced: 0, skipped: 0, errors: 0, total: 0 };
        let synced = 0, skipped = 0, errors = 0;
        setSyncProgress({ current: 0, total, currentName: "..." });
        const deadline = Date.now() + REGISTRY_TIMEOUT_MS;
        console.log("[registry-sync] loop deadline created", { deadline, globalDeadline, total });
        for (let i = 0; i < total; i++) {
          if (signal.aborted) return { synced, skipped, errors, total };
          if (Date.now() > deadline || Date.now() > globalDeadline) {
            console.warn(`[registry-sync] Timeout at ${i + 1}/${total}`);
            break;
          }
          const entry = entries[i];
          const displayName = (entry.fileName || "").replace(/^\d+_/, "").replace(/\.[^.]+$/, "");
          setSyncProgress({ current: i + 1, total, currentName: displayName });
          try {
            const controller = new AbortController();
            const t = setTimeout(() => controller.abort(), 15_000);
            const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-daily-cycle`, {
              method: "POST", headers: syncHeaders,
              body: JSON.stringify({ syncRegistry: true, syncMode: "process_one", fileId: entry.fileId, fileName: entry.fileName, folderLabel: entry.folderLabel }),
              signal: controller.signal,
            });
            clearTimeout(t);
            const data = await res.json();
            if (data.result === "skip") skipped++;
            else synced++;
          } catch { errors++; }
        }
        return { synced, skipped, errors, total };
      };

      try {
        toast.info("Synchronizuji registr...");
        const result = await Promise.race([
          registrySyncWork(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), REGISTRY_TIMEOUT_MS + 5000)),
        ]);
        console.log("[registry-sync] before setSyncProgress(null) after Promise.race", { result, globalDeadline });
        setSyncProgress(null);
        if (result) {
          const { synced, skipped, errors, total } = result;
          if (total === 0) toast.info("Registr: žádné položky k synchronizaci");
          else if (synced > 0 || skipped > 0) toast.success(`Registr: ${synced} aktualizováno, ${skipped} přeskočeno${errors ? `, ${errors} chyb` : ""}`);
        } else {
          toast.warning("Synchronizace registru vypršela, ale data mohla být uložena");
        }
      } catch (e) {
        console.warn("Registry sync failed:", e);
        console.log("[registry-sync] before setSyncProgress(null) in catch", { error: e, globalDeadline });
        setSyncProgress(null);
        toast.error("Synchronizace registru selhala");
      }

      // Clear local DID data
      setActiveThread(null);
      setMessages([]);
      setDidSubMode(null);
      setDidInitialContext("");
      setDidDocsLoaded(false);
      setDidSessionId(null);
      setDidFlowState("entry");
      clearMessages("childcare");
      try {
        localStorage.removeItem("karel_did_submode");
        localStorage.removeItem("karel_did_context");
        localStorage.removeItem(DID_DOCS_LOADED_KEY);
        localStorage.removeItem(DID_SESSION_ID_KEY);
      } catch {}

      void refreshHistory().catch((historyError) => {
        console.warn("History refresh failed after manual update:", historyError);
      });
    } catch (error) {
      console.error("Manual update error:", error);
      toast.error(error instanceof Error ? error.message : "Chyba při aktualizaci kartotéky");
    } finally {
      console.log("[registry-sync] before setSyncProgress(null) in finally", { globalDeadline });
      setSyncProgress(null);
      isLoadingRef.current = false;
      setIsLoading(false);
    }
  }, []); // Empty deps — everything read from refs or stable setters

  return { isLoading, syncProgress, run };
};

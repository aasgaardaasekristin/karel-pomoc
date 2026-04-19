import { useState, useCallback, useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  hasMeaningfulPartActivity,
  normalizePartKey,
  sanitizePartName,
} from "@/lib/didPartNaming";

export type WorkspaceType =
  | "task"
  | "question"
  | "session"
  // Briefing ask vlákna — kanonické persistentní workspace pro klik
  // v Karlově denním přehledu (DidDailyBriefingPanel). workspace_id je
  // stabilní serverové UUID briefing itemu (ask_hanka[].id / ask_kata[].id).
  | "ask_hanka"
  | "ask_kata"
  | null;

export interface DidThread {
  id: string;
  partName: string;
  partLanguage: string;
  subMode: string;
  messages: { role: string; content: string }[];
  startedAt: string;
  lastActivityAt: string;
  isProcessed: boolean;
  themePreset: string;
  themeConfig: Record<string, any>;
  threadEmoji: string;
  threadLabel: string;
  enteredName: string;
  // BUGFIX: canonical workspace identity. When non-null, this thread is the
  // single persistent workspace for the referenced task / question / session.
  // Reopening the same source row MUST resolve back to the same thread.
  workspaceType: WorkspaceType;
  workspaceId: string | null;
}

const rowToThread = (row: any): DidThread | null => {
  const sanitizedPartName = sanitizePartName(row.part_name);
  if (!sanitizedPartName) return null;

  return {
    id: row.id,
    partName: sanitizedPartName,
    partLanguage: row.part_language || "cs",
    subMode: row.sub_mode,
    messages: (row.messages ?? []) as { role: string; content: string }[],
    startedAt: row.started_at,
    lastActivityAt: row.last_activity_at,
    isProcessed: row.is_processed,
    themePreset: row.theme_preset || "",
    themeConfig: (row as any).theme_config || {},
    threadEmoji: (row as any).thread_emoji || "",
    threadLabel: (row as any).thread_label || "",
    enteredName: (row as any).entered_name || "",
    workspaceType: ((row as any).workspace_type ?? null) as WorkspaceType,
    workspaceId: ((row as any).workspace_id ?? null) as string | null,
  };
};

const mapRowsToThreads = (rows: any[]) =>
  (rows ?? []).map(rowToThread).filter((thread): thread is DidThread => Boolean(thread));

const filterCastThreads = (rows: any[], activePartKeys: Set<string>) => {
  const seen = new Set<string>();

  return mapRowsToThreads(rows).filter((thread) => {
    if (thread.subMode !== "cast") return true;

    const partKey = normalizePartKey(thread.partName);
    if (!partKey || !activePartKeys.has(partKey)) return false;
    if (!hasMeaningfulPartActivity(thread.messages)) return false;

    // Deduplicate by normalized partKey only — "arthur", "ARTHUR", "Artík" all collapse
    // Also normalize the alias to catch case variants
    const aliasKey = normalizePartKey(thread.enteredName || thread.threadLabel || "");
    const dedupeKey = aliasKey && aliasKey !== partKey ? `${partKey}::${aliasKey}` : partKey;
    if (seen.has(dedupeKey)) return false;

    seen.add(dedupeKey);
    return true;
  });
};

const getActiveRegistryPartKeys = async () => {
  const { data, error } = await supabase
    .from("did_part_registry")
    .select("part_name, display_name")
    .eq("status", "active");

  if (error) {
    console.error("Fetch active registry parts error:", error);
    return new Set<string>();
  }

  return new Set(
    (data ?? [])
      .flatMap((row: any) => [row.part_name, row.display_name])
      .map((value) => normalizePartKey(value))
      .filter(Boolean),
  );
};

export interface CreateThreadOptions {
  threadLabel?: string;
  enteredName?: string;
  forceNew?: boolean;
  // BUGFIX: when supplied, thread is bound to a canonical workspace
  // (task / question / session). Reopen flows must look up by this pair
  // before creating a new thread, so the same task always returns the
  // same persistent workspace.
  workspaceType?: WorkspaceType;
  workspaceId?: string | null;
}

export const useDidThreads = () => {
  const [threads, setThreads] = useState<DidThread[]>([]);
  const [loading, setLoading] = useState(false);
  const lastSubModeRef = useRef<string | undefined>(undefined);
  const lastFetchAllRef = useRef<string | undefined>(undefined);

  const refreshActiveThreads = useCallback(async () => {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const [activePartKeys, threadsRes] = await Promise.all([
      getActiveRegistryPartKeys(),
      supabase
        .from("did_threads")
        .select("*")
        .gte("last_activity_at", cutoff)
        .eq("sub_mode", "cast")
        .order("last_activity_at", { ascending: false }),
    ]);

    if (threadsRes.error) {
      console.error("Refresh active threads error:", threadsRes.error);
      return;
    }

    setThreads(filterCastThreads(threadsRes.data || [], activePartKeys));
  }, []);

  useEffect(() => {
    const channel = supabase
      .channel("did_threads_realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "did_threads" },
        async () => {
          if (lastFetchAllRef.current) {
            const { data, error } = await supabase
              .from("did_threads")
              .select("*")
              .eq("sub_mode", lastFetchAllRef.current)
              .order("last_activity_at", { ascending: false })
              .limit(50);

            if (!error) setThreads(mapRowsToThreads(data || []));
            return;
          }

          await refreshActiveThreads();
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [refreshActiveThreads]);

  const fetchActiveThreads = useCallback(async (subMode?: string) => {
    lastSubModeRef.current = subMode;
    lastFetchAllRef.current = undefined;
    setLoading(true);

    try {
      if (subMode && subMode !== "cast") {
        const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const { data, error } = await supabase
          .from("did_threads")
          .select("*")
          .gte("last_activity_at", cutoff24h)
          .eq("sub_mode", subMode)
          .order("last_activity_at", { ascending: false });

        if (error) {
          console.error("Fetch threads error:", error);
          return;
        }

        setThreads(mapRowsToThreads(data || []));
        return;
      }

      await refreshActiveThreads();
    } finally {
      setLoading(false);
    }
  }, [refreshActiveThreads]);

  const fetchAllThreads = useCallback(async (subMode: string) => {
    lastFetchAllRef.current = subMode;
    lastSubModeRef.current = undefined;
    setLoading(true);

    try {
      const { data, error } = await supabase
        .from("did_threads")
        .select("*")
        .eq("sub_mode", subMode)
        .order("last_activity_at", { ascending: false })
        .limit(50);

      if (error) {
        console.error("Fetch all threads error:", error);
        return;
      }

      setThreads(mapRowsToThreads(data || []));
    } finally {
      setLoading(false);
    }
  }, []);

  const createThread = useCallback(async (
    partName: string,
    subMode: string,
    partLanguage: string = "cs",
    initialMessages: { role: string; content: string }[] = [],
    options?: CreateThreadOptions,
  ): Promise<DidThread | null> => {
    const safePartName = sanitizePartName(partName);
    if (!safePartName) {
      console.error("Invalid part name for thread:", partName);
      return null;
    }

    // BUGFIX (P1): when a workspace identity is supplied, NEVER fall back to
    // generic part_name + sub_mode dedupe. The canonical lookup is by
    // (workspace_type, workspace_id) only — anything else risks bouncing the
    // new workspace into an unrelated "Karel" task/question/session thread.
    if (options?.workspaceType && options?.workspaceId) {
      const existingByWorkspace = await supabase
        .from("did_threads")
        .select("*")
        .eq("workspace_type", options.workspaceType)
        .eq("workspace_id", options.workspaceId)
        .order("last_activity_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (existingByWorkspace.data) {
        const thread = rowToThread(existingByWorkspace.data);
        if (thread) {
          setThreads((prev) => prev.some((t) => t.id === thread.id) ? prev : [thread, ...prev]);
          return thread;
        }
      }
      // No existing workspace thread → fall through to insert. Skip the old
      // part_name dedupe entirely; that path would only cause cross-task leaks.
    } else if (!options?.forceNew) {
      // Legacy dedupe path — only used for ad-hoc therapist/cast threads
      // without a workspace identity.
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data: existing } = await supabase
        .from("did_threads")
        .select("*")
        .ilike("part_name", safePartName)
        .eq("sub_mode", subMode)
        .gte("last_activity_at", cutoff)
        .order("last_activity_at", { ascending: false })
        .limit(1);

      if (existing && existing.length > 0) {
        const thread = rowToThread(existing[0]);
        if (!thread) return null;

        setThreads((prev) => {
          if (prev.some((t) => t.id === thread.id)) return prev;
          return [thread, ...prev];
        });
        return thread;
      }
    }

    const { data, error } = await supabase
      .from("did_threads")
      .insert({
        part_name: safePartName,
        sub_mode: subMode,
        part_language: partLanguage,
        messages: initialMessages as any,
        last_activity_at: new Date().toISOString(),
        is_processed: false,
        processed_at: null,
        thread_label: options?.threadLabel || "",
        entered_name: options?.enteredName || "",
        workspace_type: options?.workspaceType ?? null,
        workspace_id: options?.workspaceId ?? null,
      } as any)
      .select()
      .single();

    if (error) {
      console.error("Create thread error:", error);
      return null;
    }

    const thread = rowToThread(data);
    if (!thread) return null;

    setThreads((prev) => [thread, ...prev]);
    return thread;
  }, []);

  const updateThreadMessages = useCallback(async (
    threadId: string,
    messages: { role: string; content: string }[],
  ) => {
    const timestamp = new Date().toISOString();
    const { error } = await supabase
      .from("did_threads")
      .update({
        messages: messages as any,
        last_activity_at: timestamp,
        is_processed: false,
        processed_at: null,
      })
      .eq("id", threadId);

    if (error) {
      console.error("Update thread error:", error);
    }

    setThreads((prev) =>
      prev.map((thread) =>
        thread.id === threadId
          ? { ...thread, messages, lastActivityAt: timestamp, isProcessed: false }
          : thread,
      ),
    );
  }, []);

  const getThreadByPart = useCallback(async (
    partName: string,
    subMode: string,
  ): Promise<DidThread | null> => {
    const safePartName = sanitizePartName(partName);
    if (!safePartName) return null;

    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from("did_threads")
      .select("*")
      .ilike("part_name", safePartName)
      .eq("sub_mode", subMode)
      .gte("last_activity_at", cutoff)
      .order("last_activity_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !data) return null;

    const thread = rowToThread(data);
    if (!thread) return null;
    if (subMode === "cast" && !hasMeaningfulPartActivity(thread.messages)) return null;

    return thread;
  }, []);

  // BUGFIX: canonical workspace lookup. Returns the most recent persistent
  // thread bound to (workspaceType, workspaceId), regardless of activity age.
  // Used by deep-link reopen flows so the same task / question / session
  // always returns the same workspace.
  const getThreadByWorkspace = useCallback(async (
    workspaceType: Exclude<WorkspaceType, null>,
    workspaceId: string,
  ): Promise<DidThread | null> => {
    if (!workspaceId) return null;
    const { data, error } = await supabase
      .from("did_threads")
      .select("*")
      .eq("workspace_type", workspaceType)
      .eq("workspace_id", workspaceId)
      .order("last_activity_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    return rowToThread(data);
  }, []);

  const deleteThread = useCallback(async (threadId: string) => {
    await supabase.from("did_threads").delete().eq("id", threadId);
    setThreads((prev) => prev.filter((thread) => thread.id !== threadId));
  }, []);

  const updateThreadTheme = useCallback(async (threadId: string, themePreset: string) => {
    const { error } = await supabase
      .from("did_threads")
      .update({ theme_preset: themePreset } as any)
      .eq("id", threadId);

    if (error) {
      console.error("Update thread theme error:", error);
      return;
    }

    setThreads((prev) =>
      prev.map((thread) =>
        thread.id === threadId ? { ...thread, themePreset } : thread,
      ),
    );
  }, []);

  const updateThreadThemeConfig = useCallback(async (threadId: string, themePreset: string, themeConfig: Record<string, any>) => {
    const emoji = themeConfig.thread_emoji || "";
    const { error } = await supabase
      .from("did_threads")
      .update({ 
        theme_preset: themePreset,
        theme_config: themeConfig,
        thread_emoji: emoji,
      } as any)
      .eq("id", threadId);

    if (error) {
      console.error("Update thread theme config error:", error);
      return;
    }

    setThreads((prev) =>
      prev.map((thread) =>
        thread.id === threadId ? { ...thread, themePreset, themeConfig, threadEmoji: emoji } : thread,
      ),
    );
  }, []);

  return {
    threads,
    loading,
    fetchActiveThreads,
    fetchAllThreads,
    createThread,
    updateThreadMessages,
    getThreadByPart,
    getThreadByWorkspace,
    deleteThread,
    updateThreadTheme,
    updateThreadThemeConfig,
  };
};

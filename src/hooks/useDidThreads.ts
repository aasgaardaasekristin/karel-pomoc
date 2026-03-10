import { useState, useCallback, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface DidThread {
  id: string;
  partName: string;
  partLanguage: string;
  subMode: string;
  messages: { role: string; content: string }[];
  startedAt: string;
  lastActivityAt: string;
  isProcessed: boolean;
}

const rowToThread = (row: any): DidThread => ({
  id: row.id,
  partName: row.part_name,
  partLanguage: row.part_language || "cs",
  subMode: row.sub_mode,
  messages: (row.messages ?? []) as { role: string; content: string }[],
  startedAt: row.started_at,
  lastActivityAt: row.last_activity_at,
  isProcessed: row.is_processed,
});

export const useDidThreads = () => {
  const [threads, setThreads] = useState<DidThread[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchActiveThreads = useCallback(async (subMode?: string) => {
    setLoading(true);
    try {
      const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      let query = supabase
        .from("did_threads")
        .select("*")
        .gte("last_activity_at", cutoff24h)
        .order("last_activity_at", { ascending: false });

      if (subMode) {
        query = query.eq("sub_mode", subMode);
      }

      const { data, error } = await query;
      if (error) {
        console.error("Fetch threads error:", error);
        return;
      }
      setThreads((data || []).map(rowToThread));
    } finally {
      setLoading(false);
    }
  }, []);

  const createThread = useCallback(async (
    partName: string,
    subMode: string,
    partLanguage: string = "cs",
    initialMessages: { role: string; content: string }[] = []
  ): Promise<DidThread | null> => {
    // Double-check for existing thread to prevent duplicates (race condition guard)
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: existing } = await supabase
      .from("did_threads")
      .select("*")
      .ilike("part_name", partName)
      .eq("sub_mode", subMode)
      .gte("last_activity_at", cutoff)
      .order("last_activity_at", { ascending: false })
      .limit(1);

    if (existing && existing.length > 0) {
      console.log(`[createThread] Found existing thread for "${partName}", reusing it`);
      const thread = rowToThread(existing[0]);
      setThreads(prev => {
        if (prev.some(t => t.id === thread.id)) return prev;
        return [thread, ...prev];
      });
      return thread;
    }

    const { data, error } = await supabase
      .from("did_threads")
      .insert({
        part_name: partName,
        sub_mode: subMode,
        part_language: partLanguage,
        messages: initialMessages as any,
        last_activity_at: new Date().toISOString(),
        is_processed: false,
        processed_at: null,
      })
      .select()
      .single();

    if (error) {
      console.error("Create thread error:", error);
      return null;
    }
    const thread = rowToThread(data);
    setThreads(prev => [thread, ...prev]);
    return thread;
  }, []);

  const updateThreadMessages = useCallback(async (
    threadId: string,
    messages: { role: string; content: string }[]
  ) => {
    const { error } = await supabase
      .from("did_threads")
      .update({
        messages: messages as any,
        last_activity_at: new Date().toISOString(),
        is_processed: false,
        processed_at: null,
      })
      .eq("id", threadId);

    if (error) {
      console.error("Update thread error:", error);
    }

    setThreads(prev => prev.map(t =>
      t.id === threadId
        ? { ...t, messages, lastActivityAt: new Date().toISOString(), isProcessed: false }
        : t
    ));
  }, []);

  const getThreadByPart = useCallback(async (
    partName: string,
    subMode: string
  ): Promise<DidThread | null> => {
    // Check 24h window by last activity
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from("did_threads")
      .select("*")
      .ilike("part_name", partName)
      .eq("sub_mode", subMode)
      .gte("last_activity_at", cutoff)
      .order("last_activity_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !data) return null;
    return rowToThread(data);
  }, []);

  const deleteThread = useCallback(async (threadId: string) => {
    await supabase.from("did_threads").delete().eq("id", threadId);
    setThreads(prev => prev.filter(t => t.id !== threadId));
  }, []);

  return {
    threads,
    loading,
    fetchActiveThreads,
    createThread,
    updateThreadMessages,
    getThreadByPart,
    deleteThread,
  };
};

import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface ResearchThread {
  id: string;
  topic: string;
  messages: { role: string; content: string }[];
  createdBy: string;
  startedAt: string;
  lastActivityAt: string;
  isDeleted: boolean;
  isProcessed: boolean;
}

const rowToThread = (row: any): ResearchThread => ({
  id: row.id,
  topic: row.topic,
  messages: (row.messages ?? []) as { role: string; content: string }[],
  createdBy: row.created_by,
  startedAt: row.started_at,
  lastActivityAt: row.last_activity_at,
  isDeleted: row.is_deleted,
  isProcessed: row.is_processed,
});

export const useResearchThreads = () => {
  const [threads, setThreads] = useState<ResearchThread[]>([]);
  const [loading, setLoading] = useState(false);

  // Fetch active (non-deleted) threads from last 7 days
  const fetchThreads = useCallback(async () => {
    setLoading(true);
    try {
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const { data, error } = await supabase
        .from("research_threads")
        .select("*")
        .eq("is_deleted", false)
        .gte("started_at", weekAgo)
        .order("last_activity_at", { ascending: false });
      if (!error && data) setThreads(data.map(rowToThread));
    } finally {
      setLoading(false);
    }
  }, []);

  const createThread = useCallback(async (topic: string, createdBy: string, initialMessages: { role: string; content: string }[]): Promise<ResearchThread | null> => {
    const { data, error } = await supabase
      .from("research_threads")
      .insert({
        topic,
        created_by: createdBy,
        messages: initialMessages as any,
      })
      .select()
      .single();
    if (error || !data) return null;
    const thread = rowToThread(data);
    setThreads(prev => [thread, ...prev]);
    return thread;
  }, []);

  const updateMessages = useCallback(async (id: string, messages: { role: string; content: string }[]) => {
    await supabase
      .from("research_threads")
      .update({
        messages: messages as any,
        last_activity_at: new Date().toISOString(),
      })
      .eq("id", id);
    setThreads(prev => prev.map(t => t.id === id ? { ...t, messages, lastActivityAt: new Date().toISOString() } : t));
  }, []);

  const deleteThread = useCallback(async (id: string) => {
    await supabase
      .from("research_threads")
      .update({ is_deleted: true })
      .eq("id", id);
    setThreads(prev => prev.filter(t => t.id !== id));
  }, []);

  return { threads, loading, fetchThreads, createThread, updateMessages, deleteThread };
};

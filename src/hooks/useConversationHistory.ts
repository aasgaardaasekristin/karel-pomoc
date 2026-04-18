import { useState, useCallback, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface SavedConversation {
  id: string;
  subMode: string;
  label: string;
  preview: string;
  messages: { role: string; content: string }[];
  didInitialContext: string;
  savedAt: number;
}

const MAX_CONVERSATIONS = 5;
const LOCAL_HISTORY_KEY = "karel_did_history";
const MIGRATION_DONE_KEY = "karel_did_history_migrated_v1";

// User-facing labels for sub_mode tokens. The "mamka" sub_mode is a
// LEGACY routing token only — its display name is "Hanička" (canonical),
// never "Mamka". See src/lib/therapistIdentity.ts.
const labelMap: Record<string, string> = {
  mamka: "Hanička",
  cast: "Část mluví",
  general: "Obecné DID",
  form: "Formulář",
  freetext: "Volný text",
};

// Map DB row to SavedConversation
const rowToConv = (row: any): SavedConversation => ({
  id: row.session_id,
  subMode: row.sub_mode,
  label: row.label,
  preview: row.preview ?? "",
  messages: (row.messages ?? []) as { role: string; content: string }[],
  didInitialContext: row.did_initial_context ?? "",
  savedAt: new Date(row.saved_at).getTime(),
});

const fetchFromDb = async (): Promise<SavedConversation[]> => {
  const { data, error } = await supabase
    .from("did_conversations")
    .select("*")
    .order("saved_at", { ascending: false })
    .limit(MAX_CONVERSATIONS);
  if (error || !data) return [];
  return data.map(rowToConv);
};

// One-time migration: push localStorage history into DB
const migrateLocalStorageToDb = async () => {
  try {
    if (localStorage.getItem(MIGRATION_DONE_KEY)) return;
    const raw = localStorage.getItem(LOCAL_HISTORY_KEY);
    if (!raw) { localStorage.setItem(MIGRATION_DONE_KEY, "1"); return; }
    const items: any[] = JSON.parse(raw);
    if (!items.length) { localStorage.setItem(MIGRATION_DONE_KEY, "1"); return; }

    for (const c of items) {
      await supabase.from("did_conversations").upsert({
        session_id: c.id,
        sub_mode: c.subMode,
        label: c.label || labelMap[c.subMode] || c.subMode,
        preview: c.preview || "",
        messages: c.messages as any,
        did_initial_context: c.didInitialContext || "",
        saved_at: new Date(c.savedAt).toISOString(),
      }, { onConflict: "user_id,session_id" });
    }
    localStorage.setItem(MIGRATION_DONE_KEY, "1");
  } catch (e) {
    console.error("Migration error:", e);
  }
};

export const useConversationHistory = () => {
  const [history, setHistory] = useState<SavedConversation[]>([]);

  // Migrate localStorage then load from DB + realtime subscription
  useEffect(() => {
    migrateLocalStorageToDb().then(() => fetchFromDb()).then(setHistory);

    const channel = supabase
      .channel("did_conversations_realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "did_conversations" },
        () => { fetchFromDb().then(setHistory); }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, []);

  const refreshHistory = useCallback(async () => {
    const h = await fetchFromDb();
    setHistory(h);
  }, []);

  const saveConversation = useCallback(
    async (
      subMode: string,
      messages: { role: string; content: string }[],
      didInitialContext: string,
      conversationId?: string
    ) => {
      if (messages.length < 2) return;
      // CRITICAL: Don't save without a stable session ID - prevents duplicate entries
      if (!conversationId) {
        console.warn("[saveConversation] Skipped save: no conversationId provided");
        return;
      }
      const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
      const preview = lastUserMsg?.content.slice(0, 80) || "Rozhovor";
      const sessionId = conversationId;

      const payload = {
        session_id: sessionId,
        sub_mode: subMode,
        label: labelMap[subMode] || subMode,
        preview,
        messages: messages as any,
        did_initial_context: didInitialContext,
        saved_at: new Date().toISOString(),
        is_processed: false,
        processed_at: null,
      };

      // Upsert on (user_id, session_id) unique constraint
      const { error } = await supabase
        .from("did_conversations")
        .upsert(payload, { onConflict: "user_id,session_id" });

      if (error) {
        console.error("Save conversation error:", error);
      }

      // Trim old conversations – keep only MAX_CONVERSATIONS most recent
      const { data: all } = await supabase
        .from("did_conversations")
        .select("id, saved_at")
        .order("saved_at", { ascending: false });

      if (all && all.length > MAX_CONVERSATIONS) {
        const toDelete = all.slice(MAX_CONVERSATIONS).map((r: any) => r.id);
        await supabase.from("did_conversations").delete().in("id", toDelete);
      }

      await refreshHistory();
    },
    [refreshHistory]
  );

  const loadConversation = useCallback(async (id: string): Promise<SavedConversation | null> => {
    const { data, error } = await supabase
      .from("did_conversations")
      .select("*")
      .eq("session_id", id)
      .maybeSingle();
    if (error || !data) return null;
    return rowToConv(data);
  }, []);

  const deleteConversation = useCallback(async (id: string) => {
    await supabase.from("did_conversations").delete().eq("session_id", id);
    setHistory((prev) => prev.filter((c) => c.id !== id));
  }, []);

  return { history, saveConversation, loadConversation, deleteConversation, refreshHistory };
};

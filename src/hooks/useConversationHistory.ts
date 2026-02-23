import { useState, useCallback } from "react";

export interface SavedConversation {
  id: string;
  subMode: string;
  label: string;
  preview: string;
  messages: { role: string; content: string }[];
  didInitialContext: string;
  savedAt: number;
}

const HISTORY_KEY = "karel_did_history";
const MAX_CONVERSATIONS = 5;

const loadHistory = (): SavedConversation[] => {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
};

const persistHistory = (history: SavedConversation[]) => {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch { /* quota */ }
};

export const useConversationHistory = () => {
  const [history, setHistory] = useState<SavedConversation[]>(loadHistory);

  const saveConversation = useCallback(
    (
      subMode: string,
      messages: { role: string; content: string }[],
      didInitialContext: string,
      conversationId?: string
    ) => {
      if (messages.length < 2) return;
      const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
      const preview = lastUserMsg?.content.slice(0, 80) || "Rozhovor";
      const labelMap: Record<string, string> = {
        mamka: "Mamka",
        cast: "Část mluví",
        general: "Obecné DID",
        form: "Formulář",
        freetext: "Volný text",
      };

      setHistory((prev) => {
        const firstUserMsg = messages.find((m) => m.role === "user")?.content;

        const byIdIdx = conversationId
          ? prev.findIndex((c) => c.id === conversationId)
          : -1;

        // Backward compatible fallback for older saved conversations without explicit session id.
        // Keep it conservative so independent chats don't overwrite each other.
        const fallbackIdx =
          byIdIdx >= 0
            ? byIdIdx
            : prev.findIndex((c) => {
                const cFirst = c.messages.find((m) => m.role === "user")?.content;
                const sameSeed = c.subMode === subMode && cFirst === firstUserMsg && c.didInitialContext === didInitialContext;
                const recentEnough = Date.now() - c.savedAt < 20 * 60 * 1000;
                return sameSeed && recentEnough;
              });

        const stableId =
          fallbackIdx >= 0
            ? prev[fallbackIdx].id
            : conversationId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        const conv: SavedConversation = {
          id: stableId,
          subMode,
          label: labelMap[subMode] || subMode,
          preview,
          messages,
          didInitialContext,
          savedAt: Date.now(),
        };

        const next = fallbackIdx >= 0
          ? [conv, ...prev.filter((_, i) => i !== fallbackIdx)]
          : [conv, ...prev];

        const trimmed = next.slice(0, MAX_CONVERSATIONS);
        persistHistory(trimmed);
        return trimmed;
      });
    },
    []
  );

  const loadConversation = useCallback((id: string) => {
    const h = loadHistory();
    return h.find((c) => c.id === id) || null;
  }, []);

  const deleteConversation = useCallback((id: string) => {
    setHistory((prev) => {
      const next = prev.filter((c) => c.id !== id);
      persistHistory(next);
      return next;
    });
  }, []);

  const refreshHistory = useCallback(() => {
    setHistory(loadHistory());
  }, []);

  return { history, saveConversation, loadConversation, deleteConversation, refreshHistory };
};

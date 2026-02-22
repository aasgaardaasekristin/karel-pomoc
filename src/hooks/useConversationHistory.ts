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
    (subMode: string, messages: { role: string; content: string }[], didInitialContext: string) => {
      if (messages.length < 2) return; // don't save empty convos
      const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
      const preview = lastUserMsg?.content.slice(0, 80) || "Rozhovor";
      const labelMap: Record<string, string> = {
        mamka: "Mamka",
        cast: "Část mluví",
        general: "Obecné DID",
        form: "Formulář",
        freetext: "Volný text",
      };
      const conv: SavedConversation = {
        id: Date.now().toString(),
        subMode,
        label: labelMap[subMode] || subMode,
        preview,
        messages,
        didInitialContext,
        savedAt: Date.now(),
      };
      setHistory((prev) => {
        const next = [conv, ...prev].slice(0, MAX_CONVERSATIONS);
        persistHistory(next);
        return next;
      });
      return conv.id;
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

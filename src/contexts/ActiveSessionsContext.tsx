import React, { createContext, useContext, useState, useCallback, ReactNode } from "react";
import { ReportFormData, TriageData } from "@/components/ReportForm";

type Message = { role: "user" | "assistant"; content: string };

export interface SessionWorkspace {
  id: string;
  clientId: string;
  clientName: string;
  formData: ReportFormData;
  chatMessages: Message[];
  reportText: string;
  triageData: TriageData | null;
  status: "active" | "report-ready" | "archived";
  createdAt: number;
  sessionPlan?: any;
}

const DEFAULT_FORM: ReportFormData = {
  contactFullName: "",
  contactEmail: "",
  contactPhone: "",
  isMinor: false,
  clientAge: "",
  childFullName: "",
  childEmail: "",
  childPhone: "",
  guardianFullName: "",
  context: "",
  keyTheme: "",
  therapistEmotions: [],
  therapistEmotionsOther: "",
  transference: "",
  risks: [],
  risksOther: "",
  missingData: "",
  interventionsTried: "",
  nextSessionGoal: "",
};

interface ActiveSessionsContextType {
  sessions: SessionWorkspace[];
  activeSessionId: string | null;
  activeSession: SessionWorkspace | null;
  createSession: (clientId: string, clientName: string) => string;
  removeSession: (id: string) => void;
  setActiveSession: (id: string) => void;
  clearActiveSession: () => void;
  updateFormData: (id: string, data: Partial<ReportFormData>) => void;
  updateChatMessages: (id: string, messages: Message[]) => void;
  updateReportText: (id: string, text: string) => void;
  updateTriageData: (id: string, data: TriageData | null) => void;
  updateStatus: (id: string, status: SessionWorkspace["status"]) => void;
  updateSessionPlan: (id: string, plan: any) => void;
}

const ActiveSessionsContext = createContext<ActiveSessionsContextType | undefined>(undefined);

const MAX_SESSIONS = 5;
const STORAGE_KEY = "karel_active_sessions";
const ACTIVE_KEY = "karel_active_session_id";

const loadSessions = (): SessionWorkspace[] => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
};

const saveSessions = (sessions: SessionWorkspace[]) => {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions)); } catch {}
};

export const ActiveSessionsProvider = ({ children }: { children: ReactNode }) => {
  const [sessions, setSessions] = useState<SessionWorkspace[]>(loadSessions);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(() => {
    try { return localStorage.getItem(ACTIVE_KEY); } catch { return null; }
  });

  const persist = useCallback((next: SessionWorkspace[]) => {
    setSessions(next);
    saveSessions(next);
  }, []);

  const createSession = useCallback((clientId: string, clientName: string) => {
    // Check if session for this client already exists
    const existing = sessions.find(s => s.clientId === clientId);
    if (existing) {
      setActiveSessionId(existing.id);
      try { localStorage.setItem(ACTIVE_KEY, existing.id); } catch {}
      return existing.id;
    }

    if (sessions.length >= MAX_SESSIONS) {
      throw new Error("Maximálně 5 rozpracovaných sezení. Ukonči jedno z nich.");
    }

    const id = `session-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const newSession: SessionWorkspace = {
      id,
      clientId,
      clientName,
      formData: { ...DEFAULT_FORM, contactFullName: clientName },
      chatMessages: [],
      reportText: "",
      triageData: null,
      status: "active",
      createdAt: Date.now(),
    };

    const next = [...sessions, newSession];
    persist(next);
    setActiveSessionId(id);
    try { localStorage.setItem(ACTIVE_KEY, id); } catch {}
    return id;
  }, [sessions, persist]);

  const removeSession = useCallback((id: string) => {
    const next = sessions.filter(s => s.id !== id);
    persist(next);
    if (activeSessionId === id) {
      const newActive = next.length > 0 ? next[0].id : null;
      setActiveSessionId(newActive);
      try {
        if (newActive) localStorage.setItem(ACTIVE_KEY, newActive);
        else localStorage.removeItem(ACTIVE_KEY);
      } catch {}
    }
  }, [sessions, activeSessionId, persist]);

  const setActiveSessionFn = useCallback((id: string) => {
    setActiveSessionId(id);
    try { localStorage.setItem(ACTIVE_KEY, id); } catch {}
  }, []);

  const clearActiveSession = useCallback(() => {
    setActiveSessionId(null);
    try { localStorage.removeItem(ACTIVE_KEY); } catch {}
  }, []);

  const updateSession = useCallback((id: string, updater: (s: SessionWorkspace) => SessionWorkspace) => {
    const next = sessions.map(s => s.id === id ? updater(s) : s);
    persist(next);
  }, [sessions, persist]);

  const updateFormData = useCallback((id: string, data: Partial<ReportFormData>) => {
    updateSession(id, s => ({ ...s, formData: { ...s.formData, ...data } }));
  }, [updateSession]);

  const updateChatMessages = useCallback((id: string, messages: Message[]) => {
    updateSession(id, s => ({ ...s, chatMessages: messages }));
  }, [updateSession]);

  const updateReportText = useCallback((id: string, text: string) => {
    updateSession(id, s => ({ ...s, reportText: text }));
  }, [updateSession]);

  const updateTriageData = useCallback((id: string, data: TriageData | null) => {
    updateSession(id, s => ({ ...s, triageData: data }));
  }, [updateSession]);

  const updateStatus = useCallback((id: string, status: SessionWorkspace["status"]) => {
    updateSession(id, s => ({ ...s, status }));
  }, [updateSession]);

  const activeSession = sessions.find(s => s.id === activeSessionId) ?? null;

  return (
    <ActiveSessionsContext.Provider value={{
      sessions,
      activeSessionId,
      activeSession,
      createSession,
      removeSession,
      setActiveSession: setActiveSessionFn,
      clearActiveSession,
      updateFormData,
      updateChatMessages,
      updateReportText,
      updateTriageData,
      updateStatus,
    }}>
      {children}
    </ActiveSessionsContext.Provider>
  );
};

export const useActiveSessions = () => {
  const ctx = useContext(ActiveSessionsContext);
  if (!ctx) throw new Error("useActiveSessions must be used within ActiveSessionsProvider");
  return ctx;
};

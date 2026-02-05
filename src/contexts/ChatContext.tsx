import React, { createContext, useContext, useState, ReactNode } from "react";

type Message = {
  role: "user" | "assistant";
  content: string;
};

type ConversationMode = "debrief" | "supervision" | "safety" | "childcare";
type MainMode = "chat" | "report";

export interface ReportDraft {
  context: string;
  keyTheme: string;
  therapistEmotions: string[];
  transference: string;
  risks: string[];
  missingData: string;
  interventionsTried: string;
  nextSessionGoal: string;
}

interface ChatContextType {
  messages: Message[];
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  mode: ConversationMode;
  setMode: React.Dispatch<React.SetStateAction<ConversationMode>>;
  mainMode: MainMode;
  setMainMode: React.Dispatch<React.SetStateAction<MainMode>>;
  reportDraft: ReportDraft | null;
  setReportDraft: React.Dispatch<React.SetStateAction<ReportDraft | null>>;
  lastReportText: string;
  setLastReportText: React.Dispatch<React.SetStateAction<string>>;
  pendingHandoffToChat: boolean;
  setPendingHandoffToChat: React.Dispatch<React.SetStateAction<boolean>>;
}

const ChatContext = createContext<ChatContextType | undefined>(undefined);

export const ChatProvider = ({ children }: { children: ReactNode }) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [mode, setMode] = useState<ConversationMode>("debrief");
  const [mainMode, setMainMode] = useState<MainMode>("chat");
  const [reportDraft, setReportDraft] = useState<ReportDraft | null>(null);
  const [lastReportText, setLastReportText] = useState<string>("");
  const [pendingHandoffToChat, setPendingHandoffToChat] = useState<boolean>(false);

  return (
    <ChatContext.Provider value={{ 
      messages, 
      setMessages, 
      mode, 
      setMode,
      mainMode,
      setMainMode,
      reportDraft,
      setReportDraft,
      lastReportText,
      setLastReportText,
      pendingHandoffToChat,
      setPendingHandoffToChat,
    }}>
      {children}
    </ChatContext.Provider>
  );
};

export const useChatContext = () => {
  const context = useContext(ChatContext);
  if (context === undefined) {
    throw new Error("useChatContext must be used within a ChatProvider");
  }
  return context;
};

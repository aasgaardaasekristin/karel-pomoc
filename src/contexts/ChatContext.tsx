import React, { createContext, useContext, useState, ReactNode } from "react";

type Message = {
  role: "user" | "assistant";
  content: string;
};

type ConversationMode = "debrief" | "supervision" | "safety" | "childcare";

interface ChatContextType {
  messages: Message[];
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  mode: ConversationMode;
  setMode: React.Dispatch<React.SetStateAction<ConversationMode>>;
}

const ChatContext = createContext<ChatContextType | undefined>(undefined);

export const ChatProvider = ({ children }: { children: ReactNode }) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [mode, setMode] = useState<ConversationMode>("debrief");

  return (
    <ChatContext.Provider value={{ messages, setMessages, mode, setMode }}>
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

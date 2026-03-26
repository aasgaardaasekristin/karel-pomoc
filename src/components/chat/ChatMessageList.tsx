import * as React from "react";
import { cn } from "@/lib/utils";
import { ChatBubble } from "./ChatBubble";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
  partName?: string;
  partEmoji?: string;
}

interface ChatMessageListProps {
  messages: ChatMessage[];
  isStreaming?: boolean;
  streamingContent?: string;
  className?: string;
}

const ChatMessageList: React.FC<ChatMessageListProps> = ({
  messages,
  isStreaming = false,
  streamingContent = "",
  className,
}) => {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const isNearBottomRef = React.useRef(true);

  const checkNearBottom = React.useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const threshold = 120;
    isNearBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  }, []);

  const scrollToBottom = React.useCallback(() => {
    const el = containerRef.current;
    if (!el || !isNearBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  // Auto-scroll on new messages or streaming content
  React.useEffect(() => {
    scrollToBottom();
  }, [messages.length, streamingContent, scrollToBottom]);

  return (
    <div
      ref={containerRef}
      onScroll={checkNearBottom}
      className={cn("flex-1 overflow-y-auto space-y-4 px-4 py-6", className)}
    >
      {messages.map((msg, i) => (
        <ChatBubble
          key={i}
          role={msg.role}
          content={msg.content}
          timestamp={msg.timestamp}
          partName={msg.partName}
          partEmoji={msg.partEmoji}
        />
      ))}

      {isStreaming && (
        <ChatBubble
          role="assistant"
          content={streamingContent}
          isStreaming
        />
      )}
    </div>
  );
};
ChatMessageList.displayName = "ChatMessageList";

export { ChatMessageList };
export type { ChatMessageListProps, ChatMessage };

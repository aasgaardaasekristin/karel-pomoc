import * as React from "react";
import ReactMarkdown from "react-markdown";
import { cn } from "@/lib/utils";

interface ChatBubbleProps {
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
  isStreaming?: boolean;
  partName?: string;
  partEmoji?: string;
}

const StreamingDots: React.FC = () => (
  <span className="inline-flex items-center gap-1 px-1">
    {[0, 1, 2].map((i) => (
      <span
        key={i}
        className="h-1.5 w-1.5 rounded-full bg-[hsl(var(--text-tertiary))] animate-pulse-soft"
        style={{ animationDelay: `${i * 200}ms` }}
      />
    ))}
  </span>
);

const ChatBubble = React.memo<ChatBubbleProps>(
  ({ role, content, timestamp, isStreaming, partName, partEmoji }) => {
    const isUser = role === "user";

    return (
      <div
        className={cn(
          "flex gap-2.5 max-w-[80%] md:max-w-[70%]",
          isUser ? "flex-row-reverse ml-auto" : "flex-row mr-auto",
        )}
      >
        {/* Avatar — assistant only */}
        {!isUser && (
          <div className="flex items-start pt-0.5 shrink-0">
            <div className="flex items-center justify-center h-8 w-8 rounded-full bg-[hsl(var(--accent-light))] text-sm">
              {partEmoji || "🤖"}
            </div>
          </div>
        )}

        <div className="flex flex-col gap-0.5 min-w-0">
          {/* Part name label */}
          {!isUser && partName && (
            <span className="text-xs font-medium text-[hsl(var(--text-tertiary))] ml-1 mb-0.5">
              {partName}
            </span>
          )}

          {/* Bubble */}
          <div
            className={cn(
              "px-4 py-2.5 text-sm leading-relaxed",
              isUser
                ? "bg-[hsl(var(--bubble-user-bg))] text-[hsl(var(--text-primary))] rounded-2xl rounded-tr-md"
                : "bg-[hsl(var(--bubble-ai-bg))] text-[hsl(var(--text-primary))] border border-[hsl(var(--bubble-ai-border))] rounded-2xl rounded-tl-md shadow-subtle",
            )}
          >
            {isStreaming && !content ? (
              <StreamingDots />
            ) : (
              <div className="prose prose-sm max-w-none dark:prose-invert prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-headings:mt-3 prose-headings:mb-1">
                <ReactMarkdown>{content}</ReactMarkdown>
              </div>
            )}
          </div>

          {/* Timestamp */}
          {timestamp && (
            <span
              className={cn(
                "text-[10px] text-[hsl(var(--text-disabled))] mt-0.5",
                isUser ? "text-right mr-1" : "ml-1",
              )}
            >
              {timestamp}
            </span>
          )}
        </div>
      </div>
    );
  },
);
ChatBubble.displayName = "ChatBubble";

export { ChatBubble };
export type { ChatBubbleProps };

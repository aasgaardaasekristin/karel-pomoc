import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { Copy, Check } from "lucide-react";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface ChatMessageProps {
  message: Message;
  onNotebookCopied?: () => void;
}

const extractNotebookLMSection = (content: string): string | null => {
  const match = content.match(/📌\s*\*?\*?Co (?:uložit|aktualizovat) (?:do|v) NotebookLM.*$/s);
  if (match) return match[0].trim();
  // Also match handover blocks for "cast" mode
  const handoverMatch = content.match(/🔽\s*\*?\*?Tohle je pro mamku.*$/s);
  return handoverMatch ? handoverMatch[0].trim() : null;
};

const CopyNotebookButton = ({ text, onCopied }: { text: string; onCopied?: () => void }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
        onCopied?.();
      }, 1500);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
        onCopied?.();
      }, 1500);
    }
  };

  return (
    <button
      onClick={handleCopy}
      className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border border-border bg-muted/50 hover:bg-muted transition-colors text-foreground"
      title="Zkopírovat sekci pro NotebookLM"
    >
      {copied ? (
        <>
          <Check className="w-3.5 h-3.5 text-green-500" />
          Zkopírováno!
        </>
      ) : (
        <>
          <Copy className="w-3.5 h-3.5" />
          📋 Kopírovat pro NotebookLM
        </>
      )}
    </button>
  );
};

const ChatMessage = ({ message, onNotebookCopied }: ChatMessageProps) => {
  const isUser = message.role === "user";
  const notebookSection = !isUser ? extractNotebookLMSection(message.content) : null;

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[92%] sm:max-w-[85%] md:max-w-[75%] ${
          isUser ? "chat-message-user" : "chat-message-assistant"
        }`}
      >
        {isUser ? (
          <p className="text-foreground whitespace-pre-wrap">{message.content}</p>
        ) : (
          <div className="prose prose-sm max-w-none text-foreground prose-p:my-2 prose-ul:my-2 prose-li:my-0.5">
            <ReactMarkdown
              components={{
                a: ({ href, children }) => (
                  <a href={href} target="_blank" rel="noopener noreferrer">
                    {children}
                  </a>
                ),
              }}
            >{message.content}</ReactMarkdown>
            {notebookSection && <CopyNotebookButton text={notebookSection} onCopied={onNotebookCopied} />}
          </div>
        )}
      </div>
    </div>
  );
};

export default ChatMessage;

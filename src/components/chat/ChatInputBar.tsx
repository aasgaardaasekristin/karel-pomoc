import * as React from "react";
import { SendHorizontal, Square } from "lucide-react";
import { cn } from "@/lib/utils";
import { KarelButton } from "@/components/ui/KarelButton";

interface ChatInputBarProps {
  onSend: (text: string) => void;
  onStop?: () => void;
  isLoading?: boolean;
  isStreaming?: boolean;
  placeholder?: string;
  disabled?: boolean;
  showAttach?: boolean;
  maxRows?: number;
  className?: string;
}

const ChatInputBar: React.FC<ChatInputBarProps> = ({
  onSend,
  onStop,
  isLoading = false,
  isStreaming = false,
  placeholder = "Napište zprávu…",
  disabled = false,
  maxRows = 6,
  className,
}) => {
  const [value, setValue] = React.useState("");
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  const canSend = value.trim().length > 0 && !isLoading && !isStreaming && !disabled;

  // Auto-resize textarea
  React.useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const lineHeight = 22;
    const maxHeight = lineHeight * maxRows;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [value, maxRows]);

  const handleSend = React.useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || !canSend) return;
    onSend(trimmed);
    setValue("");
    // Reset height
    requestAnimationFrame(() => {
      if (textareaRef.current) textareaRef.current.style.height = "auto";
    });
  }, [value, canSend, onSend]);

  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  return (
    <div className={cn("px-4 pb-3 pt-2", className)}>
      <div
        className={cn(
          "flex items-end gap-2 rounded-xl border border-[hsl(var(--border-default))] bg-[hsl(var(--surface-primary))] shadow-soft transition-shadow duration-200",
          "focus-within:shadow-medium focus-within:border-[hsl(var(--border-focus))]",
          "px-3 py-2",
        )}
      >
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled || isLoading}
          rows={1}
          className={cn(
            "flex-1 resize-none bg-transparent text-sm text-[hsl(var(--text-primary))] leading-snug",
            "placeholder:text-[hsl(var(--text-disabled))]",
            "focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed",
            "min-h-[22px]",
          )}
        />

        {isStreaming ? (
          <KarelButton
            variant="danger"
            size="icon"
            onClick={onStop}
            icon={<Square size={14} />}
            aria-label="Zastavit"
            className="shrink-0"
          />
        ) : (
          <KarelButton
            variant="primary"
            size="icon"
            onClick={handleSend}
            disabled={!canSend}
            icon={<SendHorizontal size={16} />}
            aria-label="Odeslat"
            className={cn("shrink-0 transition-opacity", !canSend && "opacity-40")}
          />
        )}
      </div>

      <p className="text-[10px] text-[hsl(var(--text-disabled))] text-center mt-1.5 select-none">
        Karel je AI asistent. Shift+Enter pro nový řádek.
      </p>
    </div>
  );
};
ChatInputBar.displayName = "ChatInputBar";

export { ChatInputBar };
export type { ChatInputBarProps };

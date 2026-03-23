import ReactMarkdown from "react-markdown";
import { cn } from "@/lib/utils";

interface RichMarkdownProps {
  children: string;
  className?: string;
  compact?: boolean;
}

const RichMarkdown = ({ children, className, compact = false }: RichMarkdownProps) => {
  const textSize = compact ? "text-[11px]" : "text-sm";

  return (
    <div className={cn("max-w-prose", className)}>
      <ReactMarkdown
        components={{
          h1: ({ children }) => (
            <h1 className={cn("font-semibold text-foreground border-l-2 border-primary pl-3 py-1 mb-2 bg-muted/20 rounded-r", compact ? "text-sm" : "text-base")}>
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className={cn("font-semibold text-foreground border-l-2 border-primary pl-3 py-1 mb-2 bg-muted/20 rounded-r", compact ? "text-xs" : "text-sm")}>
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className={cn("font-semibold text-foreground border-l-2 border-primary pl-3 py-1 mb-2 bg-muted/20 rounded-r", compact ? "text-[11px]" : "text-[13px]")}>
              {children}
            </h3>
          ),
          h4: ({ children }) => (
            <h4 className={cn("font-semibold text-foreground mb-1.5", compact ? "text-[11px]" : "text-xs")}>
              {children}
            </h4>
          ),
          p: ({ children }) => (
            <p className={cn(textSize, "leading-relaxed mb-2 text-foreground/90")}>{children}</p>
          ),
          strong: ({ children }) => (
            <strong className="font-semibold text-foreground">{children}</strong>
          ),
          em: ({ children }) => (
            <em className="italic text-muted-foreground">{children}</em>
          ),
          ul: ({ children }) => (
            <ul className={cn("list-disc list-inside space-y-1 mb-2", textSize)}>{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className={cn("list-decimal list-inside space-y-1 mb-2", textSize)}>{children}</ol>
          ),
          li: ({ children }) => (
            <li className="leading-relaxed text-foreground/90">{children}</li>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-muted pl-3 italic text-muted-foreground my-2">
              {children}
            </blockquote>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline decoration-primary/50 hover:decoration-primary"
            >
              {children}
            </a>
          ),
          hr: () => <hr className="my-3 border-border/40" />,
          code: ({ children }) => (
            <code className="bg-muted/50 px-1.5 py-0.5 rounded text-[0.9em] font-mono">{children}</code>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
};

export default RichMarkdown;

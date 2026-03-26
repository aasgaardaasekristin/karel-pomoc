import * as React from "react";
import { cn } from "@/lib/utils";

type MaxWidth = "chat" | "content" | "full";

interface AppShellProps {
  header?: React.ReactNode;
  sidebar?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
  maxWidth?: MaxWidth;
  centered?: boolean;
  className?: string;
}

const maxWidthClasses: Record<MaxWidth, string> = {
  chat: "max-w-[var(--chat-max-width)]",
  content: "max-w-4xl",
  full: "max-w-full",
};

const AppShell: React.FC<AppShellProps> = ({
  header,
  sidebar,
  footer,
  children,
  maxWidth = "chat",
  centered = true,
  className,
}) => (
  <div className="flex h-[100dvh] overflow-hidden bg-[hsl(var(--surface-primary))]">
    {sidebar && (
      <aside className="hidden md:flex w-[var(--sidebar-width)] shrink-0 flex-col border-r border-[hsl(var(--border-subtle))] bg-[hsl(var(--surface-secondary))] overflow-y-auto">
        {sidebar}
      </aside>
    )}

    <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
      {header && (
        <header className="shrink-0 h-[var(--header-height)] border-b border-[hsl(var(--border-subtle))] bg-[hsl(var(--surface-primary))]">
          {header}
        </header>
      )}

      <main
        className={cn(
          "flex-1 overflow-y-auto px-4 sm:px-6",
          centered && "mx-auto w-full",
          maxWidthClasses[maxWidth],
          className,
        )}
      >
        {children}
      </main>

      {footer && (
        <footer className="shrink-0 border-t border-[hsl(var(--border-subtle))] bg-[hsl(var(--surface-primary))]">
          {footer}
        </footer>
      )}
    </div>
  </div>
);
AppShell.displayName = "AppShell";

export { AppShell };
export type { AppShellProps };

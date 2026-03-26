import * as React from "react";
import { cn } from "@/lib/utils";

interface KarelEmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
}

const KarelEmptyState = React.forwardRef<HTMLDivElement, KarelEmptyStateProps>(
  ({ className, icon, title, description, action, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "flex flex-col items-center justify-center text-center py-16 px-6 animate-fade-in",
        className,
      )}
      {...props}
    >
      {icon && (
        <div className="mb-4 text-[hsl(var(--text-tertiary))] opacity-60">{icon}</div>
      )}
      <h3 className="text-lg font-semibold text-[hsl(var(--text-primary))] mb-1">
        {title}
      </h3>
      {description && (
        <p className="text-sm text-[hsl(var(--text-secondary))] max-w-xs mb-5">
          {description}
        </p>
      )}
      {action && <div>{action}</div>}
    </div>
  ),
);
KarelEmptyState.displayName = "KarelEmptyState";

export { KarelEmptyState };
export type { KarelEmptyStateProps };

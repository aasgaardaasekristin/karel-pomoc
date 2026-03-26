import * as React from "react";
import { cn } from "@/lib/utils";

type BadgeVariant = "default" | "success" | "warning" | "error" | "info" | "accent";
type BadgeSize = "sm" | "md";

interface KarelBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  size?: BadgeSize;
  dot?: boolean;
}

const variantClasses: Record<BadgeVariant, string> = {
  default:
    "bg-[hsl(var(--surface-tertiary))] text-[hsl(var(--text-secondary))]",
  success:
    "bg-[hsl(142_40%_90%)] text-[hsl(142_50%_28%)] dark:bg-[hsl(142_30%_18%)] dark:text-[hsl(142_40%_68%)]",
  warning:
    "bg-[hsl(38_90%_90%)] text-[hsl(38_70%_30%)] dark:bg-[hsl(38_40%_16%)] dark:text-[hsl(38_60%_68%)]",
  error:
    "bg-[hsl(0_60%_92%)] text-[hsl(0_60%_38%)] dark:bg-[hsl(0_40%_18%)] dark:text-[hsl(0_50%_66%)]",
  info:
    "bg-[hsl(210_60%_92%)] text-[hsl(210_50%_34%)] dark:bg-[hsl(210_30%_18%)] dark:text-[hsl(210_44%_68%)]",
  accent:
    "bg-[hsl(var(--accent-light))] text-[hsl(var(--accent-dark))]",
};

const dotColors: Record<BadgeVariant, string> = {
  default: "bg-[hsl(var(--text-tertiary))]",
  success: "bg-[hsl(142_50%_42%)]",
  warning: "bg-[hsl(38_80%_50%)]",
  error: "bg-[hsl(0_60%_50%)]",
  info: "bg-[hsl(210_56%_50%)]",
  accent: "bg-[hsl(var(--accent-primary))]",
};

const sizeClasses: Record<BadgeSize, string> = {
  sm: "text-xs px-2 py-0.5",
  md: "text-xs px-2.5 py-1",
};

const KarelBadge = React.forwardRef<HTMLSpanElement, KarelBadgeProps>(
  ({ className, variant = "default", size = "sm", dot = false, children, ...props }, ref) => (
    <span
      ref={ref}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md font-medium whitespace-nowrap",
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
      {...props}
    >
      {dot && (
        <span
          className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dotColors[variant])}
          aria-hidden
        />
      )}
      {children}
    </span>
  ),
);
KarelBadge.displayName = "KarelBadge";

export { KarelBadge };
export type { KarelBadgeProps };

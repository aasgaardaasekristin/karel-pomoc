import * as React from "react";
import { cn } from "@/lib/utils";

type CardVariant = "default" | "elevated" | "outlined" | "glass" | "interactive" | "subtle";
type CardPadding = "none" | "sm" | "md" | "lg";

interface KarelCardProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: CardVariant;
  padding?: CardPadding;
  animate?: boolean;
}

const variantClasses: Record<CardVariant, string> = {
  default:
    "bg-[hsl(var(--surface-secondary))] border border-[hsl(var(--border-subtle))] shadow-subtle",
  elevated:
    "bg-[hsl(var(--surface-elevated))] border border-[hsl(var(--border-subtle))] shadow-medium",
  outlined:
    "bg-transparent border border-[hsl(var(--border-default))]",
  glass:
    "glass border border-[hsl(var(--border-subtle))]",
  interactive:
    "bg-[hsl(var(--surface-secondary))] border border-[hsl(var(--border-subtle))] shadow-subtle cursor-pointer transition-all duration-200 hover:shadow-medium hover:border-[hsl(var(--border-strong))]",
  subtle:
    "bg-[hsl(var(--surface-tertiary))]",
};

const paddingClasses: Record<CardPadding, string> = {
  none: "",
  sm: "p-3",
  md: "p-5",
  lg: "p-7",
};

const KarelCard = React.forwardRef<HTMLDivElement, KarelCardProps>(
  ({ className, variant = "default", padding = "md", animate = false, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "rounded-lg",
        variantClasses[variant],
        paddingClasses[padding],
        animate && "animate-fade-in",
        className,
      )}
      {...props}
    />
  ),
);
KarelCard.displayName = "KarelCard";

export { KarelCard };
export type { KarelCardProps };

import * as React from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "accent" | "soft";
type ButtonSize = "sm" | "md" | "lg" | "icon";

interface KarelButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: React.ReactNode;
  iconPosition?: "left" | "right";
}

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "bg-[hsl(var(--accent-primary))] text-[hsl(var(--text-inverse))] hover:opacity-90",
  secondary:
    "bg-[hsl(var(--surface-tertiary))] text-[hsl(var(--text-primary))] border border-[hsl(var(--border-default))] hover:bg-[hsl(var(--surface-secondary))]",
  ghost:
    "bg-transparent text-[hsl(var(--text-secondary))] hover:bg-[hsl(var(--surface-tertiary))] hover:text-[hsl(var(--text-primary))]",
  danger:
    "bg-destructive text-destructive-foreground hover:opacity-90",
  accent:
    "bg-[hsl(var(--accent-light))] text-[hsl(var(--accent-dark))] hover:opacity-90",
  soft:
    "bg-[hsl(var(--surface-secondary))] text-[hsl(var(--text-primary))] hover:bg-[hsl(var(--surface-tertiary))]",
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-xs gap-1.5 rounded-md",
  md: "h-9 px-4 text-sm gap-2 rounded-md",
  lg: "h-11 px-6 text-base gap-2.5 rounded-lg",
  icon: "h-9 w-9 rounded-md",
};

const KarelButton = React.forwardRef<HTMLButtonElement, KarelButtonProps>(
  (
    {
      className,
      variant = "primary",
      size = "md",
      loading = false,
      icon,
      iconPosition = "left",
      disabled,
      children,
      ...props
    },
    ref,
  ) => (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        "inline-flex items-center justify-center font-medium whitespace-nowrap transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--border-focus))] focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
      {...props}
    >
      {loading ? (
        <Loader2 className="animate-spin" size={size === "sm" ? 14 : size === "lg" ? 20 : 16} />
      ) : (
        icon && iconPosition === "left" && <span className="shrink-0">{icon}</span>
      )}
      {children}
      {!loading && icon && iconPosition === "right" && (
        <span className="shrink-0">{icon}</span>
      )}
    </button>
  ),
);
KarelButton.displayName = "KarelButton";

export { KarelButton };
export type { KarelButtonProps };

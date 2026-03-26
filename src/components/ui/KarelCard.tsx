import * as React from "react";
import { cn } from "@/lib/utils";

type CardVariant = "default" | "elevated" | "outlined" | "glass" | "interactive" | "subtle";
type CardPadding = "none" | "sm" | "md" | "lg";

interface KarelCardProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: CardVariant;
  padding?: CardPadding;
  animate?: boolean;
}

const variantStyles: Record<CardVariant, { className: string; style?: React.CSSProperties }> = {
  default: {
    className: "rounded-2xl",
    style: {
      background: "rgba(0, 0, 0, 0.08)",
      backdropFilter: "blur(12px)",
      WebkitBackdropFilter: "blur(12px)",
      border: "1px solid rgba(255, 255, 255, 0.12)",
    },
  },
  elevated: {
    className: "rounded-2xl shadow-md",
    style: {
      background: "rgba(0, 0, 0, 0.12)",
      backdropFilter: "blur(14px)",
      WebkitBackdropFilter: "blur(14px)",
      border: "1px solid rgba(255, 255, 255, 0.15)",
    },
  },
  outlined: {
    className: "rounded-2xl",
    style: {
      background: "rgba(0, 0, 0, 0.06)",
      backdropFilter: "blur(10px)",
      WebkitBackdropFilter: "blur(10px)",
      border: "1px solid rgba(255, 255, 255, 0.1)",
    },
  },
  glass: {
    className: "rounded-2xl glass",
    style: {
      backdropFilter: "blur(12px)",
      WebkitBackdropFilter: "blur(12px)",
      border: "1px solid rgba(255, 255, 255, 0.12)",
    },
  },
  interactive: {
    className: "rounded-2xl cursor-pointer transition-all duration-200",
    style: {
      background: "rgba(0, 0, 0, 0.08)",
      backdropFilter: "blur(12px)",
      WebkitBackdropFilter: "blur(12px)",
      border: "1px solid rgba(255, 255, 255, 0.12)",
    },
  },
  subtle: {
    className: "rounded-2xl",
    style: {
      background: "rgba(0, 0, 0, 0.04)",
      backdropFilter: "blur(8px)",
      WebkitBackdropFilter: "blur(8px)",
    },
  },
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

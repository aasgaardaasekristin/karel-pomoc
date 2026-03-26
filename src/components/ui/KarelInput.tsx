import * as React from "react";
import { cn } from "@/lib/utils";

interface KarelInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
  icon?: React.ReactNode;
}

const KarelInput = React.forwardRef<HTMLInputElement, KarelInputProps>(
  ({ className, label, error, hint, icon, id, ...props }, ref) => {
    const generatedId = React.useId();
    const inputId = id || generatedId;

    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          <label
            htmlFor={inputId}
            className="text-sm font-medium text-[hsl(var(--text-primary))]"
          >
            {label}
          </label>
        )}
        <div className="relative">
          {icon && (
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[hsl(var(--text-tertiary))] pointer-events-none">
              {icon}
            </span>
          )}
          <input
            id={inputId}
            ref={ref}
            className={cn(
              "flex w-full rounded-md bg-[hsl(var(--surface-primary))] border text-sm transition-all duration-200 placeholder:text-[hsl(var(--text-disabled))]",
              "focus-visible:outline-none focus-visible:border-[hsl(var(--border-focus))] focus-visible:ring-2 focus-visible:ring-[hsl(var(--border-focus)/0.25)]",
              "disabled:cursor-not-allowed disabled:opacity-50",
              "h-[var(--input-height)] px-3",
              icon && "pl-10",
              error
                ? "border-destructive focus-visible:border-destructive focus-visible:ring-destructive/25"
                : "border-[hsl(var(--border-default))]",
              className,
            )}
            {...props}
          />
        </div>
        {error && (
          <p className="text-xs text-destructive">{error}</p>
        )}
        {!error && hint && (
          <p className="text-xs text-[hsl(var(--text-tertiary))]">{hint}</p>
        )}
      </div>
    );
  },
);
KarelInput.displayName = "KarelInput";

export { KarelInput };
export type { KarelInputProps };

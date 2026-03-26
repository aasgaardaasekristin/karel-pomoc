import * as React from "react";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { KarelButton } from "@/components/ui/KarelButton";
import { KarelBadge, type KarelBadgeProps } from "@/components/ui/KarelBadge";

interface ChatHeaderProps {
  title: string;
  subtitle?: string;
  emoji?: string;
  badge?: { label: string; variant?: KarelBadgeProps["variant"] };
  onBack?: () => void;
  actions?: React.ReactNode;
  className?: string;
}

const ChatHeader: React.FC<ChatHeaderProps> = ({
  title,
  subtitle,
  emoji,
  badge,
  onBack,
  actions,
  className,
}) => (
  <div className={cn("flex items-center gap-3 h-full px-4", className)}>
    {onBack && (
      <KarelButton
        variant="ghost"
        size="icon"
        onClick={onBack}
        aria-label="Zpět"
        icon={<ArrowLeft size={18} />}
      />
    )}

    {emoji && (
      <div className="flex items-center justify-center h-9 w-9 rounded-full bg-[hsl(var(--accent-light))] text-base shrink-0">
        {emoji}
      </div>
    )}

    <div className="flex flex-col min-w-0 flex-1">
      <div className="flex items-center gap-2">
        <span className="text-base font-semibold text-[hsl(var(--text-primary))] truncate">
          {title}
        </span>
        {badge && (
          <KarelBadge variant={badge.variant} size="sm">
            {badge.label}
          </KarelBadge>
        )}
      </div>
      {subtitle && (
        <span className="text-xs text-[hsl(var(--text-tertiary))] truncate">
          {subtitle}
        </span>
      )}
    </div>

    {actions && <div className="flex items-center gap-1.5 shrink-0">{actions}</div>}
  </div>
);
ChatHeader.displayName = "ChatHeader";

export { ChatHeader };
export type { ChatHeaderProps };

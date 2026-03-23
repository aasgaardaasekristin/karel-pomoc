import { useEffect, useMemo, useState } from "react";
import { Palette } from "lucide-react";
import { Button } from "@/components/ui/button";
import ThemeEditorDialog from "@/components/ThemeEditorDialog";
import { useThemeStorageKey } from "@/contexts/ThemeStorageKeyContext";

const screenButtonOwners = new Map<string, symbol>();

const getScreenScope = () => {
  if (typeof window === "undefined") return "server";
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
};

interface ThemeQuickButtonProps {
  className?: string;
  storageKey?: string;
}

const ThemeQuickButton = ({ className = "", storageKey: propStorageKey }: ThemeQuickButtonProps) => {
  const contextStorageKey = useThemeStorageKey();
  const resolvedStorageKey = propStorageKey ?? contextStorageKey;

  const [open, setOpen] = useState(false);
  const owner = useMemo(() => Symbol("theme-quick-button"), []);
  const scope = getScreenScope();

  const shouldRender = useMemo(() => {
    const currentOwner = screenButtonOwners.get(scope);
    if (!currentOwner) {
      screenButtonOwners.set(scope, owner);
      return true;
    }

    return currentOwner === owner;
  }, [owner, scope]);

  useEffect(() => {
    return () => {
      if (screenButtonOwners.get(scope) === owner) {
        screenButtonOwners.delete(scope);
      }
    };
  }, [owner, scope]);

  if (!shouldRender) return null;

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        className={`min-w-[44px] min-h-[44px] h-7 px-2 text-xs gap-1 rounded-xl text-muted-foreground ${className}`}
        title="Nastavení vzhledu"
      >
        <Palette className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">Vzhled</span>
      </Button>
      <ThemeEditorDialog open={open} onOpenChange={setOpen} storageKey={resolvedStorageKey} />
    </>
  );
};

export default ThemeQuickButton;

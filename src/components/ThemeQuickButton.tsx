import { useState } from "react";
import { Palette } from "lucide-react";
import { Button } from "@/components/ui/button";
import ThemeEditorDialog from "@/components/ThemeEditorDialog";
import { useThemeStorageKey } from "@/contexts/ThemeStorageKeyContext";

interface ThemeQuickButtonProps {
  className?: string;
  storageKey?: string;
}

const ThemeQuickButton = ({ className = "", storageKey: propStorageKey }: ThemeQuickButtonProps) => {
  const contextStorageKey = useThemeStorageKey();
  const resolvedStorageKey = propStorageKey ?? contextStorageKey;

  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        className={`min-w-[2.75rem] min-h-[2.75rem] h-7 px-2 text-xs gap-1 rounded-xl text-muted-foreground ${className}`}
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

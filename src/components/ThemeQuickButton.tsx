import { useState } from "react";
import { Palette } from "lucide-react";
import { Button } from "@/components/ui/button";
import ThemeEditorDialog from "@/components/ThemeEditorDialog";

interface ThemeQuickButtonProps {
  className?: string;
}

const ThemeQuickButton = ({ className = "" }: ThemeQuickButtonProps) => {
  const [open, setOpen] = useState(false);

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
      <ThemeEditorDialog open={open} onOpenChange={setOpen} />
    </>
  );
};

export default ThemeQuickButton;

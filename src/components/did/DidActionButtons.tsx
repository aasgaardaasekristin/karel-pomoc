import { RefreshCw, Loader2, PhoneOff, ArrowLeft, BookOpen, NotebookPen } from "lucide-react";
import { Button } from "@/components/ui/button";

interface DidActionButtonsProps {
  subMode: string;
  onEndCall?: () => void;
  onManualUpdate?: () => void;
  onLeaveThread?: () => void;
  onGenerateHandbook?: () => void;
  onWriteDiary?: () => void;
  isUpdateLoading?: boolean;
  isHandbookLoading?: boolean;
  disabled?: boolean;
}

const DidActionButtons = ({
  subMode,
  onEndCall,
  onManualUpdate,
  onLeaveThread,
  onGenerateHandbook,
  onWriteDiary,
  isUpdateLoading,
  isHandbookLoading,
  disabled,
}: DidActionButtonsProps) => {
  return (
    <div className="flex items-center gap-2 flex-wrap justify-center mt-2">
      {/* Leave thread (back to thread list) */}
      {onLeaveThread && (
        <Button variant="ghost" size="sm" onClick={onLeaveThread} disabled={disabled} className="h-8 px-2.5 gap-1.5 text-xs">
          <ArrowLeft className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">Odejít z vlákna</span>
          <span className="sm:hidden">Zpět</span>
        </Button>
      )}

      {/* 📓 Zapsat do deníku — only in cast submode */}
      {onWriteDiary && subMode === "cast" && (
        <Button variant="outline" size="sm" onClick={onWriteDiary} disabled={disabled} className="h-8 px-2.5 gap-1.5 text-xs border-primary/30 hover:border-primary">
          <NotebookPen className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">📓 Zapsat do deníku</span>
          <span className="sm:hidden">📓 Deník</span>
        </Button>
      )}

      {/* Příručka pro Káťu — only in kata submode */}
      {onGenerateHandbook && subMode === "kata" && (
        <Button variant="outline" size="sm" onClick={onGenerateHandbook} disabled={disabled || isHandbookLoading} className="h-8 px-2.5 gap-1.5 text-xs border-blue-500/30 hover:border-blue-500">
          {isHandbookLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <BookOpen className="w-3.5 h-3.5" />}
          <span className="hidden sm:inline">Příručka pro Káťu (PDF)</span>
          <span className="sm:hidden">Příručka</span>
        </Button>
      )}

      {/* Manual kartotéka update */}
      {onManualUpdate && (
        <Button variant="outline" size="sm" onClick={onManualUpdate} disabled={disabled || isUpdateLoading} className="h-8 px-2.5 gap-1.5 text-xs">
          {isUpdateLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          <span className="hidden sm:inline">Aktualizovat kartotéku</span>
          <span className="sm:hidden">Aktual.</span>
        </Button>
      )}

      {/* 🚪 End call button — Karel NIKDY neukončuje hovor sám */}
      {onEndCall && (
        <Button variant="destructive" size="sm" onClick={onEndCall} disabled={disabled} className="h-8 px-2.5 gap-1.5 text-xs">
          <PhoneOff className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">🚪 Ukončit hovor</span>
          <span className="sm:hidden">🚪 Ukončit</span>
        </Button>
      )}
    </div>
  );
};

export default DidActionButtons;

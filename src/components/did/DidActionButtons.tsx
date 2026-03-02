import { RefreshCw, Loader2, PhoneOff, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

interface DidActionButtonsProps {
  subMode: string;
  onEndCall?: () => void;
  onManualUpdate?: () => void;
  onLeaveThread?: () => void;
  isUpdateLoading?: boolean;
  disabled?: boolean;
}

const DidActionButtons = ({
  subMode,
  onEndCall,
  onManualUpdate,
  onLeaveThread,
  isUpdateLoading,
  disabled,
}: DidActionButtonsProps) => {
  return (
    <div className="flex items-center gap-2 flex-wrap justify-center mt-2">
      {/* Leave thread (back to thread list) */}
      {onLeaveThread && subMode === "cast" && (
        <Button variant="ghost" size="sm" onClick={onLeaveThread} disabled={disabled} className="h-8 px-2.5 gap-1.5 text-xs">
          <ArrowLeft className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">Odejít z vlákna</span>
          <span className="sm:hidden">Zpět</span>
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

      {/* End call button */}
      {onEndCall && (
        <Button variant="destructive" size="sm" onClick={onEndCall} disabled={disabled} className="h-8 px-2.5 gap-1.5 text-xs">
          <PhoneOff className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">Ukončit rozhovor</span>
          <span className="sm:hidden">Ukončit</span>
        </Button>
      )}
    </div>
  );
};

export default DidActionButtons;

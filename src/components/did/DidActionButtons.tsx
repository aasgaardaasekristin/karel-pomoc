import { BookOpen, Mail, Save, Loader2, PhoneOff, Search, RefreshCw, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

interface DidActionButtonsProps {
  subMode: string;
  onDiary?: () => void;
  onMessageMom?: () => void;
  onMessageKata?: () => void;
  onBackup?: () => void;
  onEndCall?: () => void;
  onResearch?: () => void;
  onManualUpdate?: () => void;
  onLeaveThread?: () => void;
  isBackupLoading?: boolean;
  isResearchLoading?: boolean;
  isUpdateLoading?: boolean;
  disabled?: boolean;
}

const DidActionButtons = ({
  subMode,
  onDiary,
  onMessageMom,
  onMessageKata,
  onBackup,
  onEndCall,
  onResearch,
  onManualUpdate,
  onLeaveThread,
  isBackupLoading,
  isResearchLoading,
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

      {/* Cast-specific buttons */}
      {subMode === "cast" && (
        <>
          {onDiary && (
            <Button variant="outline" size="sm" onClick={onDiary} disabled={disabled} className="h-8 px-2.5 gap-1.5 text-xs">
              <BookOpen className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Zapsat do deníku</span>
              <span className="sm:hidden">Deník</span>
            </Button>
          )}
          {onMessageMom && (
            <Button variant="outline" size="sm" onClick={onMessageMom} disabled={disabled} className="h-8 px-2.5 gap-1.5 text-xs">
              <Mail className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Vzkaz mamce</span>
              <span className="sm:hidden">Mamce</span>
            </Button>
          )}
          {onMessageKata && (
            <Button variant="outline" size="sm" onClick={onMessageKata} disabled={disabled} className="h-8 px-2.5 gap-1.5 text-xs">
              <Mail className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Vzkaz Káti</span>
              <span className="sm:hidden">Káti</span>
            </Button>
          )}
        </>
      )}

      {/* Research button for mamka/kata/general modes */}
      {onResearch && subMode !== "cast" && (
        <Button variant="outline" size="sm" onClick={onResearch} disabled={disabled || isResearchLoading} className="h-8 px-2.5 gap-1.5 text-xs">
          {isResearchLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
          <span className="hidden sm:inline">Hledat metody</span>
          <span className="sm:hidden">Hledat</span>
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

      {/* Backup button */}
      {onBackup && (
        <Button variant="outline" size="sm" onClick={onBackup} disabled={disabled || isBackupLoading} className="h-8 px-2.5 gap-1.5 text-xs">
          {isBackupLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          <span className="hidden sm:inline">Záloha na Drive</span>
          <span className="sm:hidden">Záloha</span>
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

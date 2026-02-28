import { BookOpen, Mail, Save, Loader2, PhoneOff } from "lucide-react";
import { Button } from "@/components/ui/button";

interface DidActionButtonsProps {
  subMode: string;
  onDiary?: () => void;
  onMessageMom?: () => void;
  onMessageKata?: () => void;
  onBackup?: () => void;
  onEndCall?: () => void;
  isBackupLoading?: boolean;
  disabled?: boolean;
}

const DidActionButtons = ({
  subMode,
  onDiary,
  onMessageMom,
  onMessageKata,
  onBackup,
  onEndCall,
  isBackupLoading,
  disabled,
}: DidActionButtonsProps) => {
  return (
    <div className="flex items-center gap-2 flex-wrap justify-center mt-2">
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

      {/* Backup button for all DID sub-modes */}
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

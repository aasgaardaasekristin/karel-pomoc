import { Mic, Square, Send, Trash2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { RecordingState } from "@/hooks/useAudioRecorder";

interface AudioRecordButtonProps {
  state: RecordingState;
  duration: number;
  audioUrl: string | null;
  isAnalyzing: boolean;
  onStart: () => void;
  onStop: () => void;
  onDiscard: () => void;
  onSend: () => void;
  disabled?: boolean;
}

const formatDuration = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
};

const AudioRecordButton = ({
  state,
  duration,
  audioUrl,
  isAnalyzing,
  onStart,
  onStop,
  onDiscard,
  onSend,
  disabled,
}: AudioRecordButtonProps) => {
  if (isAnalyzing) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-primary/10 border border-primary/20">
        <Loader2 className="w-4 h-4 animate-spin text-primary" />
        <span className="text-xs text-muted-foreground">Karel analyzuje nahrávku…</span>
      </div>
    );
  }

  if (state === "idle") {
    return (
      <Button
        variant="outline"
        size="icon"
        onClick={onStart}
        disabled={disabled}
        className="h-[44px] w-[44px] sm:h-[56px] sm:w-[56px] shrink-0"
        title="Nahrát audio k analýze"
      >
        <Mic className="w-4 h-4 sm:w-5 sm:h-5" />
      </Button>
    );
  }

  if (state === "recording") {
    return (
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-destructive/10 border border-destructive/30 animate-pulse">
          <div className="w-2 h-2 rounded-full bg-destructive" />
          <span className="text-xs font-medium text-destructive">{formatDuration(duration)}</span>
        </div>
        <Button
          variant="destructive"
          size="icon"
          onClick={onStop}
          className="h-9 w-9 shrink-0"
          title="Zastavit nahrávání"
        >
          <Square className="w-3.5 h-3.5" />
        </Button>
      </div>
    );
  }

  // state === "recorded"
  return (
    <div className="flex items-center gap-2">
      {audioUrl && (
        <audio src={audioUrl} controls className="h-8 max-w-[140px] sm:max-w-[200px]" />
      )}
      <Button
        variant="ghost"
        size="icon"
        onClick={onDiscard}
        className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
        title="Zahodit nahrávku"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </Button>
      <Button
        size="sm"
        onClick={onSend}
        className="gap-1.5 h-8 text-xs"
        title="Odeslat k analýze"
      >
        <Send className="w-3.5 h-3.5" />
        Analyzovat
      </Button>
    </div>
  );
};

export default AudioRecordButton;

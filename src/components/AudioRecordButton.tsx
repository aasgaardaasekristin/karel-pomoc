import { Mic, Square, Send, Trash2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type { RecordingState } from "@/hooks/useAudioRecorder";

interface AudioRecordButtonProps {
  state: RecordingState;
  duration: number;
  maxDuration: number;
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
  maxDuration,
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
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-primary/10 border border-primary/20">
        <Loader2 className="w-4 h-4 animate-spin text-primary" />
        <span className="text-xs text-muted-foreground">Karel analyzuje…</span>
      </div>
    );
  }

  if (state === "idle") {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={onStart}
        disabled={disabled}
        className="gap-1.5 h-9 px-3 shrink-0"
        title="Nahrát audio k analýze"
      >
        <Mic className="w-4 h-4" />
        <span className="hidden sm:inline">Nahrát</span>
      </Button>
    );
  }

  if (state === "recording") {
    const progress = Math.min((duration / maxDuration) * 100, 100);
    const remaining = maxDuration - duration;

    return (
      <div className="flex items-center gap-2 w-full">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <div className="w-2 h-2 rounded-full bg-destructive animate-pulse shrink-0" />
            <span className="text-xs font-medium text-destructive">{formatDuration(duration)}</span>
            <span className="text-[10px] text-muted-foreground">zbývá {formatDuration(remaining)}</span>
          </div>
          <Progress value={progress} className="h-1.5" />
        </div>
        <Button
          variant="destructive"
          size="sm"
          onClick={onStop}
          className="gap-1.5 h-8 px-3 shrink-0"
          title="Zastavit nahrávání"
        >
          <Square className="w-3.5 h-3.5" />
          Stop
        </Button>
      </div>
    );
  }

  // state === "recorded"
  return (
    <div className="flex items-center gap-2 w-full">
      {audioUrl && (
        <audio src={audioUrl} controls className="h-8 flex-1 min-w-0 max-w-[200px]" />
      )}
      <Button
        variant="ghost"
        size="sm"
        onClick={onDiscard}
        className="h-8 px-2 shrink-0 text-muted-foreground hover:text-destructive gap-1"
        title="Zahodit nahrávku"
      >
        <Trash2 className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">Zahodit</span>
      </Button>
      <Button
        size="sm"
        onClick={onSend}
        className="gap-1.5 h-8 px-3 shrink-0"
        title="Odeslat k analýze Karlovi"
      >
        <Send className="w-3.5 h-3.5" />
        Analyzovat
      </Button>
    </div>
  );
};

export default AudioRecordButton;

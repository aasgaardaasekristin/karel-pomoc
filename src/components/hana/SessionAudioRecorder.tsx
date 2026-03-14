import { Mic, Pause, Play, Square, Send, Trash2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type { SessionRecordingState } from "@/hooks/useSessionAudioRecorder";
import { MAX_SESSION_DURATION } from "@/hooks/useSessionAudioRecorder";

interface SessionAudioRecorderProps {
  state: SessionRecordingState;
  duration: number;
  audioUrl: string | null;
  isAnalyzing: boolean;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onDiscard: () => void;
  onSend: () => void;
  disabled?: boolean;
}

const fmt = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
};

const SessionAudioRecorder = ({
  state,
  duration,
  audioUrl,
  isAnalyzing,
  onStart,
  onPause,
  onResume,
  onStop,
  onDiscard,
  onSend,
  disabled,
}: SessionAudioRecorderProps) => {
  if (isAnalyzing) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-primary/10 border border-primary/20">
        <Loader2 className="w-4 h-4 animate-spin text-primary" />
        <span className="text-xs text-muted-foreground">Karel analyzuje nahrávku…</span>
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
        className="gap-1.5 h-8 px-3 text-xs w-full"
      >
        <Mic className="w-3.5 h-3.5" />
        Nahrát audio ze sezení
      </Button>
    );
  }

  const progress = Math.min((duration / MAX_SESSION_DURATION) * 100, 100);
  const remaining = MAX_SESSION_DURATION - duration;

  if (state === "recording" || state === "paused") {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <div className={`w-2 h-2 rounded-full shrink-0 ${state === "recording" ? "bg-destructive animate-pulse" : "bg-muted-foreground"}`} />
              <span className="text-xs font-medium text-foreground">{fmt(duration)}</span>
              <span className="text-[10px] text-muted-foreground">/ {fmt(MAX_SESSION_DURATION)}</span>
            </div>
            <Progress value={progress} className="h-1.5" />
          </div>
        </div>
        <div className="flex gap-1.5">
          {state === "recording" ? (
            <Button variant="outline" size="sm" onClick={onPause} className="gap-1 h-7 px-2 text-xs flex-1">
              <Pause className="w-3 h-3" /> Pauza
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={onResume} className="gap-1 h-7 px-2 text-xs flex-1">
              <Play className="w-3 h-3" /> Pokračuj
            </Button>
          )}
          <Button variant="destructive" size="sm" onClick={onStop} className="gap-1 h-7 px-2 text-xs flex-1">
            <Square className="w-3 h-3" /> Stop
          </Button>
          <Button variant="ghost" size="sm" onClick={onDiscard} className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive">
            <Trash2 className="w-3 h-3" />
          </Button>
        </div>
      </div>
    );
  }

  // state === "recorded"
  return (
    <div className="space-y-2">
      {audioUrl && (
        <audio src={audioUrl} controls className="h-8 w-full" />
      )}
      <div className="flex gap-1.5">
        <Button variant="ghost" size="sm" onClick={onDiscard} className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive gap-1 flex-1">
          <Trash2 className="w-3 h-3" /> Zahodit
        </Button>
        <Button size="sm" onClick={onSend} className="gap-1 h-7 px-2 text-xs flex-1">
          <Send className="w-3 h-3" /> Analyzovat
        </Button>
      </div>
    </div>
  );
};

export default SessionAudioRecorder;

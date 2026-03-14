import { useState, useRef, useCallback, useEffect } from "react";
import { toast } from "sonner";

export type SessionRecordingState = "idle" | "recording" | "paused" | "recorded";

export const MAX_SESSION_DURATION = 300; // 5 minutes

export const useSessionAudioRecorder = () => {
  const [state, setState] = useState<SessionRecordingState>("idle");
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const accumulatedRef = useRef(0); // accumulated time before pause
  const segmentStartRef = useRef(0); // when current segment started

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const startTimer = useCallback(() => {
    clearTimer();
    segmentStartRef.current = Date.now();
    timerRef.current = setInterval(() => {
      const elapsed = accumulatedRef.current + Math.floor((Date.now() - segmentStartRef.current) / 1000);
      setDuration(elapsed);
      if (elapsed >= MAX_SESSION_DURATION) {
        toast.info("Dosažen limit 5 minut – nahrávání zastaveno. Odešli nahrávku k analýze.");
        mediaRecorderRef.current?.stop();
        clearTimer();
      }
    }, 500);
  }, [clearTimer]);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : "audio/webm",
      });
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];
      accumulatedRef.current = 0;
      setDuration(0);

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        setAudioBlob(blob);
        setAudioUrl(URL.createObjectURL(blob));
        setState("recorded");
        clearTimer();
      };

      mediaRecorder.start(250);
      setState("recording");
      startTimer();
    } catch (err) {
      console.error("Microphone error:", err);
      toast.error("Nelze získat přístup k mikrofonu.");
    }
  }, [startTimer, clearTimer]);

  const pauseRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.pause();
      accumulatedRef.current += Math.floor((Date.now() - segmentStartRef.current) / 1000);
      clearTimer();
      setState("paused");
    }
  }, [clearTimer]);

  const resumeRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === "paused") {
      mediaRecorderRef.current.resume();
      setState("recording");
      startTimer();
    }
  }, [startTimer]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    clearTimer();
  }, [clearTimer]);

  const discardRecording = useCallback(() => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    setAudioBlob(null);
    setAudioUrl(null);
    setDuration(0);
    accumulatedRef.current = 0;
    setState("idle");
    clearTimer();
  }, [audioUrl, clearTimer]);

  const getBase64 = useCallback(async (): Promise<string | null> => {
    if (!audioBlob) return null;
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        resolve(result.split(",")[1]);
      };
      reader.readAsDataURL(audioBlob);
    });
  }, [audioBlob]);

  const reset = useCallback(() => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioBlob(null);
    setAudioUrl(null);
    setDuration(0);
    accumulatedRef.current = 0;
    setState("idle");
  }, [audioUrl]);

  useEffect(() => {
    return () => {
      clearTimer();
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
  }, []);

  return {
    state,
    duration,
    audioUrl,
    audioBlob,
    maxDuration: MAX_SESSION_DURATION,
    startRecording,
    pauseRecording,
    resumeRecording,
    stopRecording,
    discardRecording,
    getBase64,
    reset,
  };
};

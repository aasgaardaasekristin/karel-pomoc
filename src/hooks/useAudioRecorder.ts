import { useState, useRef, useCallback } from "react";
import { toast } from "sonner";

export type RecordingState = "idle" | "recording" | "recorded";

export const useAudioRecorder = () => {
  const [state, setState] = useState<RecordingState>("idle");
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : "audio/webm",
      });
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];
      setDuration(0);
      startTimeRef.current = Date.now();

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        setAudioBlob(blob);
        setAudioUrl(URL.createObjectURL(blob));
        setState("recorded");
        if (timerRef.current) clearInterval(timerRef.current);
      };

      const MAX_DURATION = 300; // 5 minut max

      mediaRecorder.start(250);
      setState("recording");

      timerRef.current = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
        setDuration(elapsed);
        if (elapsed >= MAX_DURATION) {
          toast.info("Dosažen maximální limit 5 minut – nahrávání zastaveno.");
          mediaRecorder.stop();
          clearInterval(timerRef.current!);
          timerRef.current = null;
        }
      }, 500);
    } catch (err) {
      console.error("Microphone error:", err);
      toast.error("Nelze získat přístup k mikrofonu. Povol prosím přístup v nastavení prohlížeče.");
    }
  }, []);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
    }
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const discardRecording = useCallback(() => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioBlob(null);
    setAudioUrl(null);
    setDuration(0);
    setState("idle");
  }, [audioUrl]);

  const getBase64 = useCallback(async (): Promise<string | null> => {
    if (!audioBlob) return null;
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        // Strip data:audio/webm;base64, prefix
        const base64 = result.split(",")[1];
        resolve(base64);
      };
      reader.readAsDataURL(audioBlob);
    });
  }, [audioBlob]);

  return {
    state,
    duration,
    audioUrl,
    startRecording,
    stopRecording,
    discardRecording,
    getBase64,
  };
};

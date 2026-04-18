import { useEffect, useRef, useState } from "react";

interface Props {
  onComplete: () => void;
}

type Phase = "playing" | "fading" | "done";

/**
 * Karel welcome intro — slow-motion video with extended end frame and gentle fade to /hub.
 * Shown after each successful login.
 *
 * Audio: original video audio kept at ~10% volume (whisper-like presence).
 */
const KarelWelcomeIntro = ({ onComplete }: Props) => {
  const [phase, setPhase] = useState<Phase>("playing");
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;

    // Slow-motion playback (65% speed) + whisper-level audio
    v.playbackRate = 0.65;
    v.volume = 0.1;
    v.currentTime = 0;

    const playPromise = v.play();
    if (playPromise !== undefined) {
      playPromise.catch(() => {
        // Autoplay blocked — try muted fallback, then continue
        v.muted = true;
        v.play().catch(() => {
          // Even muted failed — skip intro
          onComplete();
        });
      });
    }

    // Safety net: if video metadata never loads, finish after 12s
    const safety = setTimeout(() => {
      setPhase("fading");
    }, 12000);

    return () => clearTimeout(safety);
  }, [onComplete]);

  // When video ends, hold the last frame briefly, then fade out
  const handleVideoEnded = () => {
    const v = videoRef.current;
    if (v) {
      // Pause on last frame for extended hold
      v.pause();
    }
    // Extended hold on the final frame (1.4s) before fade
    setTimeout(() => setPhase("fading"), 1400);
  };

  // After fade animation completes, signal parent to navigate
  useEffect(() => {
    if (phase !== "fading") return;
    const t = setTimeout(() => {
      setPhase("done");
      onComplete();
    }, 2200);
    return () => clearTimeout(t);
  }, [phase, onComplete]);

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-background"
      style={{
        opacity: phase === "fading" ? 0 : 1,
        transition: "opacity 2.2s ease-in-out",
        pointerEvents: phase === "done" ? "none" : "auto",
      }}
    >
      {/* Soft radial glow behind avatar */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(circle at center, hsl(var(--primary) / 0.08) 0%, transparent 60%)",
        }}
      />

      <div
        className="relative rounded-full overflow-hidden"
        style={{
          width: 220,
          height: 220,
          boxShadow:
            "0 0 60px 20px hsl(var(--primary) / 0.18), 0 8px 32px hsl(var(--foreground) / 0.12)",
          transform: phase === "fading" ? "scale(0.9)" : "scale(1)",
          transition: "transform 2.2s ease-in-out",
        }}
      >
        <video
          ref={videoRef}
          src="/karel-avatar.mp4"
          autoPlay
          playsInline
          preload="auto"
          onEnded={handleVideoEnded}
          className="w-full h-full object-cover"
          style={{ borderRadius: "50%" }}
        />
      </div>
    </div>
  );
};

export default KarelWelcomeIntro;

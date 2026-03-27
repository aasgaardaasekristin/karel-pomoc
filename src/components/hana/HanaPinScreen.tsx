import { useState, useRef, useEffect } from "react";
import { Lock, KeyRound, ArrowRight } from "lucide-react";
import { KarelButton } from "@/components/ui/KarelButton";
import { toast } from "sonner";

const CORRECT_PIN = "0126";
const PIN_LENGTH = 4;

interface Props {
  onSuccess: () => void;
  onBack: () => void;
}

type Phase = "video" | "fading" | "pin" | "done";

const HanaPinScreen = ({ onSuccess, onBack }: Props) => {
  const [phase, setPhase] = useState<Phase>("video");
  const [digits, setDigits] = useState<string[]>(Array(PIN_LENGTH).fill(""));
  const [error, setError] = useState(false);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Video is ~10s. Start fading at 7s, show PIN at 10s.
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    timers.push(setTimeout(() => setPhase("fading"), 7000));
    timers.push(setTimeout(() => setPhase("pin"), 10000));
    timers.push(setTimeout(() => setPhase("done"), 11000));
    return () => timers.forEach(clearTimeout);
  }, []);

  // Focus first PIN input when pin phase starts
  useEffect(() => {
    if (phase === "pin" || phase === "done") {
      setTimeout(() => inputRefs.current[0]?.focus(), 300);
    }
  }, [phase]);

  const showVideo = phase === "video" || phase === "fading";
  const showPin = phase === "pin" || phase === "done";

  const handleChange = (index: number, value: string) => {
    const digit = value.replace(/\D/g, "").slice(-1);
    const next = [...digits];
    next[index] = digit;
    setDigits(next);
    setError(false);

    if (digit && index < PIN_LENGTH - 1) {
      inputRefs.current[index + 1]?.focus();
    }

    if (digit && index === PIN_LENGTH - 1) {
      const pin = next.join("");
      if (pin === CORRECT_PIN) {
        onSuccess();
      } else {
        setError(true);
        toast.error("Nesprávný PIN");
        setTimeout(() => {
          setDigits(Array(PIN_LENGTH).fill(""));
          inputRefs.current[0]?.focus();
        }, 400);
      }
    }
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent) => {
    if (e.key === "Backspace" && !digits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, PIN_LENGTH);
    if (!pasted) return;
    const next = Array(PIN_LENGTH).fill("");
    for (let i = 0; i < pasted.length; i++) next[i] = pasted[i];
    setDigits(next);
    if (pasted.length === PIN_LENGTH) {
      if (pasted === CORRECT_PIN) {
        onSuccess();
      } else {
        setError(true);
        toast.error("Nesprávný PIN");
        setTimeout(() => {
          setDigits(Array(PIN_LENGTH).fill(""));
          inputRefs.current[0]?.focus();
        }, 400);
      }
    } else {
      inputRefs.current[pasted.length]?.focus();
    }
  };

  const videoStyle: React.CSSProperties = {
    transition: "opacity 3s ease-in-out, transform 3s ease-in-out",
    opacity: phase === "fading" ? 0 : 1,
    transform: phase === "fading" ? "scale(0.85)" : "scale(1)",
  };

  return (
    <div
      className="min-h-[100dvh] flex flex-col items-center justify-center relative overflow-hidden"
      style={{ backgroundColor: "#F5F0E8" }}
    >
      {/* Back button */}
      <div className="absolute top-4 left-4 z-30">
        <KarelButton
          variant="ghost"
          size="sm"
          onClick={onBack}
          icon={<ArrowRight className="rotate-180" size={16} />}
        >
          Zpět
        </KarelButton>
      </div>

      {/* Video avatar */}
      {showVideo && (
        <div
          className="absolute inset-0 flex items-center justify-center z-10"
        >
          <div
            className="rounded-full overflow-hidden"
            style={{
              width: 180,
              height: 180,
              boxShadow: "0 0 40px 15px rgba(200,169,110,0.35), 0 4px 20px rgba(200,169,110,0.25)",
              ...videoStyle,
            }}
          >
            <video
              ref={videoRef}
              src="/hana-avatar.mp4"
              autoPlay
              muted
              playsInline
              className="w-full h-full object-cover"
              style={{ borderRadius: "50%" }}
            />
          </div>
        </div>
      )}

      {/* PIN form – appears after video fades */}
      {showPin && (
        <div
          className="flex flex-col items-center z-20"
          style={{ animation: "hana-pin-in 1.2s ease-out forwards" }}
        >
          <div className="text-center mb-10">
            <div className="w-16 h-16 rounded-full bg-[hsl(var(--accent-light))] flex items-center justify-center mx-auto mb-5">
              <Lock className="w-7 h-7 text-[hsl(var(--accent-primary))]" />
            </div>
            <h2 className="text-xl font-serif font-medium tracking-wide text-[hsl(var(--text-primary))]">
              Hana
            </h2>
            <p className="text-sm font-light tracking-wide text-[hsl(var(--text-secondary))] mt-1.5">
              Zadej osobní PIN pro přístup
            </p>
          </div>

          <div className="flex justify-center gap-3 mb-4" onPaste={handlePaste}>
            {digits.map((digit, i) => (
              <input
                key={i}
                ref={(el) => { inputRefs.current[i] = el; }}
                type="password"
                inputMode="numeric"
                maxLength={1}
                value={digit}
                onChange={(e) => handleChange(i, e.target.value)}
                onKeyDown={(e) => handleKeyDown(i, e)}
                className={`w-14 h-16 rounded-xl border-2 text-center text-2xl font-bold transition-all duration-200 bg-[hsl(var(--surface-primary))] text-[hsl(var(--text-primary))] focus:outline-none ${
                  error
                    ? "border-destructive animate-shake"
                    : "border-[hsl(var(--border-default))] focus:border-[hsl(var(--border-focus))] focus:shadow-glow-sm"
                }`}
              />
            ))}
          </div>

          {error && (
            <p className="text-xs text-destructive text-center animate-fade-in mb-4">
              Nesprávný PIN, zkus to znovu
            </p>
          )}

          <div className="mt-6">
            <KarelButton
              variant="ghost"
              size="sm"
              className="text-xs text-[hsl(var(--text-tertiary))]"
              onClick={() => toast.info("Generování vlastního hesla je zatím v testovacím režimu.")}
              icon={<KeyRound size={12} />}
            >
              Vygenerovat nové heslo
            </KarelButton>
          </div>
        </div>
      )}

      <style>{`
        @keyframes hana-pin-in {
          0% { opacity: 0; transform: scale(0.92) translateY(10px); }
          100% { opacity: 1; transform: scale(1) translateY(0); }
        }
      `}</style>
    </div>
  );
};

export default HanaPinScreen;

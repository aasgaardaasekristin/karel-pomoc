import { useState, useRef, useEffect } from "react";
import { Lock, KeyRound } from "lucide-react";
import { KarelButton } from "@/components/ui/KarelButton";
import { toast } from "sonner";

const CORRECT_PIN = "0126";
const PIN_LENGTH = 4;

interface Props {
  therapistName: string;
  onSuccess: () => void;
  onBack: () => void;
}

type AnimPhase = "avatar-in" | "avatar-grow" | "avatar-shrink" | "form-in" | "done";

const DidPinEntry = ({ therapistName, onSuccess, onBack }: Props) => {
  const [digits, setDigits] = useState<string[]>(Array(PIN_LENGTH).fill(""));
  const [error, setError] = useState(false);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const [phase, setPhase] = useState<AnimPhase>("avatar-in");
  const videoRef = useRef<HTMLVideoElement>(null);

  // Animation sequence
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    // Phase 1→2: avatar visible, then grow
    timers.push(setTimeout(() => setPhase("avatar-grow"), 1000));
    // Phase 2→3: shrink
    timers.push(setTimeout(() => setPhase("avatar-shrink"), 2500));
    // Phase 3→4: form appears
    timers.push(setTimeout(() => setPhase("form-in"), 4000));
    // Done
    timers.push(setTimeout(() => setPhase("done"), 5000));
    return () => timers.forEach(clearTimeout);
  }, []);

  // Focus first input when form appears
  useEffect(() => {
    if (phase === "form-in" || phase === "done") {
      setTimeout(() => inputRefs.current[0]?.focus(), 300);
    }
  }, [phase]);

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

  const showAvatar = phase === "avatar-in" || phase === "avatar-grow" || phase === "avatar-shrink";
  const showForm = phase === "form-in" || phase === "done";

  const avatarStyle: React.CSSProperties = {
    transition: "all 1.5s ease-in-out",
    opacity: phase === "avatar-in" ? 1 : phase === "avatar-grow" ? 1 : 0,
    transform:
      phase === "avatar-in"
        ? "scale(1)"
        : phase === "avatar-grow"
          ? "scale(1.3)"
          : "scale(0.5) translateY(20px)",
    filter:
      phase === "avatar-grow"
        ? "brightness(1.15)"
        : "brightness(1)",
    boxShadow:
      phase === "avatar-grow"
        ? "0 0 40px 15px rgba(200,169,110,0.45), 0 4px 20px rgba(200,169,110,0.3)"
        : "0 4px 20px rgba(200,169,110,0.3)",
  };

  return (
    <div
      className="flex flex-col items-center justify-center min-h-[60vh] px-4 relative"
      style={{ backgroundColor: "#F5F0E8" }}
    >
      {/* Karel Avatar Animation */}
      {showAvatar && (
        <div
          className="absolute inset-0 flex items-center justify-center"
          style={{ zIndex: 10 }}
        >
          <div
            className="rounded-full overflow-hidden"
            style={{
              width: 140,
              height: 140,
              ...avatarStyle,
            }}
          >
            <video
              ref={videoRef}
              src="/karel-avatar.mp4"
              autoPlay
              muted
              playsInline
              className="w-full h-full object-cover"
              style={{ borderRadius: "50%" }}
            />
          </div>
        </div>
      )}

      {/* PIN Form */}
      {showForm && (
        <div
          className="flex flex-col items-center animate-fade-in"
          style={{
            animation: "pin-form-in 1s ease-out forwards",
          }}
        >
          {/* Icon & Title */}
          <div className="text-center mb-10">
            <div className="w-16 h-16 rounded-full bg-[hsl(var(--accent-light))] flex items-center justify-center mx-auto mb-5">
              <Lock className="w-7 h-7 text-[hsl(var(--accent-primary))]" />
            </div>
            <h2 className="text-xl font-serif font-medium tracking-wide text-[hsl(var(--text-primary))]">
              {therapistName}
            </h2>
            <p className="text-sm font-light tracking-wide text-[hsl(var(--text-secondary))] mt-1.5">
              Zadej osobní PIN pro přístup
            </p>
          </div>

          {/* PIN Inputs */}
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

          {/* Change PIN link */}
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
        @keyframes pin-form-in {
          0% { opacity: 0; transform: scale(0.95); }
          100% { opacity: 1; transform: scale(1); }
        }
      `}</style>
    </div>
  );
};

export default DidPinEntry;

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

const DidPinEntry = ({ therapistName, onSuccess, onBack }: Props) => {
  const [digits, setDigits] = useState<string[]>(Array(PIN_LENGTH).fill(""));
  const [error, setError] = useState(false);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  // Focus first input on mount
  useEffect(() => {
    inputRefs.current[0]?.focus();
  }, []);

  const handleChange = (index: number, value: string) => {
    const digit = value.replace(/\D/g, "").slice(-1);
    const next = [...digits];
    next[index] = digit;
    setDigits(next);
    setError(false);

    if (digit && index < PIN_LENGTH - 1) {
      inputRefs.current[index + 1]?.focus();
    }

    // Auto-check when all filled
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

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] px-4">

      {/* Icon & Title */}
      <div className="text-center mb-10 animate-fade-in">
        <div className="w-16 h-16 rounded-full bg-[hsl(var(--accent-light))] flex items-center justify-center mx-auto mb-5">
          <Lock className="w-7 h-7 text-[hsl(var(--accent-primary))]" />
        </div>
        <h2 className="text-xl font-semibold text-[hsl(var(--text-primary))]">{therapistName}</h2>
        <p className="text-sm text-[hsl(var(--text-secondary))] mt-1.5">Zadej osobní PIN pro přístup</p>
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
                : document.activeElement === inputRefs.current[i]
                  ? "border-[hsl(var(--border-focus))] shadow-glow-sm"
                  : "border-[hsl(var(--border-default))]"
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
  );
};

export default DidPinEntry;

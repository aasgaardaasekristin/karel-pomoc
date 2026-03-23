import { useState } from "react";
import { ArrowLeft, Lock, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import ThemeQuickButton from "@/components/ThemeQuickButton";

const CORRECT_PIN = "0126";

interface Props {
  therapistName: string;
  onSuccess: () => void;
  onBack: () => void;
}

const DidPinEntry = ({ therapistName, onSuccess, onBack }: Props) => {
  const [pin, setPin] = useState("");
  const [error, setError] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (pin === CORRECT_PIN) {
      setError(false);
      onSuccess();
    } else {
      setError(true);
      setPin("");
      toast.error("Nesprávný PIN");
    }
  };

  return (
    <div className="max-w-sm mx-auto py-12 px-4">
      <div className="flex items-center justify-between mb-6">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="w-4 h-4 mr-1" />
          Zpět
        </Button>
        <ThemeQuickButton />
      </div>

      <div className="text-center mb-8">
        <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
          <Lock className="w-7 h-7 text-primary" />
        </div>
        <h2 className="text-lg font-serif font-semibold text-foreground">
          {therapistName}
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Zadej osobní PIN pro přístup
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <Input
          type="password"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={6}
          value={pin}
          onChange={(e) => { setPin(e.target.value); setError(false); }}
          placeholder="PIN"
          className={`text-center text-2xl tracking-[0.5em] h-14 ${error ? "border-destructive" : ""}`}
          autoFocus
        />
        {error && (
          <p className="text-xs text-destructive text-center">Nesprávný PIN, zkus to znovu</p>
        )}
        <Button type="submit" className="w-full" disabled={pin.length < 4}>
          Vstoupit
        </Button>
      </form>

      <div className="mt-6 text-center">
        <Button
          variant="ghost"
          size="sm"
          className="text-xs text-muted-foreground"
          onClick={() => toast.info("Generování vlastního hesla je zatím v testovacím režimu. Bude dostupné později.")}
        >
          <KeyRound className="w-3 h-3 mr-1" />
          Vygenerovat nové heslo
        </Button>
      </div>
    </div>
  );
};

export default DidPinEntry;

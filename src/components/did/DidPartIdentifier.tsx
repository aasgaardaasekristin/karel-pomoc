import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowLeft, Loader2, Search } from "lucide-react";
import { sanitizePartName } from "@/lib/didPartNaming";
import { getAuthHeaders } from "@/lib/auth";
import { toast } from "sonner";

export interface PartSelection {
  partName: string;   // canonical part name from server (e.g. "arthur")
  threadLabel: string; // display label for the thread (e.g. "Artur")
  raw: string;         // original user input
}

interface Props {
  knownParts: string[];
  onSelectPart: (selection: PartSelection) => void;
  onBack: () => void;
}

const DidPartIdentifier = ({ knownParts, onSelectPart, onBack }: Props) => {
  const [customName, setCustomName] = useState("");
  const [isDetecting, setIsDetecting] = useState(false);

  const handleSubmit = async () => {
    const safeName = sanitizePartName(customName);
    if (!safeName) return;

    setIsDetecting(true);
    try {
      const rawInput = customName.trim();

      // Call server-side identity resolver (DB + Drive Excel + Levenshtein)
      const headers = await getAuthHeaders();
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-part-detect`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ name: safeName }),
        }
      );

      if (response.ok) {
        const result = await response.json();

        if (result.matched && result.partName) {
          // Server matched — use canonical name from registry
          const label = result.partName.toLowerCase() === safeName.toLowerCase() ? result.displayName : safeName;
          toast.success(`Rozpoznán: ${result.displayName} ✓ (${result.source === "both" ? "DB + Drive" : result.source === "db" ? "registr" : "Drive Excel"})`);
          onSelectPart({ partName: result.partName, threadLabel: label, raw: rawInput });
        } else {
          // No match — use input as-is
          onSelectPart({ partName: safeName, threadLabel: safeName, raw: rawInput });
        }
      } else {
        // Server error — fall back to local matching
        console.warn("[DidPartIdentifier] Server detection failed, using local fallback");
        const inputLower = safeName.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        const match = knownParts.find((part) => {
          const partLower = part.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
          return partLower === inputLower || partLower.includes(inputLower) || inputLower.includes(partLower);
        });
        if (match) {
          const label = match.toLowerCase() === safeName.toLowerCase() ? match : safeName;
          toast.success(`Rozpoznán: ${match} ✓`);
          onSelectPart({ partName: match, threadLabel: label, raw: rawInput });
        } else {
          onSelectPart({ partName: safeName, threadLabel: safeName, raw: rawInput });
        }
      }
    } finally {
      setIsDetecting(false);
    }
  };

  return (
    <div className="max-w-md mx-auto py-12 px-4 animate-fade-in">
      <div className="flex justify-start mb-6">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="w-4 h-4 mr-1" />
          Zpět
        </Button>
      </div>

      <div className="text-center mb-8">
        <div className="text-4xl mb-3">👋</div>
        <h2 className="text-xl font-serif font-semibold text-foreground mb-2">
          Ahoj! Jak ti říkají?
        </h2>
        <p className="text-sm text-muted-foreground">
          Napiš své jméno a Karel tě pozná.
        </p>
      </div>

      <div className="space-y-4">
        <div className="relative">
          <Input
            value={customName}
            onChange={(e) => setCustomName(e.target.value)}
            placeholder="Tvoje jméno..."
            className="text-center text-lg h-12 pr-10"
            autoFocus
            disabled={isDetecting}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSubmit();
            }}
          />
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        </div>
        
        <Button
          onClick={handleSubmit}
          disabled={!sanitizePartName(customName) || isDetecting}
          className="w-full h-11 text-base gap-2"
        >
          {isDetecting ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Hledám tě...
            </>
          ) : (
            "Začít 🚀"
          )}
        </Button>
      </div>

      <p className="text-[0.625rem] text-muted-foreground text-center mt-6 opacity-60">
        Karel tě pozná podle jména — stačí napsat, jak ti říkají.
      </p>
    </div>
  );
};

export default DidPartIdentifier;

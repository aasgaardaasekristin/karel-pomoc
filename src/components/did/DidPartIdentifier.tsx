import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowLeft, UserPlus } from "lucide-react";
import { sanitizePartName, uniqueSanitizedPartNames } from "@/lib/didPartNaming";

interface Props {
  knownParts: string[];
  onSelectPart: (partName: string) => void;
  onBack: () => void;
}

const DidPartIdentifier = ({ knownParts, onSelectPart, onBack }: Props) => {
  const [customName, setCustomName] = useState("");
  const visibleParts = uniqueSanitizedPartNames(knownParts);

  return (
    <div className="max-w-2xl mx-auto py-8 px-4">
      <div className="flex justify-start mb-4">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="w-4 h-4 mr-1" />
          Zpět
        </Button>
      </div>

      <h2 className="text-xl font-serif font-semibold text-foreground text-center mb-2">
        Kdo teď mluví?
      </h2>
      <p className="text-sm text-muted-foreground text-center mb-6">
        Vyber skutečně aktivní část, nebo napiš jméno ručně.
      </p>

      {visibleParts.length > 0 && (
        <div className="space-y-2 mb-6">
          <p className="text-xs text-muted-foreground font-medium">Aktivní části:</p>
          <div className="flex flex-wrap gap-2">
            {visibleParts.map((part) => (
              <button
                key={part}
                onClick={() => onSelectPart(part)}
                className="px-4 py-2 rounded-full border border-border bg-card/70 hover:border-primary/50 hover:bg-card transition-all text-sm font-medium text-foreground"
              >
                {part}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-3">
        <p className="text-xs text-muted-foreground font-medium flex items-center gap-1.5">
          <UserPlus className="w-3.5 h-3.5" />
          Nebo napiš jméno:
        </p>
        <div className="flex gap-2">
          <Input
            value={customName}
            onChange={(e) => setCustomName(e.target.value)}
            placeholder="Jak ti říkají?"
            className="flex-1"
            onKeyDown={(e) => {
              const safeName = sanitizePartName(customName);
              if (e.key === "Enter" && safeName) {
                onSelectPart(safeName);
              }
            }}
          />
          <Button
            onClick={() => {
              const safeName = sanitizePartName(customName);
              if (safeName) onSelectPart(safeName);
            }}
            disabled={!sanitizePartName(customName)}
          >
            Začít
          </Button>
        </div>
      </div>
    </div>
  );
};

export default DidPartIdentifier;

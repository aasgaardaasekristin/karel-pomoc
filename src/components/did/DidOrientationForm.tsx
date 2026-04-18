import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Send, ArrowLeft } from "lucide-react";

interface DidOrientationFormProps {
  onSubmit: (context: string) => void;
  onBack?: () => void;
  notebookProject?: string;
  onNotebookProjectChange?: (val: string) => void;
}

const DidOrientationForm = ({ onSubmit, onBack, notebookProject = "DID – vnitřní mapa systému (pracovní)", onNotebookProjectChange }: DidOrientationFormProps) => {
  const [selected, setSelected] = useState<string[]>([]);
  const [note, setNote] = useState("");

  const checkboxOptions = [
    { id: "switch", label: "Proběhl switch / přepnutí osobnosti" },
    { id: "conflict", label: "Konflikt mezi částmi" },
    { id: "regression", label: "Regres (dítě se chová mladší)" },
    { id: "trigger", label: "Spuštěný trigger / flashback" },
    { id: "sleep", label: "Problémy se spánkem" },
    { id: "school", label: "Potíže ve škole / kolektivu" },
    { id: "boundary", label: "Nejistota kolem hranic" },
    { id: "exhaustion", label: "Vyčerpání / přetížení Haničky" },
    { id: "newpart", label: "Nová část se projevila" },
    { id: "calm", label: "Období klidu – chci prevenci" },
  ];

  const toggle = (id: string) =>
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );

  const handleSubmit = () => {
    if (selected.length === 0 && !note.trim()) return;

    const selectedLabels = selected.map(
      (id) => checkboxOptions.find((o) => o.id === id)?.label ?? id
    );

    let context = "ORIENTAČNÍ FORMULÁŘ (Hanička vyplnila před zahájením rozhovoru):\n\n";
    context += `NotebookLM projekt: ${notebookProject}\n\n`;
    if (selectedLabels.length > 0) {
      context += "Aktuální situace:\n" + selectedLabels.map((l) => `- ${l}`).join("\n");
    }
    if (note.trim()) {
      context += `\n\nDoplňující poznámka od Haničky:\n${note.trim()}`;
    }
    context +=
      "\n\nPOKYN: Tyto informace už MÁŠ. NEOPAKUJ je a NEPTEJ se na ně znovu. Rovnou reaguj – zvol odpovídající typ reakce (uklidnění, strukturování, výchovná rada, supervize) podle toho, co formulář naznačuje.";

    onSubmit(context);
  };

  return (
    <div className="max-w-2xl mx-auto py-8 px-4">
      {onBack && (
        <div className="flex justify-start mb-4">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft className="w-4 h-4 mr-1" />
            Zpět na výběr
          </Button>
        </div>
      )}
      <h2 className="text-xl font-serif font-semibold text-foreground text-center mb-2">
        Rychlá orientace
      </h2>
      <p className="text-sm text-muted-foreground text-center mb-4">
        Zaškrtni, co teď řešíš – Karel se podle toho zorientuje.
      </p>

      {/* NotebookLM info block */}
      <div className="rounded-lg border border-border bg-muted/50 p-3 mb-6 text-sm text-muted-foreground">
        <strong className="text-foreground">📓 NotebookLM</strong> je paměť a databáze. Karel nemá automatický přístup. Pokud chceš, vlož sem výňatek z NotebookLM (max 10 řádků). Ty rozhoduješ, co se předá.
      </div>

      {/* NotebookLM project field */}
      <div className="mb-6">
        <label className="text-sm font-medium text-foreground mb-1.5 block">
          📓 NotebookLM projekt
        </label>
        <input
          type="text"
          value={notebookProject}
          onChange={(e) => onNotebookProjectChange?.(e.target.value)}
          className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          placeholder="DID – vnitřní mapa systému (pracovní)"
        />
        <p className="text-xs text-muted-foreground mt-1">Název projektu v NotebookLM, kam Karel bude směřovat doporučení k uložení.</p>
      </div>

      <div className="space-y-3 mb-6">
        {checkboxOptions.map((opt) => (
          <label
            key={opt.id}
            className="flex items-center gap-3 p-3 rounded-lg border border-border bg-card hover:bg-card/80 cursor-pointer transition-colors"
          >
            <Checkbox
              checked={selected.includes(opt.id)}
              onCheckedChange={() => toggle(opt.id)}
            />
            <span className="text-sm text-foreground">{opt.label}</span>
          </label>
        ))}
      </div>

      <div className="mb-6">
        <label className="text-sm font-medium text-foreground mb-1.5 block">
          Chceš něco dodat? (nepovinné)
        </label>
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Stručně popiš, co se děje..."
          className="min-h-[5rem] resize-none"
        />
      </div>

      <Button
        onClick={handleSubmit}
        disabled={selected.length === 0 && !note.trim()}
        className="w-full"
        size="lg"
      >
        <Send className="w-4 h-4 mr-2" />
        Začít rozhovor s Karlem
      </Button>
    </div>
  );
};

export default DidOrientationForm;

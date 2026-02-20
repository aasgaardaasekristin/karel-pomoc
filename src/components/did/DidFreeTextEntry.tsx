import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Send, ArrowLeft } from "lucide-react";

interface DidFreeTextEntryProps {
  onSubmit: (context: string) => void;
  onBack?: () => void;
  notebookProject?: string;
  onNotebookProjectChange?: (val: string) => void;
}

const DidFreeTextEntry = ({ onSubmit, onBack, notebookProject = "DID – vnitřní mapa systému (pracovní)", onNotebookProjectChange }: DidFreeTextEntryProps) => {
  const [whatNow, setWhatNow] = useState("");
  const [whoActive, setWhoActive] = useState("");
  const [goalNow, setGoalNow] = useState("");
  const [text, setText] = useState("");

  const isValid = whatNow.trim() || whoActive.trim() || goalNow || text.trim();

  const handleSubmit = () => {
    if (!isValid) return;

    let context = "ZÁZNAM OD MAMKY (strukturovaný vstup před zahájením rozhovoru):\n\n";
    context += `NotebookLM projekt: ${notebookProject}\n\n`;
    if (whatNow.trim()) context += `Co se děje teď: ${whatNow.trim()}\n`;
    if (whoActive.trim()) context += `Kdo je aktivní: ${whoActive.trim()}\n`;
    if (goalNow) context += `Cíl teď: ${goalNow}\n`;
    if (text.trim()) context += `\nDoplňující kontext / výňatek z NotebookLM:\n${text.trim()}\n`;

    context += "\n\nPOKYN: Přečti si tento text. Pomoz ho strukturovat, proveď supervizní rozhovor a navrhni další postup nebo řešení. Na konci konverzace nabídni: \"Chceš z toho udělat krátký zápis?\" Pokud mamka souhlasí, vytvoř strukturovaný textový zápis (shrnutí, doporučení, další kroky) a nabídni export.";

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
        Zapsat situaci nebo osobnost
      </h2>
      <p className="text-sm text-muted-foreground text-center mb-6">
        Napiš poznatek o konkrétní osobnosti, popiš situaci, konflikt nebo obavu.
        Karel ti pomůže text strukturovat a navrhne další postup.
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

      {/* Structured prompts */}
      <div className="space-y-4 mb-6">
        <div>
          <label className="text-sm font-medium text-foreground mb-1.5 block">
            🔹 Co se děje teď (1–2 věty)
          </label>
          <Textarea
            value={whatNow}
            onChange={(e) => setWhatNow(e.target.value)}
            placeholder="Popiš aktuální situaci…"
            className="min-h-[60px] resize-none"
          />
        </div>
        <div>
          <label className="text-sm font-medium text-foreground mb-1.5 block">
            🔹 Kdo je aktivní (max 2 části + věk/role)
          </label>
          <Textarea
            value={whoActive}
            onChange={(e) => setWhoActive(e.target.value)}
            placeholder="Např. Maruška (5, strach), Vojta (ochránce)…"
            className="min-h-[60px] resize-none"
          />
        </div>
        <div>
          <label className="text-sm font-medium text-foreground mb-1.5 block">
            🔹 Cíl teď
          </label>
          <div className="flex flex-wrap gap-2 mb-2">
            {["zklidnit", "hranice", "přechod", "konflikt", "mini-terapie", "plán dne"].map((goal) => (
              <button
                key={goal}
                type="button"
                onClick={() => setGoalNow(goalNow === goal ? "" : goal)}
                className={`px-3 py-1 rounded-full text-xs border transition-colors ${
                  goalNow === goal
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-card border-border text-foreground hover:border-primary/50"
                }`}
              >
                {goal}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mb-4">
        <label className="text-sm font-medium text-foreground mb-1.5 block">
          Doplňující kontext / výňatek z NotebookLM (nepovinné)
        </label>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Cokoliv dalšího, výňatek z deníku, mapy systému…"
          className="min-h-[100px] resize-none"
        />
      </div>

      <Button
        onClick={handleSubmit}
        disabled={!isValid}
        className="w-full"
        size="lg"
      >
        <Send className="w-4 h-4 mr-2" />
        Odeslat Karlovi
      </Button>
    </div>
  );
};

export default DidFreeTextEntry;

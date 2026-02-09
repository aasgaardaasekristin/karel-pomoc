import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Send } from "lucide-react";

interface DidFreeTextEntryProps {
  onSubmit: (context: string) => void;
}

const DidFreeTextEntry = ({ onSubmit }: DidFreeTextEntryProps) => {
  const [text, setText] = useState("");

  const handleSubmit = () => {
    if (!text.trim()) return;

    const context = `ZÁZNAM OD MAMKY (volný text vložený před zahájením rozhovoru):\n\n${text.trim()}\n\nPOKYN: Přečti si tento text. Pomoz ho strukturovat, proveď supervizní rozhovor a navrhni další postup nebo řešení. Na konci konverzace nabídni: "Chceš z toho udělat krátký zápis?" Pokud mamka souhlasí, vytvoř strukturovaný textový zápis (shrnutí, doporučení, další kroky) a nabídni export.`;

    onSubmit(context);
  };

  return (
    <div className="max-w-2xl mx-auto py-8 px-4">
      <h2 className="text-xl font-serif font-semibold text-foreground text-center mb-2">
        Zapsat situaci nebo osobnost
      </h2>
      <p className="text-sm text-muted-foreground text-center mb-6">
        Napiš poznatek o konkrétní osobnosti, popiš situaci, konflikt nebo obavu.
        Karel ti pomůže text strukturovat a navrhne další postup.
      </p>

      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Napiš sem, co tě zaměstnává – o které části / situaci chceš mluvit..."
        className="min-h-[180px] resize-none mb-6"
      />

      <Button
        onClick={handleSubmit}
        disabled={!text.trim()}
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

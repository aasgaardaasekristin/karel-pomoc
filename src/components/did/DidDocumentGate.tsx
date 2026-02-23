import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ArrowLeft, BookOpen, CheckCircle2 } from "lucide-react";

interface DidDocumentGateProps {
  subMode: string;
  onSubmit: (docs: { seznam: string; mapa: string }) => void;
  onBack: () => void;
}

const DidDocumentGate = ({ subMode, onSubmit, onBack }: DidDocumentGateProps) => {
  const [seznam, setSeznam] = useState("");
  const [mapa, setMapa] = useState("");

  const seznamOk = seznam.trim().length >= 10;
  const mapaOk = mapa.trim().length >= 10;
  const canSubmit = seznamOk && mapaOk;

  const modeLabel = subMode === "mamka" ? "Mamka (terapeut)" : subMode === "cast" ? "Část mluví s Karlem" : "Obecná konzultace";

  return (
    <div className="max-w-2xl mx-auto py-8 px-4">
      <div className="flex justify-start mb-4">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="w-4 h-4 mr-1" />
          Zpět na výběr
        </Button>
      </div>

      <div className="text-center mb-6">
        <BookOpen className="w-8 h-8 mx-auto mb-2 text-primary" />
        <h2 className="text-xl font-serif font-semibold text-foreground mb-1">
          Příprava pro režim: {modeLabel}
        </h2>
        <p className="text-sm text-muted-foreground">
          Aby Karel věděl, s kým pracuje, potřebuje nejdříve nahrát 2 dokumenty z NotebookLM.
        </p>
      </div>

      <div className="rounded-lg border border-border bg-muted/50 p-3 mb-6 text-sm text-muted-foreground">
        <strong className="text-foreground">📓 Proč je to důležité?</strong>{" "}
        Karel potřebuje znát strukturu systému a seznam částí, aby rozpoznal, zda mluví s již známou částí nebo s novou. Bez těchto dokumentů nemůže správně reagovat.
      </div>

      {/* Document 1: Seznam částí */}
      <div className="mb-5">
        <label className="text-sm font-medium text-foreground mb-1.5 flex items-center gap-2">
          {seznamOk ? (
            <CheckCircle2 className="w-4 h-4 text-green-500" />
          ) : (
            <span className="w-4 h-4 rounded-full border-2 border-muted-foreground/40 inline-block" />
          )}
          📋 01_Seznam_částí
          <span className="text-destructive">*</span>
        </label>
        <p className="text-xs text-muted-foreground mb-1.5">
          Vlož obsah dokumentu <strong>00_Seznam částí</strong> z NotebookLM – seznam všech známých částí/osobností.
        </p>
        <Textarea
          value={seznam}
          onChange={(e) => setSeznam(e.target.value)}
          placeholder="Vlož sem seznam částí z NotebookLM..."
          className="min-h-[100px] resize-y"
        />
      </div>

      {/* Document 2: Hlavní mapa systému */}
      <div className="mb-6">
        <label className="text-sm font-medium text-foreground mb-1.5 flex items-center gap-2">
          {mapaOk ? (
            <CheckCircle2 className="w-4 h-4 text-green-500" />
          ) : (
            <span className="w-4 h-4 rounded-full border-2 border-muted-foreground/40 inline-block" />
          )}
          🗺️ 01_Hlavní_mapa_systému
          <span className="text-destructive">*</span>
        </label>
        <p className="text-xs text-muted-foreground mb-1.5">
          Vlož obsah dokumentu <strong>01_Hlavní mapa systému</strong> z NotebookLM – struktura a architektura vnitřního systému.
        </p>
        <Textarea
          value={mapa}
          onChange={(e) => setMapa(e.target.value)}
          placeholder="Vlož sem hlavní mapu systému z NotebookLM..."
          className="min-h-[100px] resize-y"
        />
      </div>

      <Button
        onClick={() => onSubmit({ seznam: seznam.trim(), mapa: mapa.trim() })}
        disabled={!canSubmit}
        className="w-full"
        size="lg"
      >
        <BookOpen className="w-4 h-4 mr-2" />
        Pokračovat do rozhovoru
      </Button>

      {!canSubmit && (
        <p className="text-xs text-muted-foreground text-center mt-2">
          Oba dokumenty musí být vyplněny (min. 10 znaků).
        </p>
      )}
    </div>
  );
};

export default DidDocumentGate;

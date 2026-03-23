import { Users, Stethoscope, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import ThemeQuickButton from "@/components/ThemeQuickButton";

interface Props {
  onSelectTerapeut: () => void;
  onSelectKluci: () => void;
  onBack: () => void;
}

const DidEntryScreen = ({ onSelectTerapeut, onSelectKluci, onBack }: Props) => {
  return (
    <div className="max-w-md mx-auto py-10 px-4">
      <div className="flex justify-center mb-4">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="w-4 h-4 mr-1" />
          Zpět na výběr režimu
        </Button>
      </div>
      <h2 className="text-xl font-serif font-semibold text-foreground text-center mb-2">
        Kdo teď mluví?
      </h2>
      <p className="text-sm text-muted-foreground text-center mb-8">
        Vyber, kdo právě pracuje s Karlem
      </p>
      <div className="space-y-4">
        <button
          onClick={onSelectTerapeut}
          className="w-full flex items-center gap-4 p-5 rounded-xl border-2 border-border bg-card hover:border-pink-500/50 hover:bg-card/80 transition-all text-left border-l-4 border-l-pink-500"
        >
          <Stethoscope className="w-6 h-6 text-pink-500 shrink-0" />
          <div>
            <div className="font-semibold text-foreground text-lg">Terapeut</div>
            <div className="text-sm text-muted-foreground mt-0.5">
              Hanička nebo Káťa – supervize, analýza, plánování
            </div>
          </div>
        </button>

        <button
          onClick={onSelectKluci}
          className="w-full flex items-center gap-4 p-5 rounded-xl border-2 border-border bg-card hover:border-primary/50 hover:bg-card/80 transition-all text-left border-l-4 border-l-primary"
        >
          <Users className="w-6 h-6 text-primary shrink-0" />
          <div>
            <div className="font-semibold text-foreground text-lg">Kluci</div>
            <div className="text-sm text-muted-foreground mt-0.5">
              Části systému – rozhovor s Karlem, vlastní vlákna
            </div>
          </div>
        </button>
      </div>
    </div>
  );
};

export default DidEntryScreen;

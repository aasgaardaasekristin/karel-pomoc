import { useState, useEffect } from "react";
import ThemeQuickButton from "@/components/ThemeQuickButton";
import { useTheme } from "@/contexts/ThemeContext";
import { Button } from "@/components/ui/button";
import { Leaf, ArrowLeft, ShieldCheck } from "lucide-react";
import ScenarioSelector, { type CalmScenario } from "@/components/calm/ScenarioSelector";
import CalmChat from "@/components/calm/CalmChat";

const THEME_STORAGE_KEY = "theme_pomoc";

const Pomoc = () => {
  const { applyTemporaryTheme, restoreGlobalTheme, setLocalMode } = useTheme();

  useEffect(() => {
    setLocalMode(THEME_STORAGE_KEY);
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved) {
      try { applyTemporaryTheme(JSON.parse(saved)); } catch {}
    }
    return () => { setLocalMode(null); restoreGlobalTheme(); };
  }, []);

  const [started, setStarted] = useState(false);
  const [scenario, setScenario] = useState<CalmScenario | null>(null);

  const handleEnd = () => {
    setScenario(null);
  };

  const handleBack = () => {
    if (scenario) {
      setScenario(null);
    } else {
      setStarted(false);
    }
  };

  if (!started) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <div className="w-full max-w-md text-center space-y-8">
          <div className="flex justify-center">
            <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center">
              <Leaf className="w-10 h-10 text-primary" />
            </div>
          </div>

          <div className="space-y-3">
            <h1 className="text-2xl sm:text-3xl font-serif font-semibold text-foreground">
              Je ti teď těžko?
            </h1>
            <p className="text-muted-foreground text-base leading-relaxed max-w-sm mx-auto">
              Tohle je krátká, anonymní podpora. Žádné přihlášení, žádné ukládání dat.
            </p>
          </div>

          <Button
            onClick={() => setStarted(true)}
            size="lg"
            className="h-14 px-8 text-base font-medium rounded-xl"
          >
            <Leaf className="w-5 h-5 mr-2" />
            Začít krátkou podporu
          </Button>

          <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
            <ShieldCheck className="w-3.5 h-3.5" />
            <span>Anonymní · nic se neukládá · bez přihlášení</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <header className="border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" data-swipe-back="true" onClick={handleBack} className="shrink-0">
              <ArrowLeft className="w-4 h-4" />
            </Button>
            <div>
              <h1 className="text-lg font-serif font-semibold text-foreground flex items-center gap-2">
                <Leaf className="w-4 h-4 text-primary" />
                Zklidnění
              </h1>
              <p className="text-xs text-muted-foreground">Krátký průvodce pro chvíle, kdy to potřebuješ</p>
            </div>
          </div>
          <ThemeQuickButton storageKey={THEME_STORAGE_KEY} />
        </div>
      </header>

      {scenario ? (
        <CalmChat scenario={scenario} onEnd={handleEnd} />
      ) : (
        <ScenarioSelector onSelect={setScenario} />
      )}
    </div>
  );
};

export default Pomoc;

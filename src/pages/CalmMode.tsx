import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Leaf } from "lucide-react";
import ScenarioSelector, { type CalmScenario } from "@/components/calm/ScenarioSelector";
import CalmChat from "@/components/calm/CalmChat";

const CalmMode = () => {
  const [scenario, setScenario] = useState<CalmScenario | null>(null);
  const navigate = useNavigate();

  const handleEnd = () => {
    setScenario(null);
  };

  const handleBack = () => {
    if (scenario) {
      setScenario(null);
    } else {
      navigate("/");
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={handleBack} className="shrink-0">
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
        </div>
      </header>

      {/* Content */}
      {scenario ? (
        <CalmChat scenario={scenario} onEnd={handleEnd} />
      ) : (
        <ScenarioSelector onSelect={setScenario} />
      )}
    </div>
  );
};

export default CalmMode;

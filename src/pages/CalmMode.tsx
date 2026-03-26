import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import ThemeQuickButton from "@/components/ThemeQuickButton";
import { useTheme } from "@/contexts/ThemeContext";
import { KarelButton } from "@/components/ui/KarelButton";
import { ArrowLeft, Leaf } from "lucide-react";
import ScenarioSelector, { type CalmScenario } from "@/components/calm/ScenarioSelector";
import CalmChat from "@/components/calm/CalmChat";

const THEME_STORAGE_KEY = "theme_zklidneni";

const CalmMode = () => {
  const { applyTemporaryTheme, restoreGlobalTheme, setLocalMode } = useTheme();

  useEffect(() => {
    setLocalMode(THEME_STORAGE_KEY);
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved) {
      try { applyTemporaryTheme(JSON.parse(saved)); } catch {}
    }
    return () => { setLocalMode(null); restoreGlobalTheme(); };
  }, []);

  const [scenario, setScenario] = useState<CalmScenario | null>(null);
  const navigate = useNavigate();

  const handleEnd = () => setScenario(null);
  const handleBack = () => {
    if (scenario) setScenario(null);
    else navigate("/");
  };

  return (
    <div className="min-h-[100dvh] flex flex-col relative overflow-hidden" data-section="calm">
      {/* Animated background circles */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div className="absolute -top-1/4 -left-1/4 w-[60vw] h-[60vw] rounded-full bg-gradient-to-br from-teal-400 to-cyan-400 opacity-[0.03] animate-breathe" />
        <div className="absolute -bottom-1/4 -right-1/4 w-[50vw] h-[50vw] rounded-full bg-gradient-to-br from-cyan-400 to-blue-400 opacity-[0.03] animate-breathe" style={{ animationDelay: "1.5s" }} />
      </div>

      {/* Gradient background */}
      <div className="absolute inset-0 bg-gradient-to-br from-teal-50 via-cyan-50 to-blue-50 dark:from-teal-950/30 dark:via-cyan-950/20 dark:to-blue-950/30 -z-10" />

      <header className="shrink-0 border-b border-[hsl(var(--border-subtle))] bg-[hsl(var(--surface-primary)/0.8)] backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <KarelButton variant="ghost" size="icon" onClick={handleBack} icon={<ArrowLeft size={18} />} />
            <div>
              <h1 className="text-base font-semibold text-[hsl(var(--text-primary))] flex items-center gap-2">
                <Leaf size={16} className="text-teal-600 dark:text-teal-400" />
                Zklidnění
              </h1>
              <p className="text-xs text-[hsl(var(--text-tertiary))]">Krátký průvodce pro chvíle, kdy to potřebuješ</p>
            </div>
          </div>
          <ThemeQuickButton storageKey={THEME_STORAGE_KEY} />
        </div>
      </header>

      <div className="flex-1 relative z-0">
        {scenario ? (
          <CalmChat scenario={scenario} onEnd={handleEnd} />
        ) : (
          <ScenarioSelector onSelect={setScenario} />
        )}
      </div>
    </div>
  );
};

export default CalmMode;

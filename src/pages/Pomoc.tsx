import { useState, useEffect } from "react";
import ThemeQuickButton from "@/components/ThemeQuickButton";
import { useTheme } from "@/contexts/ThemeContext";
import { KarelButton } from "@/components/ui/KarelButton";
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

  const handleEnd = () => setScenario(null);
  const handleBack = () => {
    if (scenario) setScenario(null);
    else setStarted(false);
  };

  if (!started) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center p-4 relative overflow-hidden" data-section="pomoc">
        {/* Animated background circles */}
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
          <div className="absolute -top-1/4 -right-1/4 w-[60vw] h-[60vw] rounded-full bg-gradient-to-br from-rose-400 to-pink-400 opacity-[0.03] animate-breathe" />
          <div className="absolute -bottom-1/4 -left-1/4 w-[50vw] h-[50vw] rounded-full bg-gradient-to-br from-pink-400 to-orange-400 opacity-[0.03] animate-breathe" style={{ animationDelay: "1.5s" }} />
        </div>

        {/* Gradient background */}
        <div className="absolute inset-0 bg-gradient-to-br from-rose-50 via-pink-50 to-orange-50 dark:from-rose-950/30 dark:via-pink-950/20 dark:to-orange-950/30 -z-10" />

        <div className="w-full max-w-md text-center space-y-8 relative z-10 animate-fade-in">
          <div className="flex justify-center">
            <div className="w-20 h-20 rounded-full bg-rose-100 dark:bg-rose-900/30 flex items-center justify-center">
              <Leaf className="w-10 h-10 text-rose-600 dark:text-rose-400" />
            </div>
          </div>

          <div className="space-y-3">
            <h1 className="text-2xl sm:text-3xl font-bold text-[hsl(var(--text-primary))]">
              Je ti teď těžko?
            </h1>
            <p className="text-[hsl(var(--text-secondary))] text-base leading-relaxed max-w-sm mx-auto">
              Tohle je krátká, anonymní podpora. Žádné přihlášení, žádné ukládání dat.
            </p>
          </div>

          <KarelButton
            variant="primary"
            size="lg"
            onClick={() => setStarted(true)}
            icon={<Leaf size={18} />}
            className="h-14 px-8 text-base rounded-xl"
          >
            Začít krátkou podporu
          </KarelButton>

          <div className="flex items-center justify-center gap-2 text-xs text-[hsl(var(--text-disabled))]">
            <ShieldCheck size={14} />
            <span>Anonymní · nic se neukládá · bez přihlášení</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] flex flex-col relative overflow-hidden" data-section="pomoc">
      {/* Animated background circles */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div className="absolute -top-1/4 -right-1/4 w-[60vw] h-[60vw] rounded-full bg-gradient-to-br from-rose-400 to-pink-400 opacity-[0.03] animate-breathe" />
        <div className="absolute -bottom-1/4 -left-1/4 w-[50vw] h-[50vw] rounded-full bg-gradient-to-br from-pink-400 to-orange-400 opacity-[0.03] animate-breathe" style={{ animationDelay: "1.5s" }} />
      </div>

      <div className="absolute inset-0 bg-gradient-to-br from-rose-50 via-pink-50 to-orange-50 dark:from-rose-950/30 dark:via-pink-950/20 dark:to-orange-950/30 -z-10" />

      <header className="shrink-0 border-b border-[hsl(var(--border-subtle))] bg-[hsl(var(--surface-primary)/0.8)] backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <KarelButton variant="ghost" size="icon" data-swipe-back="true" onClick={handleBack} icon={<ArrowLeft size={18} />} />
            <div>
              <h1 className="text-base font-semibold text-[hsl(var(--text-primary))] flex items-center gap-2">
                <Leaf size={16} className="text-rose-600 dark:text-rose-400" />
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

export default Pomoc;

import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useTheme } from "@/contexts/ThemeContext";
import { Brain, BookOpen, Heart, LogOut, Shield, Lock, ArrowRight, ChevronRight } from "lucide-react";
import { KarelCard } from "@/components/ui/KarelCard";
import { KarelButton } from "@/components/ui/KarelButton";
import ThemeQuickButton from "@/components/ThemeQuickButton";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

const CORRECT_PIN = "0126";
const HANA_PIN_KEY = "karel_hana_pin_verified";
const THEME_STORAGE_KEY = "theme_hub";

const sections = [
  {
    key: "did",
    title: "DID",
    description: "Kartotéka, rozhovory s částmi, tandem-supervize, přehled systému",
    icon: Brain,
    gradient: "from-purple-500/10 to-violet-500/10",
    iconBg: "bg-purple-100 dark:bg-purple-900/30",
    iconColor: "text-purple-600 dark:text-purple-400",
    locked: false,
  },
  {
    key: "research",
    title: "Profesní zdroje",
    description: "Karel prohledá internet – odborné články, testy, metody, trendy",
    icon: BookOpen,
    gradient: "from-emerald-500/10 to-green-500/10",
    iconBg: "bg-emerald-100 dark:bg-emerald-900/30",
    iconColor: "text-emerald-600 dark:text-emerald-400",
    locked: false,
  },
  {
    key: "hana",
    title: "Hana",
    description: "Debrief, supervize, bezpečnost, klinický report",
    icon: Heart,
    gradient: "from-blue-500/10 to-sky-500/10",
    iconBg: "bg-blue-100 dark:bg-blue-900/30",
    iconColor: "text-blue-600 dark:text-blue-400",
    locked: true,
  },
] as const;

const Hub = () => {
  const navigate = useNavigate();
  const { applyTemporaryTheme, restoreGlobalTheme, setLocalMode } = useTheme();
  const [authChecked, setAuthChecked] = useState(false);
  const [showPinEntry, setShowPinEntry] = useState(false);
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState(false);

  useEffect(() => {
    setLocalMode(THEME_STORAGE_KEY);
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved) {
      try { applyTemporaryTheme(JSON.parse(saved)); } catch {}
    }
    return () => { setLocalMode(null); restoreGlobalTheme(); };
  }, []);

  useEffect(() => {
    const checkAuth = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) navigate("/", { replace: true });
      else setAuthChecked(true);
    };
    checkAuth();
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) navigate("/", { replace: true });
    });
    return () => subscription.unsubscribe();
  }, [navigate]);

  const handleLogout = async () => {
    try { sessionStorage.removeItem(HANA_PIN_KEY); } catch {}
    await supabase.auth.signOut();
    navigate("/");
  };

  const handleSectionClick = (key: string) => {
    if (key === "hana") {
      try {
        if (sessionStorage.getItem(HANA_PIN_KEY) === "1") {
          sessionStorage.setItem("karel_hub_section", "hana");
          navigate("/chat");
          return;
        }
      } catch {}
      setShowPinEntry(true);
      return;
    }
    try { sessionStorage.setItem("karel_hub_section", key); } catch {}
    navigate("/chat");
  };

  const handlePinSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (pin === CORRECT_PIN) {
      try { sessionStorage.setItem(HANA_PIN_KEY, "1"); } catch {}
      try { sessionStorage.setItem("karel_hub_section", "hana"); } catch {}
      navigate("/chat");
    } else {
      setPinError(true);
      setPin("");
      toast.error("Nesprávný PIN");
    }
  };

  if (!authChecked) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-[hsl(var(--surface-secondary))]">
        <Loader2 className="w-8 h-8 animate-spin text-[hsl(var(--text-tertiary))]" />
      </div>
    );
  }

  if (showPinEntry) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-[hsl(var(--surface-secondary))] p-4">
        <div className="max-w-sm w-full animate-fade-in">
          <div className="flex justify-start mb-8">
            <KarelButton
              variant="ghost"
              size="sm"
              onClick={() => { setShowPinEntry(false); setPin(""); setPinError(false); }}
              icon={<ArrowRight className="rotate-180" size={16} />}
            >
              Zpět
            </KarelButton>
          </div>

          <div className="text-center mb-10">
            <div className="w-16 h-16 rounded-full bg-[hsl(var(--accent-light))] flex items-center justify-center mx-auto mb-5">
              <Lock className="w-7 h-7 text-[hsl(var(--accent-primary))]" />
            </div>
            <h2 className="text-xl font-semibold text-[hsl(var(--text-primary))]">Režim Hana</h2>
            <p className="text-sm text-[hsl(var(--text-secondary))] mt-1.5">
              Zadej PIN pro přístup k supervizním nástrojům
            </p>
          </div>

          <form onSubmit={handlePinSubmit} className="space-y-4">
            <div className="flex justify-center gap-3">
              {[0, 1, 2, 3].map((i) => (
                <input
                  key={i}
                  type="password"
                  inputMode="numeric"
                  maxLength={1}
                  value={pin[i] || ""}
                  readOnly
                  className={`w-14 h-16 rounded-xl border-2 text-center text-2xl font-bold bg-[hsl(var(--surface-primary))] text-[hsl(var(--text-primary))] transition-all duration-200 focus:outline-none ${
                    pinError
                      ? "border-destructive animate-shake"
                      : pin.length === i
                        ? "border-[hsl(var(--border-focus))] shadow-glow-sm"
                        : "border-[hsl(var(--border-default))]"
                  }`}
                />
              ))}
            </div>
            {/* Hidden real input for keyboard */}
            <input
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={4}
              value={pin}
              onChange={(e) => {
                const val = e.target.value.replace(/\D/g, "").slice(0, 4);
                setPin(val);
                setPinError(false);
                if (val.length === 4) {
                  // Auto-submit
                  if (val === CORRECT_PIN) {
                    try { sessionStorage.setItem(HANA_PIN_KEY, "1"); } catch {}
                    try { sessionStorage.setItem("karel_hub_section", "hana"); } catch {}
                    navigate("/chat");
                  } else {
                    setPinError(true);
                    setTimeout(() => setPin(""), 300);
                    toast.error("Nesprávný PIN");
                  }
                }
              }}
              autoFocus
              className="sr-only"
            />
            {pinError && (
              <p className="text-xs text-destructive text-center animate-fade-in">
                Nesprávný PIN, zkus to znovu
              </p>
            )}
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] flex flex-col bg-[hsl(var(--surface-secondary))]">
      {/* Header */}
      <header className="shrink-0 border-b border-[hsl(var(--border-subtle))]">
        <div className="max-w-md mx-auto px-4 py-3 flex items-center justify-between">
          <div />
          <div className="flex items-center gap-1">
            <ThemeQuickButton storageKey={THEME_STORAGE_KEY} />
            <KarelButton variant="ghost" size="icon" onClick={handleLogout} icon={<LogOut size={16} />} aria-label="Odejít" />
          </div>
        </div>
      </header>

      {/* Content */}
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="max-w-md w-full">
          {/* Logo */}
          <div className="flex flex-col items-center mb-10 animate-fade-in">
            <div className="w-16 h-16 rounded-2xl bg-[hsl(var(--accent-light))] flex items-center justify-center text-3xl mb-3">
              🤖
            </div>
            <h1 className="text-3xl font-bold text-[hsl(var(--text-primary))]">Karel</h1>
            <p className="text-sm text-[hsl(var(--text-secondary))] mt-1">Supervizní partner a tandem-terapeut</p>
          </div>

          {/* Section cards */}
          <div className="space-y-3">
            {sections.map((section, index) => {
              const Icon = section.icon;
              return (
                <KarelCard
                  key={section.key}
                  variant="interactive"
                  padding="none"
                  className="animate-fade-in overflow-hidden"
                  style={{ animationDelay: `${index * 80}ms`, animationFillMode: "both" }}
                  onClick={() => handleSectionClick(section.key)}
                >
                  <div className={`flex items-center gap-4 p-5 bg-gradient-to-r ${section.gradient}`}>
                    <div className={`w-12 h-12 rounded-xl ${section.iconBg} flex items-center justify-center shrink-0`}>
                      <Icon size={24} className={section.iconColor} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-lg font-semibold text-[hsl(var(--text-primary))]">
                          {section.title}
                        </span>
                      </div>
                      <p className="text-sm text-[hsl(var(--text-secondary))] mt-0.5 line-clamp-2">
                        {section.description}
                      </p>
                      {section.locked && (
                        <div className="flex items-center gap-1 mt-1.5 text-xs text-[hsl(var(--text-tertiary))]">
                          <Lock size={10} />
                          Vyžaduje PIN
                        </div>
                      )}
                    </div>
                    <ChevronRight size={18} className="text-[hsl(var(--text-disabled))] shrink-0" />
                  </div>
                </KarelCard>
              );
            })}
          </div>

          {/* Calm link */}
          <div className="text-center mt-8 animate-fade-in" style={{ animationDelay: "240ms", animationFillMode: "both" }}>
            <a
              href="/zklidneni"
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full text-sm text-[hsl(var(--text-secondary))] hover:bg-[hsl(var(--surface-tertiary))] transition-colors duration-200"
            >
              <Shield size={16} />
              Potřebuju se teď zklidnit
            </a>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Hub;

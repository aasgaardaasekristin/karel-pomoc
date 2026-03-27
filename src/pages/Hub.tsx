import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useTheme } from "@/contexts/ThemeContext";
import { Sparkles, BookOpen, Heart, LogOut, Shield, Lock, ArrowRight, ChevronRight } from "lucide-react";
import karelAvatar from '@/assets/karel-avatar.png';
import { KarelCard } from "@/components/ui/KarelCard";
import { KarelButton } from "@/components/ui/KarelButton";
import ThemeQuickButton from "@/components/ThemeQuickButton";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

const CORRECT_PIN = "0126";
const HANA_PIN_KEY = "karel_hana_pin_verified";
const THEME_STORAGE_KEY = "theme_hub";

type HanaPinPhase = "video" | "fading" | "pin" | "done";

const sections = [
  {
    key: "did",
    title: "DID",
    description: "Kartotéka, rozhovory s částmi, tandem-supervize, přehled systému",
    icon: Sparkles,
    bg: "#D4C4A8",
    bgHover: "#C9B896",
    textColor: "#5D4E37",
    locked: false,
  },
  {
    key: "research",
    title: "Profesní zdroje",
    description: "Karel prohledá internet – odborné články, testy, metody, trendy",
    icon: BookOpen,
    bg: "#E0D5C3",
    bgHover: "#D5C9B5",
    textColor: "#5D4E37",
    locked: false,
  },
  {
    key: "hana",
    title: "Hana",
    description: "Debrief, supervize, bezpečnost, klinický report",
    icon: Heart,
    bg: "#C8A96E",
    bgHover: "#BB9C61",
    textColor: "#4A3B28",
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
    return <HanaPinScreen onSuccess={() => {
      try { sessionStorage.setItem(HANA_PIN_KEY, "1"); } catch {}
      try { sessionStorage.setItem("karel_hub_section", "hana"); } catch {}
      navigate("/chat");
    }} onBack={() => { setShowPinEntry(false); setPin(""); setPinError(false); }} />;
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
            <img src={karelAvatar} alt="Karel" className="w-16 h-16 rounded-2xl object-cover mb-3" />
            <h1 className="text-3xl font-bold text-[hsl(var(--text-primary))]">Karel</h1>
            <p className="text-sm text-[hsl(var(--text-secondary))] mt-1">Supervizní partner a tandem-terapeut</p>
          </div>

          {/* Section cards */}
          <div className="space-y-3">
            {sections.map((section, index) => {
              const Icon = section.icon;
              return (
                <div
                  key={section.key}
                  className="rounded-xl border shadow-sm cursor-pointer transition-all duration-200 animate-fade-in overflow-hidden group"
                  style={{
                    animationDelay: `${index * 80}ms`,
                    animationFillMode: "both",
                    backgroundColor: section.bg,
                    borderColor: `${section.bg}cc`,
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = section.bgHover; }}
                  onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = section.bg; }}
                  onClick={() => handleSectionClick(section.key)}
                >
                  <div className="flex items-center gap-4 p-5">
                    <div
                      className="w-12 h-12 rounded-xl flex items-center justify-center shrink-0"
                      style={{ backgroundColor: `${section.textColor}18` }}
                    >
                      <Icon size={24} style={{ color: section.textColor }} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-lg font-semibold" style={{ color: section.textColor }}>
                          {section.title}
                        </span>
                      </div>
                      <p className="text-sm mt-0.5 line-clamp-2" style={{ color: `${section.textColor}cc` }}>
                        {section.description}
                      </p>
                      {section.locked && (
                        <div className="flex items-center gap-1 mt-1.5 text-xs" style={{ color: `${section.textColor}99` }}>
                          <Lock size={10} />
                          Vyžaduje PIN
                        </div>
                      )}
                    </div>
                    <ChevronRight size={18} style={{ color: `${section.textColor}66` }} className="shrink-0" />
                  </div>
                </div>
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

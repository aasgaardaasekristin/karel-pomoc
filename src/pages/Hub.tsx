import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useTheme } from "@/contexts/ThemeContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Lock, Users, Heart, LogOut, Leaf, ArrowLeft, KeyRound, Search } from "lucide-react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

const CORRECT_PIN = "0126";
const HANA_PIN_KEY = "karel_hana_pin_verified";

const Hub = () => {
  const navigate = useNavigate();
  const { setContextKey } = useTheme();
  const [authChecked, setAuthChecked] = useState(false);
  const [showPinEntry, setShowPinEntry] = useState(false);
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState(false);

  useEffect(() => {
    setContextKey("global");
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

  const handleDidClick = () => {
    try { sessionStorage.setItem("karel_hub_section", "did"); } catch {}
    navigate("/chat");
  };

  const handleResearchClick = () => {
    try { sessionStorage.setItem("karel_hub_section", "research"); } catch {}
    navigate("/chat");
  };

  const handleHanaClick = () => {
    try {
      if (sessionStorage.getItem(HANA_PIN_KEY) === "1") {
        try { sessionStorage.setItem("karel_hub_section", "hana"); } catch {}
        navigate("/chat");
        return;
      }
    } catch {}
    setShowPinEntry(true);
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
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (showPinEntry) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <div className="max-w-sm w-full">
          <div className="flex justify-center mb-6">
            <Button variant="ghost" size="sm" data-swipe-back="true" onClick={() => { setShowPinEntry(false); setPin(""); setPinError(false); }}>
              <ArrowLeft className="w-4 h-4 mr-1" />
              Zpět
            </Button>
          </div>

          <div className="text-center mb-8">
            <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
              <Lock className="w-7 h-7 text-primary" />
            </div>
            <h2 className="text-lg font-serif font-semibold text-foreground">
              Režim Hana
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              Zadej PIN pro přístup k supervizním nástrojům
            </p>
          </div>

          <form onSubmit={handlePinSubmit} className="space-y-4">
            <Input
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              value={pin}
              onChange={(e) => { setPin(e.target.value); setPinError(false); }}
              placeholder="PIN"
              className={`text-center text-2xl tracking-[0.5em] h-14 ${pinError ? "border-destructive" : ""}`}
              autoFocus
            />
            {pinError && (
              <p className="text-xs text-destructive text-center">Nesprávný PIN, zkus to znovu</p>
            )}
            <Button type="submit" className="w-full" disabled={pin.length < 4}>
              Vstoupit
            </Button>
          </form>

          <div className="mt-6 text-center">
            <Button
              variant="ghost"
              size="sm"
              className="text-xs text-muted-foreground"
              onClick={() => toast.info("Změna PINu bude dostupná později.")}
            >
              <KeyRound className="w-3 h-3 mr-1" />
              Změnit PIN
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <header className="border-b border-border bg-card/50 backdrop-blur-sm">
        <div className="max-w-4xl mx-auto px-3 sm:px-4 py-2.5 sm:py-4 flex items-center justify-between">
          <div>
            <h1 className="text-base sm:text-xl font-serif font-semibold text-foreground">Karel</h1>
            <p className="text-xs sm:text-sm text-muted-foreground hidden sm:block">Supervizní partner a tandem-terapeut</p>
          </div>
          <Button variant="ghost" size="sm" onClick={handleLogout} className="h-8 px-2 sm:px-3">
            <LogOut className="w-4 h-4 sm:mr-2" />
            <span className="hidden sm:inline">Odejít</span>
          </Button>
        </div>
      </header>

      <div className="flex-1 flex items-center justify-center p-4">
        <div className="max-w-lg w-full space-y-6">
          <div className="text-center mb-8">
            <h2 className="text-2xl font-serif font-semibold text-foreground mb-2">
              Kam dnes míříš?
            </h2>
            <p className="text-sm text-muted-foreground">
              Vyber pracovní prostředí
            </p>
          </div>

          <div className="space-y-4">
            {/* DID Mode - No PIN */}
            <button
              onClick={handleDidClick}
              className="w-full flex items-center gap-4 p-6 rounded-xl border-2 border-border bg-card hover:border-primary/50 hover:bg-card/80 transition-all text-left border-l-4 border-l-primary group"
            >
              <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center shrink-0 group-hover:bg-primary/20 transition-colors">
                <Users className="w-6 h-6 text-primary" />
              </div>
              <div>
                <div className="font-semibold text-foreground text-lg">DID</div>
                <div className="text-sm text-muted-foreground mt-0.5">
                  Kartotéka, rozhovory s částmi, tandem-supervize, přehled systému
                </div>
              </div>
            </button>

            {/* Research Mode - No PIN */}
            <button
              onClick={handleResearchClick}
              className="w-full flex items-center gap-4 p-6 rounded-xl border-2 border-border bg-card hover:border-accent/50 hover:bg-card/80 transition-all text-left border-l-4 border-l-accent group"
            >
              <div className="w-12 h-12 rounded-full bg-accent/10 flex items-center justify-center shrink-0 group-hover:bg-accent/20 transition-colors">
                <Search className="w-6 h-6 text-accent" />
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-foreground text-lg">Profesní zdroje</span>
                </div>
                <div className="text-sm text-muted-foreground mt-0.5">
                  Karel prohledá internet – odborné články, testy, metody, trendy v psychologii
                </div>
              </div>
            </button>

            {/* Hana Mode - Requires PIN */}
            <button
              onClick={handleHanaClick}
              className="w-full flex items-center gap-4 p-6 rounded-xl border-2 border-border bg-card hover:border-pink-500/50 hover:bg-card/80 transition-all text-left border-l-4 border-l-pink-500 group"
            >
              <div className="w-12 h-12 rounded-full bg-pink-500/10 flex items-center justify-center shrink-0 group-hover:bg-pink-500/20 transition-colors">
                <Heart className="w-6 h-6 text-pink-500" />
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-foreground text-lg">Hana</span>
                  <Lock className="w-3.5 h-3.5 text-muted-foreground" />
                </div>
                <div className="text-sm text-muted-foreground mt-0.5">
                  Debrief, supervize, bezpečnost, klinický report
                </div>
              </div>
            </button>
          </div>

          {/* Calm mode link */}
          <div className="text-center pt-4">
            <a
              href="/zklidneni"
              className="inline-flex items-center gap-2 px-5 py-3 rounded-xl border border-border bg-card hover:bg-secondary/60 transition-all duration-200 text-sm text-foreground group"
            >
              <Leaf className="w-4 h-4 text-primary group-hover:scale-110 transition-transform" />
              <span>Potřebuju se teď zklidnit</span>
            </a>
            <p className="text-xs text-muted-foreground mt-2">Bez přihlášení · nic se neukládá</p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Hub;
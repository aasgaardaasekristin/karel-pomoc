import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import ThemeQuickButton from "@/components/ThemeQuickButton";
import { useTheme } from "@/contexts/ThemeContext";
import { KarelButton } from "@/components/ui/KarelButton";
import { KarelCard } from "@/components/ui/KarelCard";
import { KarelInput } from "@/components/ui/KarelInput";
import { Leaf, Mail, Loader2, CheckCircle, AlertCircle } from "lucide-react";
import ScenarioSelector, { type CalmScenario } from "@/components/calm/ScenarioSelector";
import CalmChat from "@/components/calm/CalmChat";

type Step = "email" | "sent" | "verifying" | "verified" | "error";

const THEME_STORAGE_KEY = "theme_zklidneni";

const Zklidneni = () => {
  const { applyTemporaryTheme, restoreGlobalTheme, setLocalMode } = useTheme();

  useEffect(() => {
    setLocalMode(THEME_STORAGE_KEY);
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved) {
      try { applyTemporaryTheme(JSON.parse(saved)); } catch {}
    }
    return () => { setLocalMode(null); restoreGlobalTheme(); };
  }, []);

  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");

  const [step, setStep] = useState<Step>(token ? "verifying" : "email");
  const [email, setEmail] = useState("");
  const [verifiedEmail, setVerifiedEmail] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [scenario, setScenario] = useState<CalmScenario | null>(null);

  useEffect(() => {
    if (!token) return;
    const verify = async () => {
      try {
        const res = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-calm-verify`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
            },
            body: JSON.stringify({ token }),
          }
        );
        const data = await res.json();
        if (data.valid) {
          setVerifiedEmail(data.email);
          setStep("verified");
        } else {
          setErrorMsg(data.error || "Neplatný odkaz");
          setStep("error");
        }
      } catch {
        setErrorMsg("Chyba připojení");
        setStep("error");
      }
    };
    verify();
  }, [token]);

  const handleSendLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setIsLoading(true);
    setErrorMsg("");
    try {
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-calm-magic-link`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
          },
          body: JSON.stringify({ email: email.trim() }),
        }
      );
      const data = await res.json();
      if (res.ok && data.success) {
        setStep("sent");
      } else {
        setErrorMsg(data.error || "Něco se pokazilo");
      }
    } catch {
      setErrorMsg("Chyba připojení");
    } finally {
      setIsLoading(false);
    }
  };

  const handleEnd = () => setScenario(null);

  const headerContent = (
    <header className="shrink-0 border-b border-[hsl(var(--border-subtle))] bg-[hsl(var(--surface-primary)/0.8)] backdrop-blur-sm sticky top-0 z-10">
      <div className="max-w-2xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <KarelButton variant="ghost" size="icon" onClick={() => setScenario(null)} icon={<Leaf size={18} className="text-teal-600 dark:text-teal-400" />} />
          <div>
            <h1 className="text-base font-semibold text-[hsl(var(--text-primary))]">Zklidnění</h1>
            <p className="text-xs text-[hsl(var(--text-tertiary))]">Bezpečný prostor pro tebe</p>
          </div>
        </div>
        <ThemeQuickButton storageKey={THEME_STORAGE_KEY} />
      </div>
    </header>
  );

  if (step === "verified" && scenario) {
    return (
      <div className="min-h-[100dvh] flex flex-col relative overflow-hidden" data-section="calm">
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
          <div className="absolute -top-1/4 -left-1/4 w-[60vw] h-[60vw] rounded-full bg-gradient-to-br from-teal-400 to-cyan-400 opacity-[0.03] animate-breathe" />
          <div className="absolute -bottom-1/4 -right-1/4 w-[50vw] h-[50vw] rounded-full bg-gradient-to-br from-cyan-400 to-blue-400 opacity-[0.03] animate-breathe" style={{ animationDelay: "1.5s" }} />
        </div>
        <div className="absolute inset-0 bg-gradient-to-br from-teal-50 via-cyan-50 to-blue-50 dark:from-teal-950/30 dark:via-cyan-950/20 dark:to-blue-950/30 -z-10" />
        {headerContent}
        <div className="flex-1 relative z-0">
          <CalmChat scenario={scenario} onEnd={handleEnd} />
        </div>
      </div>
    );
  }

  if (step === "verified") {
    return (
      <div className="min-h-[100dvh] flex flex-col relative overflow-hidden" data-section="calm">
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
          <div className="absolute -top-1/4 -left-1/4 w-[60vw] h-[60vw] rounded-full bg-gradient-to-br from-teal-400 to-cyan-400 opacity-[0.03] animate-breathe" />
          <div className="absolute -bottom-1/4 -right-1/4 w-[50vw] h-[50vw] rounded-full bg-gradient-to-br from-cyan-400 to-blue-400 opacity-[0.03] animate-breathe" style={{ animationDelay: "1.5s" }} />
        </div>
        <div className="absolute inset-0 bg-gradient-to-br from-teal-50 via-cyan-50 to-blue-50 dark:from-teal-950/30 dark:via-cyan-950/20 dark:to-blue-950/30 -z-10" />
        {headerContent}
        <div className="flex-1 relative z-0">
          <ScenarioSelector onSelect={setScenario} />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] flex items-center justify-center p-4 relative overflow-hidden" data-section="calm">
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div className="absolute -top-1/4 -left-1/4 w-[60vw] h-[60vw] rounded-full bg-gradient-to-br from-teal-400 to-cyan-400 opacity-[0.03] animate-breathe" />
        <div className="absolute -bottom-1/4 -right-1/4 w-[50vw] h-[50vw] rounded-full bg-gradient-to-br from-cyan-400 to-blue-400 opacity-[0.03] animate-breathe" style={{ animationDelay: "1.5s" }} />
      </div>
      <div className="absolute inset-0 bg-gradient-to-br from-teal-50 via-cyan-50 to-blue-50 dark:from-teal-950/30 dark:via-cyan-950/20 dark:to-blue-950/30 -z-10" />

      <div className="absolute top-4 right-4 z-10">
        <ThemeQuickButton storageKey={THEME_STORAGE_KEY} />
      </div>

      <div className="w-full max-w-md relative z-10 animate-fade-in">
        <div className="text-center mb-8">
          <div className="w-16 h-16 rounded-full bg-teal-100 dark:bg-teal-900/30 flex items-center justify-center mx-auto mb-4">
            <Leaf className="w-8 h-8 text-teal-600 dark:text-teal-400" />
          </div>
          <h1 className="text-2xl font-bold text-[hsl(var(--text-primary))] mb-2">
            Chci si popovídat
          </h1>
          <p className="text-[hsl(var(--text-secondary))] text-sm leading-relaxed">
            Bezpečný prostor, kde tě někdo vyslechne.<br />
            Nic se neukládá. Jsi tu anonymně.
          </p>
        </div>

        {step === "email" && (
          <KarelCard variant="elevated" padding="lg">
            <p className="text-sm text-[hsl(var(--text-secondary))] text-center mb-4">
              Pro přístup zadej svůj e-mail. Pošleme ti jednorázový odkaz.
            </p>
            <form onSubmit={handleSendLink} className="space-y-4">
              <KarelInput
                type="email"
                placeholder="Tvůj e-mail"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                icon={<Mail size={16} />}
                error={errorMsg || undefined}
                autoFocus
                required
              />
              <KarelButton
                type="submit"
                variant="primary"
                className="w-full h-12"
                loading={isLoading}
                disabled={!email.trim()}
              >
                Poslat odkaz
              </KarelButton>
            </form>
            <p className="text-xs text-[hsl(var(--text-disabled))] text-center mt-4">
              E-mail slouží pouze k ověření. Žádný účet se nevytváří.
            </p>
          </KarelCard>
        )}

        {step === "sent" && (
          <KarelCard variant="elevated" padding="lg" className="text-center">
            <CheckCircle className="w-12 h-12 text-teal-600 dark:text-teal-400 mx-auto mb-4" />
            <h2 className="text-lg font-semibold text-[hsl(var(--text-primary))]">Odkaz odeslán</h2>
            <p className="text-sm text-[hsl(var(--text-secondary))] mt-2">
              Zkontroluj svůj e-mail <strong>{email}</strong> a klikni na odkaz.
              <br />Platí 15 minut.
            </p>
            <KarelButton variant="ghost" className="mt-4" onClick={() => { setStep("email"); setEmail(""); }}>
              Zadat jiný e-mail
            </KarelButton>
          </KarelCard>
        )}

        {step === "verifying" && (
          <KarelCard variant="elevated" padding="lg" className="text-center">
            <Loader2 className="w-12 h-12 text-teal-600 dark:text-teal-400 mx-auto animate-spin mb-4" />
            <p className="text-sm text-[hsl(var(--text-secondary))]">Ověřuji odkaz…</p>
          </KarelCard>
        )}

        {step === "error" && (
          <KarelCard variant="elevated" padding="lg" className="text-center">
            <AlertCircle className="w-12 h-12 text-destructive mx-auto mb-4" />
            <h2 className="text-lg font-semibold text-[hsl(var(--text-primary))]">{errorMsg}</h2>
            <p className="text-sm text-[hsl(var(--text-secondary))] mt-2">Můžeš si nechat poslat nový odkaz.</p>
            <KarelButton variant="primary" className="mt-4" onClick={() => { setStep("email"); setErrorMsg(""); }}>
              Zkusit znovu
            </KarelButton>
          </KarelCard>
        )}

        <p className="text-center text-xs text-[hsl(var(--text-disabled))] mt-6">
          Hana Chlebcová · Psychoterapie
        </p>
      </div>
    </div>
  );
};

export default Zklidneni;

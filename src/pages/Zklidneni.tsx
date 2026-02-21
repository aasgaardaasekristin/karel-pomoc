import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Leaf, Mail, Loader2, CheckCircle, AlertCircle } from "lucide-react";
import ScenarioSelector, { type CalmScenario } from "@/components/calm/ScenarioSelector";
import CalmChat from "@/components/calm/CalmChat";

type Step = "email" | "sent" | "verifying" | "verified" | "error";

const Zklidneni = () => {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");

  const [step, setStep] = useState<Step>(token ? "verifying" : "email");
  const [email, setEmail] = useState("");
  const [verifiedEmail, setVerifiedEmail] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [scenario, setScenario] = useState<CalmScenario | null>(null);

  // Verify token on load
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

  // Verified user in calm mode
  if (step === "verified" && scenario) {
    return (
      <div className="min-h-screen flex flex-col bg-background">
        <header className="border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-10">
          <div className="max-w-2xl mx-auto px-4 py-4 flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => setScenario(null)} className="shrink-0">
              <Leaf className="w-4 h-4 text-primary" />
            </Button>
            <div>
              <h1 className="text-lg font-serif font-semibold text-foreground">Zklidnění</h1>
              <p className="text-xs text-muted-foreground">Bezpečný prostor pro tebe</p>
            </div>
          </div>
        </header>
        <CalmChat scenario={scenario} onEnd={handleEnd} />
      </div>
    );
  }

  if (step === "verified") {
    return (
      <div className="min-h-screen flex flex-col bg-background">
        <header className="border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-10">
          <div className="max-w-2xl mx-auto px-4 py-4 flex items-center gap-3">
            <Leaf className="w-4 h-4 text-primary" />
            <div>
              <h1 className="text-lg font-serif font-semibold text-foreground">Zklidnění</h1>
              <p className="text-xs text-muted-foreground">Vyber, co teď prožíváš</p>
            </div>
          </div>
        </header>
        <ScenarioSelector onSelect={setScenario} />
      </div>
    );
  }

  // Landing page states
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
            <Leaf className="w-8 h-8 text-primary" />
          </div>
          <h1 className="text-2xl font-serif font-semibold text-foreground mb-2">
            Chci si popovídat
          </h1>
          <p className="text-muted-foreground text-sm leading-relaxed">
            Bezpečný prostor, kde tě někdo vyslechne.<br />
            Nic se neukládá. Jsi tu anonymně.
          </p>
        </div>

        {step === "email" && (
          <div className="bg-card border border-border rounded-2xl p-6 space-y-4">
            <p className="text-sm text-muted-foreground text-center">
              Pro přístup zadej svůj e-mail. Pošleme ti jednorázový odkaz.
            </p>
            <form onSubmit={handleSendLink} className="space-y-4">
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
                <Input
                  type="email"
                  placeholder="Tvůj e-mail"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="pl-10 h-12 text-base"
                  autoFocus
                  required
                />
              </div>
              {errorMsg && (
                <p className="text-sm text-destructive flex items-center gap-1">
                  <AlertCircle className="w-4 h-4" /> {errorMsg}
                </p>
              )}
              <Button
                type="submit"
                className="w-full h-12 text-base"
                disabled={isLoading || !email.trim()}
              >
                {isLoading ? (
                  <><Loader2 className="w-4 h-4 animate-spin mr-2" /> Odesílám...</>
                ) : (
                  "Poslat odkaz"
                )}
              </Button>
            </form>
            <p className="text-xs text-muted-foreground text-center">
              E-mail slouží pouze k ověření. Žádný účet se nevytváří.
            </p>
          </div>
        )}

        {step === "sent" && (
          <div className="bg-card border border-border rounded-2xl p-8 text-center space-y-4">
            <CheckCircle className="w-12 h-12 text-primary mx-auto" />
            <h2 className="text-lg font-serif font-semibold text-foreground">
              Odkaz odeslán
            </h2>
            <p className="text-sm text-muted-foreground">
              Zkontroluj svůj e-mail <strong>{email}</strong> a klikni na odkaz.
              <br />Platí 15 minut.
            </p>
            <Button variant="ghost" onClick={() => { setStep("email"); setEmail(""); }}>
              Zadat jiný e-mail
            </Button>
          </div>
        )}

        {step === "verifying" && (
          <div className="bg-card border border-border rounded-2xl p-8 text-center space-y-4">
            <Loader2 className="w-12 h-12 text-primary mx-auto animate-spin" />
            <p className="text-sm text-muted-foreground">Ověřuji odkaz...</p>
          </div>
        )}

        {step === "error" && (
          <div className="bg-card border border-border rounded-2xl p-8 text-center space-y-4">
            <AlertCircle className="w-12 h-12 text-destructive mx-auto" />
            <h2 className="text-lg font-serif font-semibold text-foreground">
              {errorMsg}
            </h2>
            <p className="text-sm text-muted-foreground">
              Můžeš si nechat poslat nový odkaz.
            </p>
            <Button onClick={() => { setStep("email"); setErrorMsg(""); }}>
              Zkusit znovu
            </Button>
          </div>
        )}

        <p className="text-center text-xs text-muted-foreground mt-6">
          Hana Chlebcová · Psychoterapie
        </p>
      </div>
    </div>
  );
};

export default Zklidneni;

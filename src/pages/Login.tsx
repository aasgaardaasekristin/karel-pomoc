import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import ThemeQuickButton from "@/components/ThemeQuickButton";
import { useTheme } from "@/contexts/ThemeContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Lock, Heart, Leaf, Mail } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import KarelWelcomeIntro from "@/components/KarelWelcomeIntro";

const THEME_STORAGE_KEY = "theme_login";

const Login = () => {
  const { applyTemporaryTheme, restoreGlobalTheme, setLocalMode } = useTheme();

  useEffect(() => {
    setLocalMode(THEME_STORAGE_KEY);
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved) {
      try { applyTemporaryTheme(JSON.parse(saved)); } catch {}
    }
    return () => { setLocalMode(null); restoreGlobalTheme(); };
  }, []);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [showIntro, setShowIntro] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    const checkAuth = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (session) navigate("/hub");
    };
    checkAuth();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) {
        // Show welcome intro instead of immediate redirect
        setShowIntro(true);
      }
    });
    return () => subscription.unsubscribe();
  }, [navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Neznámá chyba";
      toast.error(msg === "Invalid login credentials" ? "Nesprávný e-mail nebo heslo." : msg);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <>
      {showIntro && <KarelWelcomeIntro onComplete={() => navigate("/hub")} />}
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md">
        <div className="mb-4 flex justify-end">
          <ThemeQuickButton storageKey={THEME_STORAGE_KEY} />
        </div>
        <div className="login-card text-center">
          <div className="mb-6 flex justify-center">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
              <Heart className="w-8 h-8 text-primary" />
            </div>
          </div>

          <h1 className="text-3xl font-serif font-semibold text-foreground mb-2">
            Karel
          </h1>
          <p className="text-muted-foreground mb-8">
            Supervizní mentor pro psychoterapeuty
          </p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
              <Input
                type="email"
                placeholder="E-mail"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="pl-10 h-12 text-base"
                autoFocus
                required
              />
            </div>

            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
              <Input
                type="password"
                placeholder="Heslo"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="pl-10 h-12 text-base"
                required
                minLength={6}
              />
            </div>

            <Button
              type="submit"
              className="w-full h-12 text-base font-medium"
              disabled={isLoading || !email || !password}
            >
              {isLoading ? "Ověřuji..." : "Vstoupit"}
            </Button>
          </form>

          <p className="mt-6 text-xs text-muted-foreground">
            Soukromá aplikace pro profesionální supervizi a péči
          </p>
        </div>

        <div className="mt-6 text-center">
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
  );
};

export default Login;

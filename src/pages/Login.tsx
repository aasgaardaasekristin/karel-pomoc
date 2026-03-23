import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import ThemeQuickButton from "@/components/ThemeQuickButton";
import { useTheme } from "@/contexts/ThemeContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Lock, Heart, Leaf, Mail } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

const Login = () => {
  const { setContextKey } = useTheme();
  useEffect(() => { setContextKey("login"); }, [setContextKey]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  // Registration disabled — private app for therapist only
  const navigate = useNavigate();

  // Redirect if already authenticated
  useEffect(() => {
    const checkAuth = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (session) navigate("/hub");
    };
    checkAuth();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) navigate("/hub");
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
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md">
        <div className="mb-4 flex justify-end">
          <ThemeQuickButton />
        </div>
        <div className="login-card text-center">
          {/* Logo / Icon */}
          <div className="mb-6 flex justify-center">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
              <Heart className="w-8 h-8 text-primary" />
            </div>
          </div>

          {/* Title */}
          <h1 className="text-3xl font-serif font-semibold text-foreground mb-2">
            Karel
          </h1>
          <p className="text-muted-foreground mb-8">
            Supervizní mentor pro psychoterapeuty
          </p>

          {/* Login Form */}
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

          {/* Registration removed — private app */}

          {/* Footer note */}
          <p className="mt-6 text-xs text-muted-foreground">
            Soukromá aplikace pro profesionální supervizi a péči
          </p>
        </div>

        {/* Calm Mode Entry - separate from login */}
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

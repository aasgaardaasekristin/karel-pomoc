import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Lock, Heart } from "lucide-react";

const Login = () => {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError("");

    // Simple password check - in production, this should be more secure
    // The password is "karel2024" - can be changed
    if (password === "karel2024") {
      sessionStorage.setItem("authenticated", "true");
      navigate("/chat");
    } else {
      setError("Nesprávné heslo. Zkus to znovu.");
    }
    setIsLoading(false);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md">
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
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
              <Input
                type="password"
                placeholder="Zadej heslo"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="pl-10 h-12 text-base"
                autoFocus
              />
            </div>

            {error && (
              <p className="text-destructive text-sm">{error}</p>
            )}

            <Button
              type="submit"
              className="w-full h-12 text-base font-medium"
              disabled={isLoading || !password}
            >
              {isLoading ? "Ověřuji..." : "Vstoupit"}
            </Button>
          </form>

          {/* Footer note */}
          <p className="mt-8 text-xs text-muted-foreground">
            Soukromá aplikace pro profesionální supervizi
          </p>
        </div>
      </div>
    </div>
  );
};

export default Login;

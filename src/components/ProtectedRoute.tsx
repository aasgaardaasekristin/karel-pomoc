import { useState, useEffect } from "react";
import { Navigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Loader2 } from "lucide-react";
import { isExplicitLogoutActive } from "@/lib/chatHelpers";

const AUTH_REDIRECT_DELAY_MS = 1200;

const hasActiveStoredWork = () => {
  try {
    return (
      localStorage.getItem("karel_active_mode") === "childcare" ||
      localStorage.getItem("karel_did_submode") !== null ||
      localStorage.getItem("karel_did_session_id") !== null ||
      sessionStorage.getItem("karel_hub_section") === "did" ||
      sessionStorage.getItem("karel_open_deliberation_id") !== null ||
      sessionStorage.getItem("karel_meeting_seed") !== null
    );
  } catch {
    return false;
  }
};

interface ProtectedRouteProps {
  children: React.ReactNode;
}

const ProtectedRoute = ({ children }: ProtectedRouteProps) => {
  const [status, setStatus] = useState<"loading" | "authenticated" | "unauthenticated">("loading");

  useEffect(() => {
    let mounted = true;
    let redirectTimer: number | null = null;
    if (isExplicitLogoutActive()) {
      setStatus("unauthenticated");
      return;
    }

    const clearRedirectTimer = () => {
      if (redirectTimer !== null) {
        window.clearTimeout(redirectTimer);
        redirectTimer = null;
      }
    };

    const scheduleUnauthenticated = () => {
      clearRedirectTimer();
      redirectTimer = window.setTimeout(async () => {
        const { data: { session } } = await supabase.auth.getSession();
        if (!mounted) return;
        setStatus(session && !isExplicitLogoutActive() ? "authenticated" : "unauthenticated");
      }, AUTH_REDIRECT_DELAY_MS);
    };

    const check = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!mounted) return;
      if (isExplicitLogoutActive()) {
        clearRedirectTimer();
        setStatus("unauthenticated");
        return;
      }
      if (session) {
        clearRedirectTimer();
        setStatus("authenticated");
        return;
      }
      if (hasActiveStoredWork()) {
        setStatus("loading");
        scheduleUnauthenticated();
        return;
      }
      scheduleUnauthenticated();
    };
    check();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return;
      if (isExplicitLogoutActive()) {
        clearRedirectTimer();
        setStatus("unauthenticated");
        return;
      }
      if (session) {
        clearRedirectTimer();
        setStatus("authenticated");
        return;
      }
      if (hasActiveStoredWork()) {
        setStatus("loading");
        return;
      }
      scheduleUnauthenticated();
    });

    return () => {
      mounted = false;
      clearRedirectTimer();
      subscription.unsubscribe();
    };
  }, []);

  if (status === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (status === "unauthenticated") {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
};

export default ProtectedRoute;

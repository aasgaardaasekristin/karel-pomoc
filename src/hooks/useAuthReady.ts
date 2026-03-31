import { useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

const AUTH_READY_MAX_RETRIES = 3;
const AUTH_READY_RETRY_DELAY_MS = 500;

export const useAuthReady = () => {
  const [session, setSession] = useState<Session | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [authEventCount, setAuthEventCount] = useState(0);
  const retryTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    let isMounted = true;

    const clearRetry = () => {
      if (retryTimeoutRef.current !== null) {
        window.clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }
    };

    const resolveSession = async (attempt = 0) => {
      const { data, error } = await supabase.auth.getSession();
      if (!isMounted) return;

      if (error) {
        console.warn("[useAuthReady] getSession error:", error);
      }

      if (data.session) {
        clearRetry();
        setSession(data.session);
        setIsAuthReady(true);
        return;
      }

      if (attempt < AUTH_READY_MAX_RETRIES - 1) {
        retryTimeoutRef.current = window.setTimeout(() => {
          void resolveSession(attempt + 1);
        }, AUTH_READY_RETRY_DELAY_MS);
        return;
      }

      clearRetry();
      setSession(null);
      setIsAuthReady(true);
    };

    void resolveSession();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, nextSession) => {
      clearRetry();

      if (event === "SIGNED_OUT") {
        setSession(null);
        setIsAuthReady(false);
        setAuthEventCount((count) => count + 1);
        return;
      }

      setSession(nextSession);
      setIsAuthReady(true);
      setAuthEventCount((count) => count + 1);
    });

    return () => {
      isMounted = false;
      clearRetry();
      subscription.unsubscribe();
    };
  }, []);

  return { session, isAuthReady, authEventCount };
};
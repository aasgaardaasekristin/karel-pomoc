import { supabase } from "@/integrations/supabase/client";

/**
 * Get authorization headers for edge function calls.
 * Uses the current Supabase session token if available,
 * falls back to the anon key.
 */
export async function getAuthHeaders(): Promise<Record<string, string>> {
  // Try refreshing session first to avoid expired tokens
  let { data: { session } } = await supabase.auth.getSession();
  if (session) {
    const expiresAt = session.expires_at ?? 0;
    const now = Math.floor(Date.now() / 1000);
    if (expiresAt - now < 60) {
      const { data } = await supabase.auth.refreshSession();
      session = data.session;
    }
  }
  const token = session?.access_token || import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

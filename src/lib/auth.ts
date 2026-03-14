import { supabase } from "@/integrations/supabase/client";

/**
 * Get authorization headers for backend function calls.
 * Requires an authenticated session and refreshes near expiry.
 */
export async function getAuthHeaders(): Promise<Record<string, string>> {
  let { data: { session } } = await supabase.auth.getSession();

  if (!session) {
    throw new Error("Přihlášení vypršelo. Přihlas se prosím znovu.");
  }

  const expiresAt = session.expires_at ?? 0;
  const now = Math.floor(Date.now() / 1000);
  if (expiresAt - now < 60) {
    const { data, error } = await supabase.auth.refreshSession();
    if (error || !data.session) {
      throw new Error("Přihlášení vypršelo. Přihlas se prosím znovu.");
    }
    session = data.session;
  }

  return {
    "Content-Type": "application/json",
    apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
    Authorization: `Bearer ${session.access_token}`,
  };
}

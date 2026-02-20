import { supabase } from "@/integrations/supabase/client";

/**
 * Get authorization headers for edge function calls.
 * Uses the current Supabase session token if available,
 * falls back to the anon key.
 */
export async function getAuthHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token || import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

import { supabase } from "@/integrations/supabase/client";

const FALLBACK_ERROR = "Akci se nepodařilo provést. Zkus to znovu nebo otevři detail krize.";

export async function callEdgeFunction(fnName: string, body: Record<string, unknown>) {
  const projectId = import.meta.env.VITE_SUPABASE_PROJECT_ID;
  const session = (await supabase.auth.getSession()).data.session;
  const res = await fetch(`https://${projectId}.supabase.co/functions/v1/${fnName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let payload: any = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(FALLBACK_ERROR);
    }
  }

  if (!res.ok || payload?.ok === false) {
    throw new Error(payload?.message || payload?.error || `HTTP ${res.status}`);
  }

  return payload;
}

export async function safeEdgeFunction(fnName: string, body: Record<string, unknown>) {
  try {
    return { ok: true as const, data: await callEdgeFunction(fnName, body), error: null };
  } catch (error) {
    return { ok: false as const, data: null, error: error instanceof Error ? error.message : FALLBACK_ERROR };
  }
}
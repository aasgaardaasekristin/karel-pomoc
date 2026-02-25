import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── OAuth2 token helper (uses Refresh Token) ──

async function getAccessToken(): Promise<string> {
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  const refreshToken = Deno.env.get("GOOGLE_REFRESH_TOKEN");

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Missing GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, or GOOGLE_REFRESH_TOKEN");
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  const data = await res.json();
  if (!data.access_token) throw new Error(`Token error: ${JSON.stringify(data)}`);
  return data.access_token;
}

// ── Drive helpers ──

async function findFolder(token: string, name: string, parentId?: string): Promise<string | null> {
  let q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  if (parentId) q += ` and '${parentId}' in parents`;
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  return data.files?.[0]?.id || null;
}

async function createFolder(token: string, name: string, parentId?: string): Promise<string> {
  const metadata: any = {
    name,
    mimeType: "application/vnd.google-apps.folder",
  };
  if (parentId) metadata.parents = [parentId];

  const res = await fetch("https://www.googleapis.com/drive/v3/files", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(metadata),
  });
  const data = await res.json();
  if (!data.id) throw new Error(`Failed to create folder ${name}: ${JSON.stringify(data)}`);
  return data.id;
}

async function findFile(token: string, name: string, parentId: string): Promise<string | null> {
  const q = `name='${name}' and '${parentId}' in parents and trashed=false`;
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  return data.files?.[0]?.id || null;
}

async function uploadOrUpdate(token: string, fileName: string, content: string, folderId: string) {
  const existingId = await findFile(token, fileName, folderId);
  const boundary = "----BackupBoundary";
  const metadata = JSON.stringify(
    existingId
      ? { name: fileName }
      : { name: fileName, parents: [folderId] }
  );

  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n` +
    `--${boundary}--`;

  const url = existingId
    ? `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=multipart`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;

  const res = await fetch(url, {
    method: existingId ? "PATCH" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Drive upload failed for ${fileName}: ${err}`);
  }
  return await res.json();
}

// ── Main ──

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Auth: support both user token (manual) and service role (cron)
    const authHeader = req.headers.get("Authorization");
    
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    if (authHeader && !authHeader.includes(Deno.env.get("SUPABASE_ANON_KEY")!)) {
      const userClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        { global: { headers: { Authorization: authHeader } } }
      );
      const { data: { user }, error: authErr } = await userClient.auth.getUser();
      if (authErr || !user) throw new Error("Unauthorized");
    }

    // Load ALL clients data (service role bypasses RLS)
    const [clientsRes, sessionsRes, tasksRes] = await Promise.all([
      supabase.from("clients").select("*").order("name"),
      supabase.from("client_sessions").select("*").order("session_date", { ascending: false }),
      supabase.from("client_tasks").select("*").order("created_at", { ascending: false }),
    ]);

    const clients = clientsRes.data || [];
    const allSessions = sessionsRes.data || [];
    const allTasks = tasksRes.data || [];

    // Google OAuth2 auth
    const token = await getAccessToken();

    // Find or create KARTOTEKA folder
    let kartotekaId = await findFolder(token, "KARTOTEKA");
    if (!kartotekaId) {
      kartotekaId = await createFolder(token, "KARTOTEKA");
    }

    // ── Format helpers ──
    const fmtDate = (d: string | null) => {
      if (!d) return null;
      try {
        const dt = new Date(d);
        return dt.toLocaleDateString("cs-CZ", { day: "2-digit", month: "2-digit", year: "numeric" });
      } catch { return d; }
    };
    const fmtDateTime = (d: string | null) => {
      if (!d) return null;
      try {
        const dt = new Date(d);
        return `${dt.toLocaleDateString("cs-CZ")} ${dt.toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" })}`;
      } catch { return d; }
    };
    const clean = (v: any) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0) ? undefined : v;

    const EMOTION_MAP: Record<string, string> = {
      calm: "Klid", sadness: "Smutek", helplessness: "Bezmoc",
      anger: "Vztek", fear: "Strach", uncertainty: "Nejistota",
    };
    const RISK_MAP: Record<string, string> = {
      selfharm: "Sebepoškozování", violence: "Násilí", threats: "Hrozby",
      abuse: "Zneužívání", boundaries: "Hranice", none: "Žádné",
    };
    const THEME_MAP: Record<string, string> = {
      trauma: "Trauma", relationships: "Vztahy", anxiety: "Úzkost",
      depression: "Deprese", "child-family": "Dítě & rodina", addiction: "Závislosti", other: "Jiné",
    };

    // Upload one JSON file per client
    let uploaded = 0;
    for (const client of clients) {
      const clientSessions = allSessions.filter((s: any) => s.client_id === client.id);
      const clientTasks = allTasks.filter((t: any) => t.client_id === client.id);

      const formatSession = (s: any) => {
        const result: any = {
          cislo_sezeni: s.session_number,
          datum: fmtDate(s.session_date),
        };
        if (clean(s.report_context)) result.kontext = s.report_context;
        if (clean(s.report_key_theme)) result.klicove_tema = THEME_MAP[s.report_key_theme] || s.report_key_theme;
        if (clean(s.report_therapist_emotions)) result.emoce_terapeuta = s.report_therapist_emotions.map((e: string) => EMOTION_MAP[e] || e);
        if (clean(s.report_transference)) result.prenos_protiprenos = s.report_transference;
        if (clean(s.report_risks)) result.rizika = s.report_risks.map((r: string) => RISK_MAP[r] || r);
        if (clean(s.report_missing_data)) result.co_overit = s.report_missing_data;
        if (clean(s.report_interventions_tried)) result.intervence = s.report_interventions_tried;
        if (clean(s.report_next_session_goal)) result.cil_dalsiho_sezeni = s.report_next_session_goal;
        if (clean(s.ai_analysis)) result.ai_analyza = s.ai_analysis;
        if (clean(s.ai_hypotheses)) result.supervize_chat = s.ai_hypotheses;
        if (clean(s.notes)) result.poznamky = s.notes;
        return result;
      };

      const formatTask = (t: any) => {
        const result: any = {
          ukol: t.task,
          stav: t.status === "planned" ? "Plánováno" : t.status === "done" ? "Hotovo" : t.status,
        };
        if (clean(t.method)) result.metoda = t.method;
        if (clean(t.due_date)) result.termin = fmtDate(t.due_date);
        if (clean(t.notes)) result.poznamky = t.notes;
        if (clean(t.result)) result.vysledek = t.result;
        return result;
      };

      const payload: any = {
        zaloha_datum: fmtDateTime(new Date().toISOString()),
        klient: {
          jmeno: client.name,
          ...(clean(client.age) && { vek: client.age }),
          ...(clean(client.gender) && { pohlavi: client.gender }),
          ...(clean(client.diagnosis) && { diagnoza: client.diagnosis }),
          ...(clean(client.therapy_type) && { typ_terapie: client.therapy_type }),
          ...(clean(client.referral_source) && { zdroj_doporuceni: client.referral_source }),
          ...(clean(client.key_history) && { klicova_anamneza: client.key_history }),
          ...(clean(client.family_context) && { rodinny_kontext: client.family_context }),
          ...(clean(client.notes) && { poznamky: client.notes }),
        },
      };

      if (clientSessions.length > 0) {
        payload.sezeni = clientSessions.map(formatSession);
      }
      if (clientTasks.length > 0) {
        payload.ukoly = clientTasks.map(formatTask);
      }

      const safeName = client.name.replace(/[^a-zA-Z0-9áčďéěíňóřšťúůýžÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ _-]/g, "_");
      const fileName = `${safeName}.json`;
      await uploadOrUpdate(token, fileName, JSON.stringify(payload, null, 2), kartotekaId);
      uploaded++;
    }

    return new Response(JSON.stringify({
      success: true,
      message: `✅ Zálohováno ${uploaded} klientů do složky KARTOTEKA.`,
      clients_count: uploaded,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

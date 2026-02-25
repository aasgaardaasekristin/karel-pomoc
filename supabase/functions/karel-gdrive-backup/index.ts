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

async function uploadOrUpdate(token: string, fileName: string, content: string, folderId: string, mimeType = "text/plain") {
  const existingId = await findFile(token, fileName, folderId);
  const boundary = "----BackupBoundary";
  const metadata = JSON.stringify(
    existingId
      ? { name: fileName }
      : { name: fileName, parents: [folderId] }
  );

  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
    `--${boundary}\r\nContent-Type: ${mimeType}; charset=UTF-8\r\n\r\n${content}\r\n` +
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
      if (!d) return "";
      try {
        const dt = new Date(d);
        return dt.toLocaleDateString("cs-CZ", { day: "2-digit", month: "2-digit", year: "numeric" });
      } catch { return d; }
    };
    const fmtDateTime = (d: string | null) => {
      if (!d) return "";
      try {
        const dt = new Date(d);
        return `${dt.toLocaleDateString("cs-CZ")} ${dt.toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" })}`;
      } catch { return d; }
    };
    const has = (v: any) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0);
    const line = (label: string, value: any) => has(value) ? `${label}: ${value}\n` : "";
    const divider = "═".repeat(60);
    const thinDivider = "─".repeat(60);

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

    // Strip markdown comment markers <!-- ... -->
    const stripComments = (text: string) => text.replace(/<!--[^>]*-->/g, "").trim();

    // Build one text document per client
    let uploaded = 0;
    for (const client of clients) {
      const clientSessions = allSessions
        .filter((s: any) => s.client_id === client.id)
        .sort((a: any, b: any) => (a.session_number || 0) - (b.session_number || 0));
      const clientTasks = allTasks.filter((t: any) => t.client_id === client.id);

      let doc = "";

      // ═══ HEADER 1: KARTA KLIENTA ═══
      doc += `${divider}\n`;
      doc += `  KARTA KLIENTA: ${client.name}\n`;
      doc += `${divider}\n\n`;
      doc += line("Jméno", client.name);
      doc += line("Věk", client.age);
      doc += line("Pohlaví", client.gender);
      doc += line("Diagnóza", client.diagnosis);
      doc += line("Typ terapie", client.therapy_type);
      doc += line("Zdroj doporučení", client.referral_source);
      doc += line("Klíčová anamnéza", client.key_history);
      doc += line("Rodinný kontext", client.family_context);
      doc += line("Poznámky", client.notes);
      doc += `\nZáloha vytvořena: ${fmtDateTime(new Date().toISOString())}\n`;

      // ═══ HEADER 2+: SEZENÍ ═══
      for (const s of clientSessions) {
        doc += `\n\n${divider}\n`;
        doc += `  SEZENÍ č. ${s.session_number || "?"}\n`;
        doc += `  Datum: ${fmtDate(s.session_date)}\n`;
        doc += `${divider}\n\n`;

        // Report fields
        if (has(s.report_context)) {
          doc += `KONTEXT:\n${s.report_context}\n\n`;
        }
        if (has(s.report_key_theme)) {
          doc += `KLÍČOVÉ TÉMA: ${THEME_MAP[s.report_key_theme] || s.report_key_theme}\n\n`;
        }
        if (has(s.report_therapist_emotions)) {
          const emotions = s.report_therapist_emotions.map((e: string) => EMOTION_MAP[e] || e).join(", ");
          doc += `EMOCE TERAPEUTA: ${emotions}\n\n`;
        }
        if (has(s.report_transference)) {
          doc += `PŘENOS / PROTIPŘENOS:\n${s.report_transference}\n\n`;
        }
        if (has(s.report_risks)) {
          const risks = s.report_risks.map((r: string) => RISK_MAP[r] || r).join(", ");
          doc += `RIZIKA: ${risks}\n\n`;
        }
        if (has(s.report_missing_data)) {
          doc += `CO OVĚŘIT:\n${s.report_missing_data}\n\n`;
        }
        if (has(s.report_interventions_tried)) {
          doc += `POUŽITÉ INTERVENCE:\n${s.report_interventions_tried}\n\n`;
        }
        if (has(s.report_next_session_goal)) {
          doc += `CÍL DALŠÍHO SEZENÍ:\n${s.report_next_session_goal}\n\n`;
        }

        // AI content
        if (has(s.ai_analysis)) {
          doc += `${thinDivider}\n`;
          doc += `KOMPLEXNÍ ANALÝZA (Karel AI)\n`;
          doc += `${thinDivider}\n\n`;
          doc += `${stripComments(s.ai_analysis)}\n\n`;
        }

        if (has(s.ai_hypotheses)) {
          doc += `${thinDivider}\n`;
          doc += `PRŮBĚH SUPERVIZE (Chat)\n`;
          doc += `${thinDivider}\n\n`;
          doc += `${stripComments(s.ai_hypotheses)}\n\n`;
        }

        if (has(s.ai_recommended_methods)) {
          doc += `DOPORUČENÉ METODY:\n${s.ai_recommended_methods}\n\n`;
        }
        if (has(s.ai_risk_assessment)) {
          doc += `HODNOCENÍ RIZIK:\n${s.ai_risk_assessment}\n\n`;
        }
        if (has(s.voice_analysis)) {
          doc += `HLASOVÁ ANALÝZA:\n${s.voice_analysis}\n\n`;
        }
        if (has(s.notes)) {
          doc += `POZNÁMKY:\n${s.notes}\n\n`;
        }

        // Tasks for this session (filtered by creation around session date)
        const sessionTasks = clientTasks.filter((t: any) => {
          // Show all tasks – they'll appear at end of last session
          return true;
        });

        // We'll add tasks after all sessions instead
      }

      // ═══ ÚKOLY ═══
      if (clientTasks.length > 0) {
        doc += `\n\n${divider}\n`;
        doc += `  *** ÚKOLY ***\n`;
        doc += `${divider}\n\n`;
        for (const t of clientTasks) {
          const status = t.status === "planned" ? "⬜ Plánováno" : t.status === "done" ? "✅ Hotovo" : t.status;
          doc += `► ${t.task}  [${status}]\n`;
          if (has(t.method)) doc += `  Metoda: ${t.method}\n`;
          if (has(t.due_date)) doc += `  Termín: ${fmtDate(t.due_date)}\n`;
          if (has(t.notes)) doc += `  Poznámky: ${t.notes}\n`;
          if (has(t.result)) doc += `  Výsledek: ${t.result}\n`;
          doc += `\n`;
        }
      }

      const safeName = client.name.replace(/[^a-zA-Z0-9áčďéěíňóřšťúůýžÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ _-]/g, "_");
      const fileName = `${safeName}.txt`;
      await uploadOrUpdate(token, fileName, doc, kartotekaId, "text/plain");
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

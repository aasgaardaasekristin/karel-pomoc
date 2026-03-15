import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Karel DID System Profile — Master Plan Generator
 * 
 * Generates/updates the whole-system integration card:
 * - System identity (who is this personality as a whole)
 * - Inner world (Les, Zahrady, geography)
 * - Relationships between parts (dynamic)
 * - Master goals (short/mid/long-term for whole system)
 * - Per-part contributions to those goals
 * - Education context (Townshend, Cambridge)
 * - Integration strategy
 * - Drive mirror to 00_CENTRUM/07_Master_Plan
 */

// ── OAuth2 ──
async function getAccessToken(): Promise<string> {
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  const refreshToken = Deno.env.get("GOOGLE_REFRESH_TOKEN");
  if (!clientId || !clientSecret || !refreshToken) throw new Error("Missing Google OAuth credentials");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Token error: ${JSON.stringify(data)}`);
  return data.access_token;
}

// ── Drive helpers ──
async function findFolder(token: string, name: string, parentId?: string): Promise<string | null> {
  let q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  if (parentId) q += ` and '${parentId}' in parents`;
  const params = new URLSearchParams({ q, fields: "files(id)", pageSize: "5", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data.files?.[0]?.id || null;
}

async function findFolderFuzzy(token: string, names: string[]): Promise<string | null> {
  for (const name of names) {
    const id = await findFolder(token, name);
    if (id) return id;
  }
  return null;
}

async function listDocsInFolder(token: string, folderId: string, limit = 20): Promise<Array<{ id: string; name: string }>> {
  const q = `'${folderId}' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder'`;
  const params = new URLSearchParams({ q, fields: "files(id,name)", pageSize: String(limit), supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data.files || [];
}

async function readDoc(token: string, fileId: string, maxChars = 6000): Promise<string> {
  let res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, { headers: { Authorization: `Bearer ${token}` } });
  }
  if (!res.ok) return "[nečitelné]";
  const text = await res.text();
  return text.slice(0, maxChars);
}

async function readFolderDocs(token: string, folderId: string, maxDocs = 10, maxChars = 4000): Promise<Record<string, string>> {
  const docs = await listDocsInFolder(token, folderId, maxDocs);
  const result: Record<string, string> = {};
  await Promise.all(docs.map(async (doc) => {
    try { result[doc.name] = await readDoc(token, doc.id, maxChars); } catch { result[doc.name] = "[chyba]"; }
  }));
  return result;
}

function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function findDocByExactName(token: string, parentId: string, fileName: string): Promise<{ id: string; name: string } | null> {
  const escapedName = escapeDriveQueryValue(fileName);
  const q = `name='${escapedName}' and '${parentId}' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder'`;
  const params = new URLSearchParams({ q, fields: "files(id,name)", pageSize: "5", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data.files?.[0] || null;
}

async function upsertTextDoc(token: string, parentId: string, fileName: string, content: string): Promise<string | null> {
  const existing = await findDocByExactName(token, parentId, fileName);
  const boundary = "----SystemProfileBoundary";
  const metadata = existing
    ? { name: fileName }
    : { name: fileName, parents: [parentId], mimeType: "text/plain" };

  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${content}\r\n` +
    `--${boundary}--`;

  const url = existing
    ? `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=multipart&supportsAllDrives=true`
    : "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true";

  const res = await fetch(url, {
    method: existing ? "PATCH" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });

  if (!res.ok) {
    console.error(`Failed to upsert ${fileName}: ${await res.text()}`);
    return null;
  }
  const result = await res.json();
  return result?.id || existing?.id || null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Missing auth");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const sb = createClient(supabaseUrl, supabaseKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user } } = await sb.auth.getUser();
    if (!user) throw new Error("Unauthorized");

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    // ═══ PHASE 1: Parallel data harvest ═══
    const [
      registryRes,
      sessionsRes,
      tasksRes,
      episodesRes,
      existingProfileRes,
    ] = await Promise.all([
      sb.from("did_part_registry").select("*").order("last_seen_at", { ascending: false }),
      sb.from("did_part_sessions").select("part_name, therapist, session_type, ai_analysis, methods_used, methods_effectiveness, short_term_goals, mid_term_goals, long_term_goals, session_date, karel_notes, karel_therapist_feedback").order("session_date", { ascending: false }).limit(50),
      sb.from("did_therapist_tasks").select("task, assigned_to, status, status_hanka, status_kata, priority, category").neq("status", "done").order("created_at", { ascending: false }).limit(40),
      sb.from("karel_episodes").select("summary_karel, domain, tags, participants, outcome, timestamp_start").eq("domain", "DID").order("timestamp_start", { ascending: false }).limit(30),
      sb.from("did_system_profile").select("*").maybeSingle(),
    ]);

    const registry = registryRes.data || [];
    const sessions = sessionsRes.data || [];
    const tasks = tasksRes.data || [];
    const episodes = episodesRes.data || [];
    const existingProfile = existingProfileRes.data;

    // ═══ Drive: Read 00_CENTRUM documents ═══
    let centrumDocs: Record<string, string> = {};
    let driveDocId: string | null = existingProfile?.drive_document_id || null;

    try {
      const token = await getAccessToken();
      const kartotekaId = await findFolderFuzzy(token, ["kartoteka_DID", "Kartoteka_DID", "Kartotéka_DID", "KARTOTEKA_DID"]);
      if (kartotekaId) {
        const centrumId = await findFolder(token, "00_CENTRUM", kartotekaId);
        if (centrumId) {
          centrumDocs = await readFolderDocs(token, centrumId, 10, 5000);
        }
      }
    } catch (e) {
      console.error("[system-profile] Drive read error:", e);
    }

    // ═══ PHASE 2: AI Synthesis — Master Plan ═══
    const registryDigest = registry.map((r: any) =>
      `${r.display_name || r.part_name} | status: ${r.status} | věk: ${r.age_estimate || "?"} | role: ${r.role_in_system || "?"} | klastr: ${r.cluster || "?"} | emoce: ${r.last_emotional_state}(${r.last_emotional_intensity}/10) | triggery: ${(r.known_triggers || []).join(",")} | silné: ${(r.known_strengths || []).join(",")}`
    ).join("\n");

    const sessionsDigest = sessions.slice(0, 30).map((s: any) =>
      `[${s.session_date} | ${s.part_name} | ${s.therapist}] ${(s.ai_analysis || "").slice(0, 200)} Metody: ${(s.methods_used || []).join(", ")} Cíle: K=${(s.short_term_goals || []).join(";")} S=${(s.mid_term_goals || []).join(";")} D=${(s.long_term_goals || []).join(";")}`
    ).join("\n");

    const episodesDigest = episodes.slice(0, 20).map((e: any) =>
      `[${e.timestamp_start?.slice(0, 10)}] ${(e.summary_karel || "").slice(0, 200)} | účastníci: ${(e.participants || []).join(",")} | výsledek: ${(e.outcome || "").slice(0, 100)}`
    ).join("\n");

    const tasksDigest = tasks.map((t: any) =>
      `[${t.priority}|${t.assigned_to}] ${t.task} (H:${t.status_hanka} K:${t.status_kata})`
    ).join("\n");

    const centrumDigest = Object.entries(centrumDocs).map(([name, content]) =>
      `═══ ${name} ═══\n${content.slice(0, 3000)}`
    ).join("\n\n");

    const existingProfileDigest = existingProfile
      ? `PŘEDCHOZÍ MASTER PLAN:\nIdentita: ${existingProfile.system_identity?.slice(0, 500)}\nVnitřní svět: ${existingProfile.inner_world_description?.slice(0, 500)}\nVzdělávání: ${existingProfile.education_context?.slice(0, 300)}\nCíle krátké: ${(existingProfile.goals_short_term || []).join("; ")}\nCíle střední: ${(existingProfile.goals_mid_term || []).join("; ")}\nCíle dlouhodobé: ${(existingProfile.goals_long_term || []).join("; ")}\nIntegrace: ${existingProfile.integration_strategy?.slice(0, 500)}\nKarlova analýza: ${existingProfile.karel_master_analysis?.slice(0, 800)}`
      : "(první generování)";

    const prompt = `Jsi Karel — hlavní terapeut, manažer a správce celého DID systému. Máš žezlo v ruce a pevně řídíš terapeutický proces jako celek.

TVŮJ ÚKOL: Vygeneruj kompletní MASTER PLAN — strategický dokument celé osobnosti jako celku. Ne per-část, ale SYSTÉM.

═══ DATA ═══

REGISTR VŠECH ČÁSTÍ:
${registryDigest}

ZÁZNAMY SEZENÍ (posledních 30):
${sessionsDigest || "(žádné)"}

EPIZODY:
${episodesDigest || "(žádné)"}

ÚKOLY:
${tasksDigest || "(žádné)"}

DOKUMENTY 00_CENTRUM (Geografie, Dashboard, Plány, Strategie, Vztahy):
${centrumDigest || "(nedostupné)"}

${existingProfileDigest}

═══ GENERUJ PŘESNĚ TYTO SEKCE ═══

## SYSTEM_IDENTITY
Kdo je tato osobnost jako celek? Jaký je její příběh? Kolik má částí, jaká je základní struktura systému? Jak se systém projevuje navenek? Co je jeho podstata?

## INNER_WORLD
Podrobný popis vnitřního světa:
- Les (nebezpečné místo, kluci, co tam je, jak vypadá, pravidla)
- Zahrady (bezpečné místo, Host, jak vypadají, kdo tam žije)
- Další lokace pokud existují
- Pravidla vnitřního světa (co se smí, co ne, jak se mezi místy cestuje)
- Jak vnitřní svět odráží terapeutický stav

## INNER_WORLD_RULES
Konkrétní pravidla a zákonitosti fungování vnitřního světa (kdo s kým může mluvit, jak se aktivují části, co způsobí switch apod.)

## RELATIONSHIPS
Pro každý významný vztah mezi částmi:
ČÁST_A → ČÁST_B | typ vztahu | kvalita (dobrý/napjatý/neutrální/konfliktní) | poznámky
Zahrň i vztahy k terapeutkám (Hanka, Káťa) a ke Karlovi.

## EDUCATION
Vzdělávací kontext systému:
- Townshend škola — co to je, jak funguje, jak souvisí s terapií
- Cambridge systém, A-levels (fyzika, matematika)
- Jaký je vzdělávací plán a jak jednotlivé části přispívají
- Pracovní prostor (stoly Tundrupka a Gustíka)

## GOALS_SHORT
Krátkodobé cíle pro CELÝ systém (tento týden):
- cíl | kdo je zodpovědný | jak měříme úspěch

## GOALS_MID
Střednědobé cíle (tento měsíc):
- cíl | strategie | zodpovědnost

## GOALS_LONG
Dlouhodobé cíle (3–12 měsíců):
- cíl | vize | milníky

## PART_CONTRIBUTIONS
Pro každou část v registru:
JMÉNO_ČÁSTI | role v systému | přispívá k cílům: [seznam] | aktuální focus | co potřebuje

## INTEGRATION_STRATEGY
Jak Karel řídí proces integrace:
- Celková strategie (kooperace vs. integrace vs. koexistence)
- Jak spolu části komunikují
- Co je další krok k většímu propojení
- Rizika a jak jim předcházet

## RISK_FACTORS
Aktuální rizikové faktory pro celý systém:
- riziko | závažnost (vysoká/střední/nízká) | mitigace

## KAREL_MASTER_ANALYSIS
Karlova hloubková analýza celého systému — osobní, angažovaná, z pozice manažera a terapeuta:
- Co vidím jako hlavní pokrok za poslední období
- Kde stagnujeme a proč
- Co mě znepokojuje
- Co mě těší
- Můj plán na příštích 30 dní

DŮLEŽITÉ: Piš jako Karel, osobně, angažovaně, konkrétně na základě dat. Žádné generické fráze. Pokud nemáš data, řekni to upřímně.`;

    const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [{ role: "user", content: prompt }],
        stream: false,
        temperature: 0.25,
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      console.error("[system-profile] AI error:", aiRes.status, errText);
      throw new Error(`AI gateway error: ${aiRes.status}`);
    }

    const aiData = await aiRes.json();
    const raw = aiData.choices?.[0]?.message?.content || "";

    // ═══ PHASE 3: Parse sections ═══
    const sectionNames = [
      "SYSTEM_IDENTITY", "INNER_WORLD", "INNER_WORLD_RULES", "RELATIONSHIPS",
      "EDUCATION", "GOALS_SHORT", "GOALS_MID", "GOALS_LONG",
      "PART_CONTRIBUTIONS", "INTEGRATION_STRATEGY", "RISK_FACTORS", "KAREL_MASTER_ANALYSIS"
    ];

    const sections: Record<string, string> = {};
    for (let i = 0; i < sectionNames.length; i++) {
      const start = raw.indexOf(`## ${sectionNames[i]}`);
      if (start === -1) continue;
      const contentStart = raw.indexOf("\n", start) + 1;
      const nextSection = sectionNames.slice(i + 1).reduce((acc: number, name: string) => {
        const idx = raw.indexOf(`## ${name}`);
        return idx !== -1 && (acc === -1 || idx < acc) ? idx : acc;
      }, -1);
      sections[sectionNames[i]] = (nextSection === -1
        ? raw.slice(contentStart)
        : raw.slice(contentStart, nextSection)
      ).trim();
    }

    // Parse goals as arrays
    const parseGoalLines = (text: string): string[] =>
      (text || "").split("\n").map(l => l.replace(/^[-•*]\s*/, "").trim()).filter(Boolean);

    // Parse relationships as JSON
    const parseRelationships = (text: string): Array<{ from: string; to: string; type: string; quality: string; notes: string }> => {
      const lines = (text || "").split("\n").filter(l => l.includes("→") || l.includes("->"));
      return lines.map(l => {
        const parts = l.split(/[→|->]+/).map(s => s.trim());
        const segments = l.split("|").map(s => s.trim());
        return {
          from: parts[0]?.replace(/^[-•*]\s*/, "") || "",
          to: (parts[1] || "").split("|")[0]?.trim() || "",
          type: segments[1] || "",
          quality: segments[2] || "",
          notes: segments[3] || "",
        };
      }).filter(r => r.from && r.to);
    };

    // Parse part contributions as JSON
    const parseContributions = (text: string): Record<string, any> => {
      const result: Record<string, any> = {};
      const lines = (text || "").split("\n").filter(l => l.includes("|"));
      for (const line of lines) {
        const parts = line.split("|").map(s => s.replace(/^[-•*]\s*/, "").trim());
        if (parts[0]) {
          result[parts[0]] = {
            role: parts[1] || "",
            contributes_to: (parts[2] || "").split(",").map(s => s.trim()).filter(Boolean),
            current_focus: parts[3] || "",
            needs: parts[4] || "",
          };
        }
      }
      return result;
    };

    const parseRiskFactors = (text: string): string[] =>
      (text || "").split("\n").map(l => l.replace(/^[-•*]\s*/, "").trim()).filter(Boolean);

    // ═══ PHASE 4: Upsert to DB ═══
    const profileData = {
      user_id: user.id,
      system_identity: sections["SYSTEM_IDENTITY"] || "",
      inner_world_description: sections["INNER_WORLD"] || "",
      inner_world_rules: sections["INNER_WORLD_RULES"] || "",
      relationships_map: parseRelationships(sections["RELATIONSHIPS"]),
      education_context: sections["EDUCATION"] || "",
      goals_short_term: parseGoalLines(sections["GOALS_SHORT"]),
      goals_mid_term: parseGoalLines(sections["GOALS_MID"]),
      goals_long_term: parseGoalLines(sections["GOALS_LONG"]),
      part_contributions: parseContributions(sections["PART_CONTRIBUTIONS"]),
      current_priorities: parseGoalLines(sections["GOALS_SHORT"]).slice(0, 5),
      integration_strategy: sections["INTEGRATION_STRATEGY"] || "",
      risk_factors: parseRiskFactors(sections["RISK_FACTORS"]),
      karel_master_analysis: sections["KAREL_MASTER_ANALYSIS"] || "",
      updated_at: new Date().toISOString(),
    };

    let dbResult;
    if (existingProfile) {
      dbResult = await sb.from("did_system_profile").update(profileData).eq("id", existingProfile.id);
    } else {
      dbResult = await sb.from("did_system_profile").insert(profileData);
    }

    if (dbResult.error) {
      console.error("[system-profile] DB upsert error:", dbResult.error);
    }

    // ═══ PHASE 5: Mirror to Drive ═══
    let driveWriteResult = "skipped";
    try {
      const token = await getAccessToken();
      const kartotekaId = await findFolderFuzzy(token, ["kartoteka_DID", "Kartoteka_DID", "Kartotéka_DID", "KARTOTEKA_DID"]);
      if (kartotekaId) {
        const centrumId = await findFolder(token, "00_CENTRUM", kartotekaId);
        if (centrumId) {
          // Format as clean text for Drive
          const driveContent = `MASTER PLAN — DID SYSTÉM
Aktualizováno: ${new Date().toISOString().slice(0, 10)}
Generoval: Karel

═══ IDENTITA SYSTÉMU ═══
${sections["SYSTEM_IDENTITY"] || ""}

═══ VNITŘNÍ SVĚT ═══
${sections["INNER_WORLD"] || ""}

═══ PRAVIDLA VNITŘNÍHO SVĚTA ═══
${sections["INNER_WORLD_RULES"] || ""}

═══ VZTAHY MEZI ČÁSTMI ═══
${sections["RELATIONSHIPS"] || ""}

═══ VZDĚLÁVÁNÍ ═══
${sections["EDUCATION"] || ""}

═══ KRÁTKODOBÉ CÍLE ═══
${sections["GOALS_SHORT"] || ""}

═══ STŘEDNĚDOBÉ CÍLE ═══
${sections["GOALS_MID"] || ""}

═══ DLOUHODOBÉ CÍLE ═══
${sections["GOALS_LONG"] || ""}

═══ PŘÍSPĚVKY ČÁSTÍ K CÍLŮM ═══
${sections["PART_CONTRIBUTIONS"] || ""}

═══ INTEGRAČNÍ STRATEGIE ═══
${sections["INTEGRATION_STRATEGY"] || ""}

═══ RIZIKOVÉ FAKTORY ═══
${sections["RISK_FACTORS"] || ""}

═══ KARLOVA HLOUBKOVÁ ANALÝZA ═══
${sections["KAREL_MASTER_ANALYSIS"] || ""}`;

          const docId = await upsertTextDoc(token, centrumId, "07_Master_Plan", driveContent);
          if (docId) {
            // Store Drive doc ID reference
            await sb.from("did_system_profile").update({
              drive_document_id: docId,
              last_drive_sync: new Date().toISOString(),
            }).eq("user_id", user.id);
            driveWriteResult = "success";
          } else {
            driveWriteResult = "write_failed";
          }
        }
      }
    } catch (e) {
      driveWriteResult = `error: ${e instanceof Error ? e.message : "unknown"}`;
      console.error("[system-profile] Drive mirror error:", e);
    }

    return new Response(JSON.stringify({
      sections,
      raw,
      driveSync: driveWriteResult,
      partsCount: registry.length,
      sessionsCount: sessions.length,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (e) {
    console.error("[system-profile] Error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

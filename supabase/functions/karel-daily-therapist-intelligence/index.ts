import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { corsHeaders } from "../_shared/auth.ts";

/**
 * karel-daily-therapist-intelligence
 *
 * Lehká denní funkce generující akční inteligenci a dedukce pro Haničku a Káťu.
 * Zapisuje do PAMET_KAREL/DID/{HANKA,KATA}/{SITUACNI_ANALYZA,KARLOVY_POZNATKY}
 * ve stabilním formátu se značkami, které context-prime přesně extrahuje.
 *
 * Volá se z orchestrátoru po sorteru a queue processoru.
 */

const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY") || "";

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

function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function findDocByExactName(token: string, parentId: string, fileName: string): Promise<{ id: string; name: string } | null> {
  const q = `name='${escapeDriveQueryValue(fileName)}' and '${parentId}' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder'`;
  const params = new URLSearchParams({ q, fields: "files(id,name)", pageSize: "5", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data.files?.[0] || null;
}

async function readDoc(token: string, fileId: string, maxChars = 6000): Promise<string> {
  let res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, { headers: { Authorization: `Bearer ${token}` } });
  }
  if (!res.ok) return "";
  const text = await res.text();
  return text.slice(0, maxChars);
}

async function appendToFile(token: string, fileId: string, content: string): Promise<void> {
  // Read current content
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, { headers: { Authorization: `Bearer ${token}` } });
  const existing = res.ok ? await res.text() : "";

  const newContent = existing + "\n\n" + content;

  const boundary = "----TherapistIntelBoundary";
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: null })}\r\n` +
    `--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${newContent}\r\n` +
    `--${boundary}--`;

  await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart&supportsAllDrives=true`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
}

// ── Therapist config ──
interface TherapistConfig {
  key: "hanka" | "kata";
  name: string;
  relationship: string;
  subModes: string[];
}

const THERAPISTS: TherapistConfig[] = [
  {
    key: "hanka",
    name: "Hanička",
    relationship: "partnerka a vedoucí terapeutka. Karel k ní mluví s láskou, intimitou a respektem.",
    subModes: ["mamka", "hana_personal"],
  },
  {
    key: "kata",
    name: "Káťa",
    relationship: "mentorovaná terapeutka. Karel je její vedoucí a mentor — mluví profesionálně, vřele, ale s jasnou strukturou.",
    subModes: ["kata"],
  },
];

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const startTime = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  const results: Record<string, { ok: boolean; error?: string }> = {};

  try {
    const token = await getAccessToken();

    // Resolve PAMET_KAREL/DID
    const pametId = await findFolder(token, "PAMET_KAREL");
    if (!pametId) throw new Error("PAMET_KAREL not found");
    const didPametId = await findFolder(token, "DID", pametId);
    if (!didPametId) throw new Error("PAMET_KAREL/DID not found");

    // ── Fetch shared context: recent threads, tasks, crises ──
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const [threadsRes, convsRes, hanaRes, tasksRes, crisisRes] = await Promise.all([
      sb.from("did_threads").select("id, part_name, messages, last_activity_at, sub_mode")
        .gte("last_activity_at", sevenDaysAgo).order("last_activity_at", { ascending: false }).limit(30),
      sb.from("did_conversations").select("id, label, sub_mode, messages, updated_at")
        .gte("updated_at", sevenDaysAgo).order("updated_at", { ascending: false }).limit(20),
      sb.from("karel_hana_conversations").select("id, messages, current_domain, last_activity_at")
        .gte("last_activity_at", sevenDaysAgo).order("last_activity_at", { ascending: false }).limit(15),
      sb.from("did_therapist_tasks").select("*")
        .in("status", ["pending", "in_progress"]).order("created_at", { ascending: false }).limit(30),
      sb.from("crisis_alerts").select("part_name, severity, summary, status")
        .in("status", ["open", "monitoring"]).limit(10),
    ]);

    const threads = threadsRes.data || [];
    const convs = convsRes.data || [];
    const hanaConvs = hanaRes.data || [];
    const tasks = tasksRes.data || [];
    const crises = crisisRes.data || [];

    // ── Process each therapist ──
    for (const therapist of THERAPISTS) {
      try {
        // Find therapist folder
        const folderName = therapist.key === "hanka" ? "HANKA" : "KATA";
        const folderId = await findFolder(token, folderName, didPametId);
        if (!folderId) {
          results[therapist.key] = { ok: false, error: "Folder not found" };
          continue;
        }

        // Read current files
        const sitDoc = await findDocByExactName(token, folderId, "SITUACNI_ANALYZA.txt");
        const pozDoc = await findDocByExactName(token, folderId, "KARLOVY_POZNATKY.txt");
        if (!sitDoc || !pozDoc) {
          results[therapist.key] = { ok: false, error: "Target files not found" };
          continue;
        }

        const currentSit = await readDoc(token, sitDoc.id, 4000);
        const currentPoz = await readDoc(token, pozDoc.id, 4000);

        // Filter relevant threads
        const relevantThreads = threads
          .filter(t => therapist.subModes.includes(t.sub_mode))
          .slice(0, 10);
        const relevantConvs = convs
          .filter(c => therapist.subModes.includes(c.sub_mode))
          .slice(0, 8);
        const relevantHana = therapist.key === "hanka" ? hanaConvs.slice(0, 8) : [];
        const relevantTasks = tasks
          .filter((t: any) => t.assigned_to?.toLowerCase() === therapist.key || t.assigned_to?.toLowerCase() === therapist.name.toLowerCase());
        const relevantCrises = crises;

        // Build thread digest
        const threadDigest = [...relevantThreads, ...relevantConvs, ...relevantHana]
          .map((t: any) => {
            const msgs = Array.isArray(t.messages) ? t.messages : [];
            const lastMsgs = msgs.slice(-6).map((m: any) => `  [${m.role}] ${String(m.content || "").slice(0, 200)}`);
            const label = t.part_name || t.label || t.current_domain || "?";
            return `--- ${label} (${t.last_activity_at || t.updated_at || "?"}) ---\n${lastMsgs.join("\n")}`;
          })
          .join("\n\n")
          .slice(0, 5000);

        const taskDigest = relevantTasks
          .map((t: any) => `- [${t.status}] ${t.title} (${t.assigned_to})`)
          .join("\n") || "(žádné)";

        const crisisDigest = relevantCrises
          .map((c: any) => `⚠️ ${c.part_name}: ${c.severity} — ${c.summary?.slice(0, 100)}`)
          .join("\n") || "(žádné)";

        // ── AI generation ──
        const prompt = `Jsi Karel — kognitivní agent a supervizor DID terapeutického týmu.
Dnes: ${today}
Terapeutka: ${therapist.name} (${therapist.relationship})

Na základě aktuálních dat vygeneruj DVĚ sekce ve STABILNÍM formátu:

══ SEKCE 1: AKČNÍ INTELIGENCE ══
Začni PŘESNĚ takto (včetně data):
=== AKČNÍ INTELIGENCE ${today} ===
A) CO OD KARLA DNES POTŘEBUJE: (1-3 body, konkrétní)
B) JAK MÁ KAREL DNES MLUVIT: (1-2 body — tón, tempo, hloubka)
C) CO DNES NEDĚLAT: (1-2 body — co by dnes bylo kontraproduktivní)
D) NA CO SI DÁT POZOR: (1 bod — konkrétní riziko nebo příležitost)

══ SEKCE 2: KARLOVY DEDUKCE ══
Začni PŘESNĚ takto (včetně data):
=== KARLOVY DEDUKCE ${today} ===
- Jaký vzorec dnes Karel vidí? (1-2 věty)
- Co se děje pod povrchem? (1-2 věty — dedukce, ne popis)
- Na co by si měl dát pozor? (1 věta)

PRAVIDLA:
- Piš VÝHRADNĚ z aktuálních dat — žádné obecné fráze
- Buď stručný, analytický a dedukční
- Nikdy nevymýšlej — pracuj jen s tím, co máš
- Formát musí být PŘESNĚ jak je výše (=== AKČNÍ INTELIGENCE ${today} === a === KARLOVY DEDUKCE ${today} ===)
- Odděl obě sekce prázdným řádkem a značkou <<<SPLIT>>>

═══ AKTUÁLNÍ DATA ═══

Konverzace (posledních 7 dní):
${threadDigest || "(žádné)"}

Otevřené úkoly:
${taskDigest}

Aktivní krize:
${crisisDigest}

Stávající kontext (poslední záznam SITUACNI_ANALYZA):
${currentSit.slice(-1500)}

Stávající poznatky (poslední záznam KARLOVY_POZNATKY):
${currentPoz.slice(-1500)}`;

        const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "google/gemini-2.5-flash-lite",
            messages: [
              { role: "system", content: "Jsi Karel, kognitivní agent. Piš česky, stručně, analyticky. Nikdy nevymýšlej fakta." },
              { role: "user", content: prompt },
            ],
            temperature: 0.2,
          }),
        });

        if (!aiRes.ok) {
          const errText = await aiRes.text();
          results[therapist.key] = { ok: false, error: `AI ${aiRes.status}: ${errText.slice(0, 200)}` };
          continue;
        }

        const aiData = await aiRes.json();
        const fullOutput = aiData.choices?.[0]?.message?.content || "";

        if (!fullOutput) {
          results[therapist.key] = { ok: false, error: "Empty AI output" };
          continue;
        }

        // Split into two sections
        let akcniBlock: string;
        let dedukceBlock: string;

        if (fullOutput.includes("<<<SPLIT>>>")) {
          const parts = fullOutput.split("<<<SPLIT>>>");
          akcniBlock = parts[0].trim();
          dedukceBlock = parts[1]?.trim() || "";
        } else {
          // Fallback: split at "=== KARLOVY DEDUKCE"
          const dedIdx = fullOutput.indexOf("=== KARLOVY DEDUKCE");
          if (dedIdx > 0) {
            akcniBlock = fullOutput.slice(0, dedIdx).trim();
            dedukceBlock = fullOutput.slice(dedIdx).trim();
          } else {
            akcniBlock = fullOutput.trim();
            dedukceBlock = "";
          }
        }

        // Validate markers exist
        if (!akcniBlock.includes("AKČNÍ INTELIGENCE")) {
          akcniBlock = `=== AKČNÍ INTELIGENCE ${today} ===\n${akcniBlock}`;
        }
        if (dedukceBlock && !dedukceBlock.includes("KARLOVY DEDUKCE")) {
          dedukceBlock = `=== KARLOVY DEDUKCE ${today} ===\n${dedukceBlock}`;
        }

        // Append to Drive files
        await appendToFile(token, sitDoc.id, akcniBlock);
        console.log(`[therapist-intel] Appended AKČNÍ INTELIGENCE to ${folderName}/SITUACNI_ANALYZA.txt (${akcniBlock.length} chars)`);

        if (dedukceBlock) {
          await appendToFile(token, pozDoc.id, dedukceBlock);
          console.log(`[therapist-intel] Appended KARLOVY DEDUKCE to ${folderName}/KARLOVY_POZNATKY.txt (${dedukceBlock.length} chars)`);
        }

        results[therapist.key] = { ok: true };
      } catch (therapistErr) {
        const msg = therapistErr instanceof Error ? therapistErr.message : String(therapistErr);
        console.error(`[therapist-intel] Error for ${therapist.key}:`, msg);
        results[therapist.key] = { ok: false, error: msg };
      }
    }

    const elapsed = Date.now() - startTime;
    console.log(`[therapist-intel] Done in ${elapsed}ms:`, JSON.stringify(results));

    // Log to system_health_log
    await sb.from("system_health_log").insert({
      event_type: "daily_therapist_intelligence",
      severity: "info",
      source: "karel-daily-therapist-intelligence",
      details: { results, elapsed_ms: elapsed, date: today },
    });

    return new Response(JSON.stringify({ ok: true, results, elapsed_ms: elapsed }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[therapist-intel] Fatal error:", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

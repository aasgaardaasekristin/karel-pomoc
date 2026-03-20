/// <reference types="https://esm.sh/@supabase/functions-js/src/edge-runtime.d.ts" />
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/auth.ts";

/**
 * Karel DID Centrum Sync
 * 
 * Reads current DB state (registry, tasks, episodes, patterns, health)
 * and overwrites the 00_Aktualni_Dashboard document on Google Drive
 * with a fresh summary.
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

async function findDoc(token: string, pattern: string, parentId: string): Promise<{ id: string; name: string } | null> {
  const q = `name contains '${pattern}' and '${parentId}' in parents and trashed=false`;
  const params = new URLSearchParams({ q, fields: "files(id,name)", pageSize: "10", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data.files?.[0] || null;
}

async function overwriteDoc(token: string, fileId: string, content: string): Promise<void> {
  const boundary = "centrum_sync_boundary";
  const metadata = JSON.stringify({ mimeType: "application/vnd.google-apps.document" });
  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    metadata,
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    content,
    `--${boundary}--`,
  ].join("\r\n");

  const res = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart&supportsAllDrives=true`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    }
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Drive overwrite failed (${res.status}): ${errText}`);
  }
  await res.text(); // consume body
}

// ── Format helpers ──
function formatDate(d: string | null): string {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleDateString("cs-CZ", { day: "numeric", month: "numeric", year: "numeric" });
  } catch {
    return d;
  }
}

function statusEmoji(status: string): string {
  switch (status) {
    case "active": return "🟢";
    case "sleeping": return "😴";
    case "warning": return "⚠️";
    case "dormant": return "💤";
    default: return "❓";
  }
}

function healthBar(score: number): string {
  const filled = Math.round(score / 10);
  return "█".repeat(filled) + "░".repeat(10 - filled) + ` ${score}%`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Auth
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── 1. Read DB data in parallel ──
    const [
      registryRes,
      tasksRes,
      healthRes,
      episodesRes,
      patternsRes,
      sessionsRes,
    ] = await Promise.all([
      supabase.from("did_part_registry").select("*").order("part_name"),
      supabase.from("did_therapist_tasks").select("*").in("status", ["pending", "in_progress"]).order("created_at", { ascending: false }).limit(20),
      supabase.from("did_kartoteka_health").select("*").order("part_name"),
      supabase.from("karel_episodes").select("id, domain, summary_karel, emotional_intensity, timestamp_start, participants, tags").order("timestamp_start", { ascending: false }).limit(20),
      supabase.from("karel_semantic_patterns").select("description, domain, confidence, tags").order("confidence", { ascending: false }).limit(15),
      supabase.from("did_part_sessions").select("part_name, therapist, session_date, session_type, ai_analysis").order("session_date", { ascending: false }).limit(15),
    ]);

    const registry = registryRes.data || [];
    const tasks = tasksRes.data || [];
    const health = healthRes.data || [];
    const episodes = episodesRes.data || [];
    const patterns = patternsRes.data || [];
    const sessions = sessionsRes.data || [];

    const now = new Date().toISOString();
    const todayFormatted = formatDate(now);

    // ── 2. Build dashboard content ──
    const lines: string[] = [];

    lines.push("AKTUÁLNÍ DASHBOARD DID SYSTÉMU");
    lines.push(`Poslední aktualizace: ${todayFormatted}`);
    lines.push("");
    lines.push("═══════════════════════════════════════");
    lines.push("");

    // Section: Active parts overview
    lines.push("PŘEHLED ČÁSTÍ SYSTÉMU");
    lines.push("");
    if (registry.length === 0) {
      lines.push("  (žádné části v registru)");
    } else {
      for (const part of registry) {
        const healthEntry = health.find(h => h.part_name === part.part_name);
        const hScore = healthEntry ? healthEntry.health_score : part.health_score ?? 0;
        lines.push(`  ${statusEmoji(part.status)} ${part.display_name || part.part_name}`);
        lines.push(`    Stav: ${part.status} | Věk: ${part.age_estimate || "?"} | Jazyk: ${part.language || "cs"}`);
        lines.push(`    Role: ${part.role_in_system || "—"} | Cluster: ${part.cluster || "—"}`);
        lines.push(`    Poslední kontakt: ${formatDate(part.last_seen_at)} | Emoce: ${part.last_emotional_state || "—"} (${part.last_emotional_intensity ?? "?"})`);
        lines.push(`    Zdraví kartotéky: ${healthBar(hScore)}`);
        if (part.known_triggers?.length) lines.push(`    Triggery: ${part.known_triggers.join(", ")}`);
        if (part.known_strengths?.length) lines.push(`    Silné stránky: ${part.known_strengths.join(", ")}`);
        lines.push("");
      }
    }

    lines.push("═══════════════════════════════════════");
    lines.push("");

    // Section: Active tasks
    lines.push("AKTIVNÍ ÚKOLY PRO TERAPEUTKY");
    lines.push("");
    if (tasks.length === 0) {
      lines.push("  (žádné aktivní úkoly)");
    } else {
      for (const task of tasks) {
        const dueStr = task.due_date ? ` | Do: ${formatDate(task.due_date)}` : "";
        lines.push(`  [${task.status === "in_progress" ? "▶" : "○"}] ${task.task}`);
        lines.push(`    Přiřazeno: ${task.assigned_to} | Priorita: ${task.priority || "normal"}${dueStr}`);
        lines.push(`    Hanka: ${task.status_hanka} | Káťa: ${task.status_kata}`);
        if (task.note) lines.push(`    Poznámka: ${task.note}`);
        lines.push("");
      }
    }

    lines.push("═══════════════════════════════════════");
    lines.push("");

    // Section: Recent episodes
    lines.push("POSLEDNÍCH 20 EPIZOD");
    lines.push("");
    if (episodes.length === 0) {
      lines.push("  (žádné epizody)");
    } else {
      for (const ep of episodes) {
        lines.push(`  ${formatDate(ep.timestamp_start)} | ${ep.domain} | Intenzita: ${ep.emotional_intensity}/10`);
        lines.push(`    ${ep.summary_karel || "(bez shrnutí)"}`);
        if (ep.tags?.length) lines.push(`    Tagy: ${ep.tags.join(", ")}`);
        lines.push("");
      }
    }

    lines.push("═══════════════════════════════════════");
    lines.push("");

    // Section: Patterns
    lines.push("ROZPOZNANÉ VZORCE");
    lines.push("");
    if (patterns.length === 0) {
      lines.push("  (žádné vzorce)");
    } else {
      for (const p of patterns) {
        lines.push(`  [${Math.round(Number(p.confidence) * 100)}%] ${p.description}`);
        lines.push(`    Doména: ${p.domain} | Tagy: ${p.tags?.join(", ") || "—"}`);
        lines.push("");
      }
    }

    lines.push("═══════════════════════════════════════");
    lines.push("");

    // Section: Recent sessions
    lines.push("POSLEDNÍCH 15 SEZENÍ");
    lines.push("");
    if (sessions.length === 0) {
      lines.push("  (žádná sezení)");
    } else {
      for (const s of sessions) {
        lines.push(`  ${formatDate(s.session_date)} | ${s.part_name} | ${s.therapist} (${s.session_type})`);
        if (s.ai_analysis) {
          const truncated = s.ai_analysis.length > 150 ? s.ai_analysis.slice(0, 150) + "…" : s.ai_analysis;
          lines.push(`    Analýza: ${truncated}`);
        }
        lines.push("");
      }
    }

    // Section: Health summary
    lines.push("═══════════════════════════════════════");
    lines.push("");
    lines.push("ZDRAVÍ KARTOTÉKY – SOUHRN");
    lines.push("");
    if (health.length === 0) {
      lines.push("  (žádná data o zdraví)");
    } else {
      const avgHealth = Math.round(health.reduce((sum, h) => sum + h.health_score, 0) / health.length);
      lines.push(`  Průměrné zdraví: ${healthBar(avgHealth)}`);
      const lowHealth = health.filter(h => h.health_score < 50);
      if (lowHealth.length > 0) {
        lines.push(`  ⚠️ Nízké zdraví: ${lowHealth.map(h => `${h.part_name} (${h.health_score}%)`).join(", ")}`);
      }
      lines.push("");
    }

    const dashboardContent = lines.join("\n");

    // ── 3. Write to Drive ──
    const driveToken = await getAccessToken();

    // Find kartoteka root → 00_CENTRUM folder → Dashboard doc
    const kartotekaVariants = ["kartoteka_DID", "Kartoteka_DID", "Kartotéka_DID", "KARTOTEKA_DID"];
    let kartotekaRoot: string | null = null;
    for (const name of kartotekaVariants) {
      kartotekaRoot = await findFolder(driveToken, name);
      if (kartotekaRoot) break;
    }

    let driveResult = "Drive zápis přeskočen – složka nenalezena";

    if (kartotekaRoot) {
      // Find 00_CENTRUM folder
      const centrumDoc = await findCentrumFolder(driveToken, kartotekaRoot);
      if (centrumDoc) {
        // Find dashboard doc inside
        const dashDoc = await findDoc(driveToken, "Dashboard", centrumDoc);
        if (dashDoc) {
          await overwriteDoc(driveToken, dashDoc.id, dashboardContent);
          driveResult = `Přepsán: ${dashDoc.name}`;
        } else {
          driveResult = "Dokument 'Dashboard' nenalezen v 00_CENTRUM";
        }
      } else {
        driveResult = "Složka 00_CENTRUM nenalezena";
      }
    }

    // ── 4. Log to karel_memory_logs ──
    await supabase.from("karel_memory_logs").insert({
      log_type: "centrum_sync",
      job_type: "centrum",
      summary: `Centrum sync: ${registry.length} částí, ${tasks.length} úkolů, ${episodes.length} epizod. Drive: ${driveResult}`,
      details: {
        partsCount: registry.length,
        tasksCount: tasks.length,
        episodesCount: episodes.length,
        patternsCount: patterns.length,
        sessionsCount: sessions.length,
        driveResult,
      },
    });

    return new Response(
      JSON.stringify({
        ok: true,
        summary: `Dashboard aktualizován: ${registry.length} částí, ${tasks.length} úkolů, ${episodes.length} epizod`,
        driveResult,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: any) {
    console.error("[centrum-sync] Error:", error);
    return new Response(
      JSON.stringify({ error: error.message || "Centrum sync selhal" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

async function findCentrumFolder(token: string, parentId: string): Promise<string | null> {
  const q = `mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`;
  const params = new URLSearchParams({ q, fields: "files(id,name)", pageSize: "50", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  const folders = data.files || [];
  const centrum = folders.find((f: any) => /^00/.test(f.name) || /centrum/i.test(f.name));
  return centrum?.id || null;
}

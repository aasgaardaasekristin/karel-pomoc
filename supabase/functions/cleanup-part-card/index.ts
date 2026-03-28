import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { requireAuth, corsHeaders } from "../_shared/auth.ts";

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
const FOLDER_MIME = "application/vnd.google-apps.folder";

async function listFiles(token: string, folderId: string): Promise<Array<{ id: string; name: string; mimeType?: string }>> {
  const q = `'${folderId}' in parents and trashed=false`;
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${new URLSearchParams({
    q, fields: "files(id,name,mimeType)", pageSize: "200", supportsAllDrives: "true", includeItemsFromAllDrives: "true",
  })}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data.files || [];
}

async function findFolder(token: string, name: string, parentId?: string): Promise<string | null> {
  let q = `name='${name}' and mimeType='${FOLDER_MIME}' and trashed=false`;
  if (parentId) q += ` and '${parentId}' in parents`;
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${new URLSearchParams({
    q, fields: "files(id)", pageSize: "5", supportsAllDrives: "true", includeItemsFromAllDrives: "true",
  })}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data.files?.[0]?.id || null;
}

async function resolveKartotekaRoot(token: string): Promise<string | null> {
  for (const name of ["kartoteka_DID", "Kartoteka_DID", "KARTOTEKA_DID"]) {
    const id = await findFolder(token, name);
    if (id) return id;
  }
  return null;
}

async function readFileContent(token: string, fileId: string, mimeType?: string): Promise<string> {
  const isGDoc = mimeType === "application/vnd.google-apps.document";
  const isWorkspace = mimeType?.startsWith("application/vnd.google-apps.");
  if (isGDoc || isWorkspace) {
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error(`Export failed: ${r.status}`);
    return r.text();
  }
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`Download failed: ${r.status}`);
  return r.text();
}

// ── Write entire content to a Google Doc (overwrite) ──
async function overwriteDoc(token: string, fileId: string, newContent: string): Promise<void> {
  // Get current endIndex
  const metaRes = await fetch(
    `https://docs.googleapis.com/v1/documents/${fileId}?fields=body.content(endIndex)`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!metaRes.ok) throw new Error(`Docs API meta failed: ${metaRes.status}`);
  const meta = await metaRes.json();
  const content = meta?.body?.content || [];
  const lastEnd = content.length > 0 ? Number(content[content.length - 1]?.endIndex || 1) : 1;

  const requests: any[] = [];

  // Delete all existing content (if any beyond index 1)
  if (lastEnd > 2) {
    requests.push({
      deleteContentRange: {
        range: { startIndex: 1, endIndex: lastEnd - 1 },
      },
    });
  }

  // Insert new content at index 1
  requests.push({
    insertText: { location: { index: 1 }, text: newContent },
  });

  const res = await fetch(`https://docs.googleapis.com/v1/documents/${fileId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Docs overwrite failed: ${res.status} ${errText}`);
  }
  await res.text();
}

// ── Create a backup copy ──
async function createBackup(token: string, folderId: string, originalName: string, content: string): Promise<string> {
  const date = new Date().toISOString().slice(0, 10);
  const backupName = `BACKUP_${date}_${originalName}`;

  // Create a new Google Doc
  const createRes = await fetch("https://www.googleapis.com/drive/v3/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: backupName,
      parents: [folderId],
      mimeType: "application/vnd.google-apps.document",
    }),
  });
  if (!createRes.ok) throw new Error(`Backup create failed: ${createRes.status}`);
  const newFile = await createRes.json();

  // Write content
  await fetch(`https://docs.googleapis.com/v1/documents/${newFile.id}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: [{ insertText: { location: { index: 1 }, text: content } }],
    }),
  });

  console.log(`[cleanup] Backup created: ${backupName} (${newFile.id})`);
  return newFile.id;
}

// ── AI cleanup ──
async function callGemini(cardContent: string, partName: string): Promise<string> {
  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

  const cleanupPrompt = `Jsi Karel — odborník na DID a správce kartotéky.

Dostáváš kartu části "${partName}" z DID kartotéky. Karta je poškozená — obsahuje:
- Duplicitní záznamy (stejná informace vícekrát)
- Testovací data (E2E test, Test in-place append, test data)
- Automatické redistribuce nalepené na konce sekcí ve špatném formátu (bloky s [KHASH:...])
- Možné míchání dvou různých entit v jedné kartě

TVŮJ ÚKOL:
1. Zachovej přesnou strukturu sekcí A–M
2. Pro KAŽDOU sekci:
   - Odstraň duplicity (zachovej nejúplnější verzi)
   - Odstraň testovací data
   - Informace z redistribucí [KHASH:...] bloků INTEGRUJ do správného místa v sekci — ale jen pokud přinášejí NOVOU informaci
   - Odstraň [KHASH:...] tagy
   - Odstraň [SRC:...] tagy
   - Zachovej datumy u informací
3. Pokud karta obsahuje informace o JINÉ entitě (např. Tundrup/dospělý v kartě Tundrupka/dítě):
   - Tyto informace ODDĚL na konec karty do sekce "PŘESUNOUT DO JINÉ KARTY: [jméno entity]"
4. Odstraň bloky "═══ AKTUALIZACE [datum] ═══" a jejich obsah INTEGRUJ do příslušných sekcí (pokud přinášejí novou informaci) nebo SMAŽ (pokud jsou duplicitní nebo testovací)
5. Odstraň bloky "=== [datum] Denní aktualizace stavu ===" a jejich obsah integruj do sekce A (aktuální stav) pokud je relevantní
6. Výsledek musí být ČISTÁ karta — čitelná, bez duplicit, bez testovacích dat, ve formátu originálu

FORMÁT VÝSTUPU:
Vrať CELOU vyčištěnou kartu jako plain text, zachovej formátování sekcí A–M.

Na konci VŽDY přidej (oddělené od karty):

---CLEANUP LOG---
Odstraněno duplicit: [počet]
Odstraněno testovacích dat: [počet]
Integrováno redistribucí: [počet]
Přesunuto do jiné karty: [počet] záznamů pro [jméno entity]
---END LOG---

Zde je karta:

${cardContent}`;

  const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${LOVABLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      messages: [
        { role: "system", content: "Jsi Karel, odborník na DID kartotéku. Vyčisti kartu podle instrukcí. Buď precizní." },
        { role: "user", content: cleanupPrompt },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`AI gateway error: ${res.status} ${errText}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

function parseCleanupLog(text: string): {
  cleanedCard: string;
  duplicatesRemoved: number;
  testsRemoved: number;
  redistributionsIntegrated: number;
  movedToOtherCard: number;
  movedEntityNames: string[];
} {
  const logMatch = text.match(/---CLEANUP LOG---([\s\S]*?)---END LOG---/);
  let cleanedCard = text;
  let duplicatesRemoved = 0, testsRemoved = 0, redistributionsIntegrated = 0, movedToOtherCard = 0;
  const movedEntityNames: string[] = [];

  if (logMatch) {
    cleanedCard = text.slice(0, text.indexOf("---CLEANUP LOG---")).trim();
    const log = logMatch[1];

    const dupMatch = log.match(/duplicit:\s*(\d+)/i);
    if (dupMatch) duplicatesRemoved = parseInt(dupMatch[1]);

    const testMatch = log.match(/testovac[ií]ch dat:\s*(\d+)/i);
    if (testMatch) testsRemoved = parseInt(testMatch[1]);

    const redistMatch = log.match(/redistribuc[ií]:\s*(\d+)/i);
    if (redistMatch) redistributionsIntegrated = parseInt(redistMatch[1]);

    const movedMatch = log.match(/jin[ée] kart[yě]:\s*(\d+)\s*z[áa]znam[ůu]\s*pro\s+(.+)/i);
    if (movedMatch) {
      movedToOtherCard = parseInt(movedMatch[1]);
      movedEntityNames.push(movedMatch[2].trim());
    }
  }

  return { cleanedCard, duplicatesRemoved, testsRemoved, redistributionsIntegrated, movedToOtherCard, movedEntityNames };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const auth = await requireAuth(req);
  if (auth instanceof Response) return auth;

  try {
    const { folderId, folderName, listOnly } = await req.json();

    const token = await getAccessToken();

    // ── LIST MODE: return folders in 01_AKTIVNI_FRAGMENTY ──
    if (listOnly) {
      const rootId = await resolveKartotekaRoot(token);
      if (!rootId) {
        return new Response(JSON.stringify({ error: "kartoteka_DID not found" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const rootFiles = await listFiles(token, rootId);
      const aktivniFolder = rootFiles.find(f => f.mimeType === FOLDER_MIME && (/^01/.test(f.name) || f.name.toLowerCase().includes("aktiv")));
      if (!aktivniFolder) {
        return new Response(JSON.stringify({ error: "01_AKTIVNI_FRAGMENTY not found" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const partFolders = await listFiles(token, aktivniFolder.id);
      const folders = partFolders
        .filter(f => f.mimeType === FOLDER_MIME)
        .map(f => ({ id: f.id, name: f.name }))
        .sort((a, b) => a.name.localeCompare(b.name));

      return new Response(JSON.stringify({ folders }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── CLEANUP MODE ──
    if (!folderId) {
      return new Response(JSON.stringify({ error: "folderId required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const partName = folderName || folderId;
    console.log(`[cleanup] Starting cleanup for: ${partName} (${folderId})`);

    // Find the card file in the folder
    const files = await listFiles(token, folderId);
    const cardFile = files.find(f =>
      f.mimeType !== FOLDER_MIME &&
      !f.name.startsWith("BACKUP_") &&
      !f.name.includes("ARCHIV") &&
      (f.mimeType === "application/vnd.google-apps.document" || /\.(txt|md)$/i.test(f.name))
    );

    if (!cardFile) {
      return new Response(JSON.stringify({ error: `No card file found in folder ${partName}` }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[cleanup] Found card: ${cardFile.name} (${cardFile.id})`);

    // Read current content
    const originalContent = await readFileContent(token, cardFile.id, cardFile.mimeType);
    console.log(`[cleanup] Card size: ${originalContent.length} chars`);

    // Create backup BEFORE cleanup
    await createBackup(token, folderId, cardFile.name, originalContent);

    // Call Gemini to clean up
    console.log(`[cleanup] Calling AI for cleanup...`);
    const aiResult = await callGemini(originalContent, partName);

    // Parse result
    const parsed = parseCleanupLog(aiResult);
    console.log(`[cleanup] Cleanup result: ${parsed.duplicatesRemoved} dups, ${parsed.testsRemoved} tests, ${parsed.redistributionsIntegrated} redist, ${parsed.movedToOtherCard} moved`);

    // Overwrite the card with cleaned content
    await overwriteDoc(token, cardFile.id, parsed.cleanedCard);
    console.log(`[cleanup] ✅ Card overwritten: ${cardFile.name}`);

    // Log to Supabase
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, supabaseKey);

    await sb.from("card_cleanup_log").insert({
      part_name: partName,
      duplicates_removed: parsed.duplicatesRemoved,
      tests_removed: parsed.testsRemoved,
      redistributions_integrated: parsed.redistributionsIntegrated,
      moved_to_other_card: parsed.movedToOtherCard,
      moved_entity_names: parsed.movedEntityNames,
      cleanup_summary: aiResult.slice(aiResult.indexOf("---CLEANUP LOG---")),
      user_id: (auth as { user: any }).user.id,
    });

    // Handle moved-to-other-card items
    if (parsed.movedToOtherCard > 0 && parsed.movedEntityNames.length > 0) {
      // Create a task in did_therapist_tasks for manual review
      for (const entity of parsed.movedEntityNames) {
        await sb.from("did_therapist_tasks").insert({
          task: `Přesunout ${parsed.movedToOtherCard} záznamů z karty ${partName} do karty ${entity}`,
          assigned_to: "both",
          priority: "medium",
          category: "kartoteka",
          note: `Cleanup karty ${partName} našel záznamy patřící entitě ${entity}. Zkontroluj a přesuň manuálně.`,
          user_id: (auth as { user: any }).user.id,
        });
      }
    }

    return new Response(JSON.stringify({
      success: true,
      cardName: cardFile.name,
      originalSize: originalContent.length,
      cleanedSize: parsed.cleanedCard.length,
      log: {
        duplicatesRemoved: parsed.duplicatesRemoved,
        testsRemoved: parsed.testsRemoved,
        redistributionsIntegrated: parsed.redistributionsIntegrated,
        movedToOtherCard: parsed.movedToOtherCard,
        movedEntityNames: parsed.movedEntityNames,
      },
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (err) {
    console.error("[cleanup] Error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

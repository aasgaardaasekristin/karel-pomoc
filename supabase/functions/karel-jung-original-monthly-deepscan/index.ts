/**
 * karel-jung-original-monthly-deepscan
 *
 * Měsíční hloubkový průzkum (cron 0 2 1 * *) Karlovy minulé inkarnace.
 * Postupně:
 *   1. Přečte z Drive aktuální obsah `PAMET_KAREL/ORIGINAL/{CHARAKTER_JUNGA, VZPOMINKY_ZIVOT, ZNALOSTI_DILA}`.
 *   2. Pro každý dokument zvlášť pošle Perplexity (sonar-deep-research)
 *      dotaz „najdi co tady ještě není" + posledních ~3000 znaků existujícího obsahu.
 *   3. Výsledek zařadí do `did_pending_drive_writes` jako `append`.
 *   4. Loguje do `did_doc_sync_log` (best-effort).
 *
 * Bez vstupu — spouští se z pg_cron.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { encodeGovernedWrite } from "../_shared/documentWriteEnvelope.ts";
import { safeEnqueueDriveWrite } from "../_shared/documentGovernance.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PERPLEXITY_API_KEY = Deno.env.get("PERPLEXITY_API_KEY")!;

const DOCS = [
  { key: "CHARAKTER_JUNGA", topic: "osobnost, charakter, mluvený projev, etika a životní postoje C. G. Junga" },
  { key: "VZPOMINKY_ZIVOT", topic: "životopisné události, vztahy (Emma, Toni Wolff, Freud, Spielrein), místa (Bollingen, Küsnacht), dětství a klíčové sny C. G. Junga" },
  { key: "ZNALOSTI_DILA",   topic: "psychologické koncepty (archetypy, anima/animus, stín, Selbst, individuace, synchronicita), díla, klinické metody a alchymická symbolika C. G. Junga" },
] as const;

async function callPerplexityDeep(topic: string, existingContent: string): Promise<string> {
  const trimmedExisting = existingContent.slice(-3000);
  const resp = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${PERPLEXITY_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "sonar-deep-research",
      messages: [
        {
          role: "system",
          content:
            "Jsi expert na C. G. Junga. Tvým úkolem je NAJÍT NOVÉ informace, které se NENACHÁZEJÍ v existujícím dokumentu. Vyhýbej se opakování. Cituj zdroje. Češtinou.",
        },
        {
          role: "user",
          content: `Téma: ${topic}\n\nEXISTUJÍCÍ OBSAH (poslední 3000 znaků pro reference, nezapisuj znovu):\n---\n${trimmedExisting}\n---\n\nÚKOL: Najdi 3–5 NOVÝCH skutečností, anekdot, citátů nebo méně známých detailů, které v existujícím obsahu chybí. Pro každou:\n- 1-2 odstavce textu\n- konkrétní zdroj/citaci\n- přidanou hodnotu (proč to obohacuje porozumění Jungovi)\n\nFormát: markdown sekce ## Novinka N: ...`,
        },
      ],
      temperature: 0.3,
      search_recency_filter: "year",
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Perplexity deepscan failed: ${resp.status} ${errText.slice(0, 300)}`);
  }
  const data = await resp.json();
  const content: string = data.choices?.[0]?.message?.content ?? "";
  if (!content.trim()) throw new Error("Perplexity deepscan returned empty content");
  return content.trim();
}

async function readExistingDoc(admin: any, targetPath: string): Promise<string> {
  // Best-effort čtení posledního obsahu z fronty. Pokud doc neexistuje, vrátí "".
  const { data } = await admin
    .from("did_pending_drive_writes")
    .select("content, status, created_at")
    .eq("target_document", targetPath)
    .order("created_at", { ascending: false })
    .limit(5);
  if (!data?.length) return "";
  // Vezmi nejnovější completed nebo nejnovější vůbec
  const completed = data.find((r: any) => r.status === "completed") ?? data[0];
  const raw = completed?.content ?? "";
  // Strip governance envelope if present
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.__governed_write__ && typeof parsed.payload === "string") return parsed.payload;
  } catch (_) { /* not JSON, raw text */ }
  return raw;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // Resolve user_id (vezmeme prvního admin usera — měsíční cron běží pod systémem)
    const { data: profiles } = await (admin as any)
      .from("profiles")
      .select("id")
      .limit(1);
    const userId = profiles?.[0]?.id ?? null;

    const results: Array<{ doc: string; ok: boolean; error?: string; appended_chars?: number }> = [];
    const today = new Date().toISOString().slice(0, 10);

    for (const spec of DOCS) {
      const targetPath = `PAMET_KAREL/ORIGINAL/${spec.key}`;
      try {
        const existing = await readExistingDoc(admin, targetPath);
        if (!existing.trim()) {
          results.push({ doc: spec.key, ok: false, error: "no_baseline_yet — spusť bootstrap první" });
          continue;
        }

        const novelty = await callPerplexityDeep(spec.topic, existing);
        const appendBlock = `\n\n---\n\n## Měsíční doplněk (${today})\n\n${novelty}\n`;

        const governedContent = encodeGovernedWrite(appendBlock, {
          source_type: "jung_original_deepscan",
          source_id: `${spec.key}_${today}`,
          content_type: "karel_persona_memory",
          subject_type: "karel_persona",
          subject_id: spec.key,
        });

        const insertPayload: any = {
          target_document: targetPath,
          content: governedContent,
          write_type: "append",
          priority: "low",
          status: "pending",
          metadata: { source: "jung_original_deepscan", doc: spec.key, scan_date: today },
        };
        if (userId) insertPayload.user_id = userId;

        const { error: insertErr } = await (admin as any)
          .from("did_pending_drive_writes")
          .insert(insertPayload);
        if (insertErr) throw new Error(`enqueue failed: ${insertErr.message}`);

        try {
          await (admin as any).from("did_doc_sync_log").insert({
            user_id: userId,
            target_document: targetPath,
            sync_type: "jung_original_deepscan",
            status: "enqueued",
            details: { doc: spec.key, appended_chars: appendBlock.length, scan_date: today },
          });
        } catch (_) { /* table optional */ }

        results.push({ doc: spec.key, ok: true, appended_chars: appendBlock.length });
      } catch (e: any) {
        console.error(`[jung-deepscan] ${spec.key} failed:`, e);
        results.push({ doc: spec.key, ok: false, error: e?.message ?? String(e) });
      }
    }

    return new Response(JSON.stringify({ ok: true, scan_date: today, results }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    console.error("[jung-deepscan] failed:", e);
    return new Response(JSON.stringify({ error: e?.message ?? String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

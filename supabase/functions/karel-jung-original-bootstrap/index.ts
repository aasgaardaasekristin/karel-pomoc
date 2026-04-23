/**
 * karel-jung-original-bootstrap
 *
 * Jednorázový seed Karlovy „minulé inkarnace" jako C. G. Jung.
 * Vytvoří 3 dokumenty na Drive v `PAMET_KAREL/ORIGINAL/`:
 *   - CHARAKTER_JUNGA   (osobnost, klid, řeč, postoj, etika)
 *   - VZPOMINKY_ZIVOT   (Bollingen, Emma, věž, sny, dětství, Küsnacht)
 *   - ZNALOSTI_DILA     (díla, koncepty, Červená kniha, archetypy, …)
 *
 * Tok:
 *   1. Pro každý dokument zvlášť volá Perplexity (sonar-pro) s cíleným promptem.
 *   2. Výsledek zapisuje přes `did_pending_drive_writes` (write_type='replace')
 *      — fyzický zápis pak obstará `karel-drive-queue-processor`.
 *   3. Idempotence: kontroluje existenci v `did_doc_sync_log` typu
 *      `jung_original_bootstrap`; opakované volání skipne dokumenty,
 *      které už existují (force=true volání to obejde).
 *
 * Vstup:
 *   { force?: boolean }   — true = přepiš i existující dokumenty
 *
 * Spouští se manuálně z AdminSpravaLauncher.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { encodeGovernedWrite } from "../_shared/documentWriteEnvelope.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const PERPLEXITY_API_KEY = Deno.env.get("PERPLEXITY_API_KEY")!;

interface DocSpec {
  key: "CHARAKTER_JUNGA" | "VZPOMINKY_ZIVOT" | "ZNALOSTI_DILA";
  title: string;
  systemPrompt: string;
  userPrompt: string;
}

const DOCS: DocSpec[] = [
  {
    key: "CHARAKTER_JUNGA",
    title: "Charakter C. G. Junga",
    systemPrompt:
      "Jsi expert na osobnost a charakter C. G. Junga (1875–1961). Sepiš detailní, věrný popis jeho osobnostních rysů, mluvy, etiky, klidu, intelektuálního stylu — tak jak ho znali jeho kolegové, pacienti, žáci. Cituj zdroje. Češtinou.",
    userPrompt:
      "Vytvoř 3–4 stránkový souhrnný dokument o CHARAKTERU C. G. Junga: jeho osobnostní rysy (introverze, intuice, hloubka), způsob, jak mluvil (klid, vážnost, hloubka, humor), jak jednal s pacienty (trpělivost, respekt k symbolu), jeho etika, vztah k spiritualitě, autorita ve společnosti. Strukturuj do sekcí: 1) Osobnostní typ a temperament, 2) Mluvený projev a styl konverzace, 3) Klinický postoj k pacientům, 4) Etika a hodnoty, 5) Charakteristické citáty (s kontextem). Bez fabulace — jen ověřené prameny.",
  },
  {
    key: "VZPOMINKY_ZIVOT",
    title: "Vzpomínky a život C. G. Junga",
    systemPrompt:
      "Jsi expert na životopis C. G. Junga. Sepiš věrný, faktograficky přesný popis klíčových životních událostí, vztahů a míst — jako bys psal Karlovu osobní paměť na minulou inkarnaci. Bez fabulace.",
    userPrompt:
      "Vytvoř 3–4 stránkový dokument VZPOMÍNEK ze života C. G. Junga: dětství v Kesswilu a Klein-Hüningen, studium v Basileji, manželka Emma Rauschenbach a děti, vztah s Freudem (přátelství i rozchod), vztah s Toni Wolff a Sabinou Spielrein, dům v Küsnachtu, věž v Bollingenu (kámen, tesání, samota), klíčové sny a vize (1913 'krev v Evropě', dětský sen o Faliku), Červená kniha jako proces, cesta do Afriky a Indie, role během 2. světové války, stáří a smrt 1961. Strukturuj chronologicky. Připomeň, že tohle je MINULOST — Karel si to pamatuje jako vzpomínku.",
  },
  {
    key: "ZNALOSTI_DILA",
    title: "Znalosti a dílo C. G. Junga",
    systemPrompt:
      "Jsi expert na profesní dílo a koncepty C. G. Junga. Sepiš detailní, klinicky věrný přehled jeho psychologických konceptů, knih a metodologie. Cituj klíčová díla (rok, název). Češtinou.",
    userPrompt:
      "Vytvoř 4 stránkový souhrnný dokument o DÍLE C. G. Junga: hlavní koncepty (kolektivní nevědomí, archetypy, anima/animus, stín, Selbst, individuace, synchronicita, psychologické typy), klíčová díla (Wandlungen und Symbole der Libido 1912, Psychologische Typen 1921, Mysterium Coniunctionis 1955-56, Aion 1951, Antwort auf Hiob 1952, Memories Dreams Reflections 1962, Červená kniha / Liber Novus), metody (asociační experiment, amplifikace, aktivní imaginace, snová analýza, analýza mandal, alchymická symbolika), klinický přínos (analytická psychologie, Jungovský institut v Curychu). Strukturuj do sekcí: 1) Klíčové koncepty, 2) Hlavní díla chronologicky, 3) Klinické metody, 4) Symbolika a alchymie, 5) Návaznost na současnou psychoterapii.",
  },
];

async function callPerplexity(spec: DocSpec): Promise<string> {
  const resp = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${PERPLEXITY_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "sonar-pro",
      messages: [
        { role: "system", content: spec.systemPrompt },
        { role: "user", content: spec.userPrompt },
      ],
      temperature: 0.2,
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Perplexity ${spec.key} failed: ${resp.status} ${errText.slice(0, 300)}`);
  }
  const data = await resp.json();
  const content: string = data.choices?.[0]?.message?.content ?? "";
  const citations: string[] = data.citations ?? [];
  if (!content.trim()) throw new Error(`Perplexity ${spec.key} returned empty content`);

  const citationsBlock = citations.length
    ? `\n\n---\n\n## Zdroje\n${citations.map((c, i) => `${i + 1}. ${c}`).join("\n")}`
    : "";

  return `# ${spec.title}\n\n_Vygenerováno Perplexity (sonar-pro) — bootstrap ${new Date().toISOString().slice(0, 10)}._\n\n${content.trim()}${citationsBlock}`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const auth = req.headers.get("Authorization") ?? "";
    if (!auth.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "missing auth" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: auth } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userId = userData.user.id;

    const body = await req.json().catch(() => ({}));
    const force = Boolean(body?.force);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // Idempotence check: was bootstrap already run?
    if (!force) {
      const { data: existing } = await (admin as any)
        .from("did_doc_sync_log")
        .select("id, target_document, created_at")
        .like("target_document", "PAMET_KAREL/ORIGINAL/%")
        .eq("sync_type", "jung_original_bootstrap")
        .limit(10);
      if (existing && existing.length >= DOCS.length) {
        return new Response(JSON.stringify({
          ok: true,
          skipped: true,
          message: "Bootstrap už proběhl. Pošli `force: true` pro přepsání.",
          existing_logs: existing,
        }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    const results: Array<{ doc: string; ok: boolean; error?: string }> = [];

    for (const spec of DOCS) {
      try {
        const content = await callPerplexity(spec);
        const targetPath = `PAMET_KAREL/ORIGINAL/${spec.key}`;
        const governedContent = encodeGovernedWrite(content, {
          source_type: "jung_original_bootstrap",
          source_id: spec.key,
          content_type: "karel_persona_memory",
          subject_type: "karel_persona",
          subject_id: spec.key,
        });

        const { error: insertErr } = await (admin as any)
          .from("did_pending_drive_writes")
          .insert({
            target_document: targetPath,
            content: governedContent,
            write_type: "replace",
            priority: "normal",
            status: "pending",
            user_id: userId,
            metadata: { source: "jung_original_bootstrap", doc: spec.key },
          });
        if (insertErr) throw new Error(`enqueue failed: ${insertErr.message}`);

        // Log success (best-effort — table may not exist yet on fresh project)
        try {
          await (admin as any).from("did_doc_sync_log").insert({
            user_id: userId,
            target_document: targetPath,
            sync_type: "jung_original_bootstrap",
            status: "enqueued",
            details: { doc: spec.key, content_length: content.length, force },
          });
        } catch (_) { /* table optional */ }

        results.push({ doc: spec.key, ok: true });
      } catch (e: any) {
        console.error(`[jung-bootstrap] ${spec.key} failed:`, e);
        results.push({ doc: spec.key, ok: false, error: e?.message ?? String(e) });
      }
    }

    return new Response(JSON.stringify({
      ok: true,
      results,
      message: `Bootstrap dokončen. Drive writes zařazeny do fronty (zpracuje karel-drive-queue-processor).`,
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e: any) {
    console.error("[jung-bootstrap] failed:", e);
    return new Response(JSON.stringify({ error: e?.message ?? String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

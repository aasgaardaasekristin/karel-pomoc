/**
 * karel-daily-thread-sorter
 *
 * Denní třídicí pass: načte vlákna za 24h z did_threads (mamka/kata)
 * a karel_hana_conversations (hana_personal), AI je roztřídí do bloků
 * a výsledky zapíše přímo do did_pending_drive_writes.
 * Po zpracování vlákno zamkne (is_locked + archive_status).
 *
 * ENTITY GUARDRAILS (fáze 7):
 *   Před zápisem KARTA_* se každá entita klasifikuje jako:
 *   - confirmed_part → KARTA_* povolena
 *   - known_alias_of_part → přeložena na kanonické jméno → KARTA_*
 *   - uncertain_entity → KARTA_* ZAKÁZÁNA, follow-up otázka
 *   - non_part_context → max KDO_JE_KDO nebo ignorováno
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { callAiForJson } from "../_shared/aiCallWrapper.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const VALID_TARGETS = [
  "PAMET_KAREL/DID/HANKA/SITUACNI_ANALYZA",
  "PAMET_KAREL/DID/HANKA/KARLOVY_POZNATKY",
  "PAMET_KAREL/DID/HANKA/KAREL",
  "PAMET_KAREL/DID/HANKA/VLAKNA_POSLEDNI",
  "PAMET_KAREL/DID/HANKA/VLAKNA_3DNY",
  "PAMET_KAREL/DID/KATA/SITUACNI_ANALYZA",
  "PAMET_KAREL/DID/KATA/KARLOVY_POZNATKY",
  "PAMET_KAREL/DID/KATA/KAREL",
  "PAMET_KAREL/DID/KATA/VLAKNA_POSLEDNI",
  "PAMET_KAREL/DID/KATA/VLAKNA_3DNY",
  "PAMET_KAREL/DID/KONTEXTY/KDO_JE_KDO",
];

const REPLACE_TARGETS = [
  "PAMET_KAREL/DID/HANKA/VLAKNA_3DNY",
  "PAMET_KAREL/DID/KATA/VLAKNA_3DNY",
];

// ─── Entity Guardrails ──────────────────────────────────────────────

/** Normalize: lowercase, strip diacritics, trim */
function normalizeName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[_\s]+/g, " ")
    .trim();
}

/**
 * KNOWN NON-PARTS: entities that must NEVER get a KARTA_*
 * Maps normalized name → description for KDO_JE_KDO routing
 */
const NON_PART_ENTITIES: Record<string, string> = {
  "locik": "pes",
  "locek": "pes",
  "zelena vesta": "popis/atribut, ne DID \u010d\u00e1st",
};

/**
 * KNOWN ALIASES: maps normalized alias → canonical part name (uppercase)
 * so AI output KARTA_LOBCANG gets rewritten to KARTA_LOBZHANG
 */
const ALIAS_MAP: Record<string, string> = {
  "lobcang": "LOBZHANG",
  "lobchang": "LOBZHANG",
};

/**
 * EXPLICITLY UNCERTAIN: names that are known-uncertain (skip follow-up dedup)
 */
const EXPLICITLY_UNCERTAIN: string[] = [
  "indian",
];

/**
 * CONFIRMED PARTS ALLOWLIST: only these normalized names may get KARTA_*
 * Derived from existing cards and registry. Everything else → uncertain.
 */
const CONFIRMED_PARTS: string[] = [
  "gustik",
  "arthur", "artik",
  "tundrupek",
  "dmytri", "dymi",
  "gerhardt", "gerhard",
  "lobzhang",
  "anicka", "anicka",
  "einar",
  "bello",
  "bendik",
  "emily",
  "gejbi",
  "c.g.", "cg",
  "bytostne ja",
];

type EntityClass =
  | "confirmed_part"
  | "known_alias_of_part"
  | "uncertain_entity"
  | "non_part_context";

interface EntityClassification {
  classification: EntityClass;
  canonicalName?: string;
  nonPartReason?: string;
}

/**
 * Classify an entity name extracted from a KARTA_* target.
 * DEFAULT IS uncertain_entity — confirmed only via allowlist.
 */
function classifyEntity(rawName: string): EntityClassification {
  const norm = normalizeName(rawName);

  // 1. Check non-part entities
  for (const [key, reason] of Object.entries(NON_PART_ENTITIES)) {
    if (norm === key || norm.includes(key)) {
      return { classification: "non_part_context", nonPartReason: reason };
    }
  }

  // 2. Check known aliases → rewrite to canonical
  for (const [alias, canonical] of Object.entries(ALIAS_MAP)) {
    if (norm === alias || norm.includes(alias)) {
      return { classification: "known_alias_of_part", canonicalName: canonical };
    }
  }

  // 3. Check confirmed parts allowlist
  if (CONFIRMED_PARTS.some((p) => norm === p || norm.includes(p))) {
    return { classification: "confirmed_part" };
  }

  // 4. DEFAULT: uncertain — no KARTA_* allowed
  return { classification: "uncertain_entity" };
}

// ─── System Prompt ──────────────────────────────────────────────────

const SORTING_SYSTEM_PROMPT = `Jsi Karel \u2013 supervizor a analytik DID terapeutick\u00e9ho syst\u00e9mu.

Dostane\u0161 konverza\u010dn\u00ed vl\u00e1kno (zpr\u00e1vy mezi u\u017eivatelem a Karlem).
Tv\u016fj \u00fakol: vyt\u011b\u017eit kl\u00ed\u010dov\u00e9 informace a rozt\u0159\u00eddit je do blok\u016f podle c\u00edlov\u00e9ho dokumentu.

Ka\u017ed\u00fd blok mus\u00ed m\u00edt:
- "target": c\u00edlov\u00fd dokument (viz seznam n\u00ed\u017ee)
- "content": stru\u010dn\u00fd, konkr\u00e9tn\u00ed text (co zapsat do dokumentu)
- "reasoning": pro\u010d to pat\u0159\u00ed sem (1 v\u011bta)

C\u00cdLOV\u00c9 DOKUMENTY:

1. PAMET_KAREL/DID/HANKA/SITUACNI_ANALYZA
   \u2192 aktu\u00e1ln\u00ed \u017eivotn\u00ed situace Hanky (pr\u00e1ce, vztahy, bydlen\u00ed, finance, zdrav\u00ed)

2. PAMET_KAREL/DID/HANKA/KARLOVY_POZNATKY
   \u2192 Karlovy post\u0159ehy o Hance (motivace, spolehlivost, vzorce chov\u00e1n\u00ed, emo\u010dn\u00ed stav)

3. PAMET_KAREL/DID/HANKA/KAREL
   \u2192 SD\u00cdLEN\u00c1 PAM\u011a\u0164 VZTAHU Karel\u2013Hani\u010dka. Co spolu pro\u017eili, o \u010dem mluvili, spole\u010dn\u00e9 vzpom\u00ednky,
     co Hani\u010dka Karlovi \u0159ekla o jejich vztahu, jak se Karel pro ni m\u011bn\u00ed, co Karel pro Hani\u010dku znamen\u00e1.
     NE profil Karla \u2014 ale \u017eiv\u00e1 pam\u011b\u0165 jejich spole\u010dn\u00e9ho p\u0159\u00edb\u011bhu.

4. PAMET_KAREL/DID/HANKA/VLAKNA_POSLEDNI
   \u2192 SHRNUT\u00cd PR\u00c1V\u011a UZAV\u0158EN\u00c9HO VL\u00c1KNA Hani\u010dky. Kr\u00e1tk\u00fd p\u0159ehled: o \u010dem se mluvilo, jak\u00e9 emoce,
     jak\u00fd v\u00fdsledek, co z\u016fstalo otev\u0159en\u00e9. Max 3-5 v\u011bt. Slou\u017e\u00ed k nav\u00e1z\u00e1n\u00ed p\u0159\u00ed\u0161t\u011b.

5. PAMET_KAREL/DID/KATA/SITUACNI_ANALYZA
   \u2192 aktu\u00e1ln\u00ed situace K\u00e1ti (terapeutka)

6. PAMET_KAREL/DID/KATA/KARLOVY_POZNATKY
   \u2192 Karlovy post\u0159ehy o K\u00e1t\u011b (spolehlivost, p\u0159\u00edstup k terapii, siln\u00e9/slab\u00e9 str\u00e1nky)

7. PAMET_KAREL/DID/KATA/KAREL
   \u2192 SD\u00cdLEN\u00c1 PAM\u011a\u0164 VZTAHU Karel\u2013K\u00e1\u0165a. Co spolu \u0159e\u0161ili, jak Karel K\u00e1\u0165u vede, jak\u00e9 pokroky,
     co K\u00e1\u0165a o Karlovi \u0159\u00edk\u00e1, jak se jejich spolupr\u00e1ce vyv\u00edj\u00ed.

8. PAMET_KAREL/DID/KATA/VLAKNA_POSLEDNI
   \u2192 SHRNUT\u00cd PR\u00c1V\u011a UZAV\u0158EN\u00c9HO VL\u00c1KNA K\u00e1ti. Kr\u00e1tk\u00fd p\u0159ehled: o \u010dem se mluvilo, jak\u00fd v\u00fdsledek,
     co z\u016fstalo otev\u0159en\u00e9. Max 3-5 v\u011bt.

9. PAMET_KAREL/DID/HANKA/VLAKNA_3DNY
   \u2192 ROLLING SOUHRN posledn\u00edch 3 dn\u016f komunikace s Hani\u010dkou.
     Hlavn\u00ed t\u00e9mata, emo\u010dn\u00ed posuny, otev\u0159en\u00e9 linky, opakuj\u00edc\u00ed se motivy.
     STRU\u010cN\u011aJ\u0160\u00cd a obecn\u011bj\u0161\u00ed ne\u017e VLAKNA_POSLEDNI. Max 5-8 v\u011bt.
     Slou\u017e\u00ed pro rychlou orientaci, ne jako detailn\u00ed archiv.
     Tento blok NAHRAZUJE p\u0159edchoz\u00ed obsah souboru (rolling update, ne append).

10. PAMET_KAREL/DID/KATA/VLAKNA_3DNY
   \u2192 ROLLING SOUHRN posledn\u00edch 3 dn\u016f komunikace s K\u00e1tou.
     Stejn\u00e1 pravidla jako pro Hani\u010dku. Max 5-8 v\u011bt. Rolling update.

11. PAMET_KAREL/DID/KONTEXTY/KDO_JE_KDO
   \u2192 FAKTICK\u00c1 kontextov\u00e1 data: nov\u00e9 osoby, m\u00edsta, instituce, role, okolnosti zm\u00edn\u011bn\u00e9 v konverzaci.
     Pouze fakta (kdo je kdo, kde pracuje, jak\u00fd m\u00e1 vztah k syst\u00e9mu). \u017d\u00e1dn\u00fd intimn\u00ed obsah.

12. KARTA_{JMENO_CASTI}
   \u2192 klinick\u00e9 informace o konkr\u00e9tn\u00ed DID \u010d\u00e1sti (switching, emoce, symptomy, vztahy)
   \u2192 nahra\u010f {JMENO_CASTI} skute\u010dn\u00fdm jm\u00e9nem \u010d\u00e1sti VELK\u00ddMI P\u00cdSMENY (nap\u0159. KARTA_GUSTIK)

KRITICK\u00c1 PRAVIDLA PRO ENTITY (KARTA_*):
- Loc\u00edk / Loc\u00edk je PES, ne DID \u010d\u00e1st. NIKDY nevytv\u00e1\u0159ej KARTA_LOCIK.
- "Zelen\u00e1 vesta" je popis/atribut, ne \u010d\u00e1st. NIKDY nevytv\u00e1\u0159ej KARTA_ZELENA_VESTA.
- Indi\u00e1n je NEPOTVRZENA \u010d\u00e1st. NEVYTVAREJ pro ni KARTA_*. Informace o n\u00ed zaznamenej do KDO_JE_KDO s pozn\u00e1mkou "nepotvrzena \u010d\u00e1st".
- Lobcang, Lobchang = alias pro Lobzhang. Pou\u017eij KARTA_LOBZHANG.
- Diakritika NEROZHODUJE: "Gust\u00edk" = "Gustik" = "GUSTIK".
- Pokud si nejsi JIST\u00dd, \u017ee jm\u00e9no ozna\u010duje potvrzenou DID \u010d\u00e1st, NEPou\u017e\u00edvej KARTA_*.
  M\u00edsto toho informaci zapi\u0161 do KDO_JE_KDO a p\u0159idej pozn\u00e1mku "k ov\u011b\u0159en\u00ed".

OBECN\u00c1 PRAVIDLA:
- Vyt\u011b\u017euj POUZE konkr\u00e9tn\u00ed, nov\u00e9, u\u017eite\u010dn\u00e9 informace
- Ignoruj small talk, pozdravy, opakov\u00e1n\u00ed
- Pokud vl\u00e1kno neobsahuje nic u\u017eite\u010dn\u00e9ho, vra\u0165 pr\u00e1zdn\u00e9 pole
- Nikdy nevym\u00fd\u0161lej informace, kter\u00e9 v konverzaci nejsou
- Ka\u017ed\u00fd blok mus\u00ed m\u00edt jasn\u00fd, stru\u010dn\u00fd content (max 200 slov)
- Content pi\u0161 ve form\u00e1tu vhodn\u00e9m pro append do textov\u00e9ho souboru (datumy, odr\u00e1\u017eky)
- KAREL soubory: pi\u0161 jako vzpom\u00ednku/z\u00e1znam, ne jako profil
- VLAKNA_POSLEDNI: v\u017edy max 3-5 v\u011bt \u2014 stru\u010dn\u00e9 shrnut\u00ed vl\u00e1kna
- VLAKNA_3DNY: max 5-8 v\u011bt \u2014 rolling souhrn 3 dn\u016f, obecn\u011bj\u0161\u00ed ne\u017e POSLEDNI
- KDO_JE_KDO: pouze fakta, \u017e\u00e1dn\u00e9 emoce, \u017e\u00e1dn\u00e9 hodnocen\u00ed
- Pro KA\u017dD\u00c9 zpracovan\u00e9 vl\u00e1kno V\u017dDY vytvo\u0159 blok VLAKNA_POSLEDNI (shrnut\u00ed)
- Pro KA\u017dD\u00c9 zpracovan\u00e9 vl\u00e1kno V\u017dDY vytvo\u0159 blok VLAKNA_3DNY (rolling 3-denn\u00ed souhrn)

Odpov\u011bz POUZE validn\u00edm JSON:
{ "blocks": [ { "target": "...", "content": "...", "reasoning": "..." } ] }

Pokud nen\u00ed co vyt\u011b\u017eit:
{ "blocks": [] }`;

// ─── Types ───────────────────────────────────────────────────────────

interface ThreadRecord {
  id: string;
  messages: { role: string; content: string }[];
  sourceTable: "did_threads" | "karel_hana_conversations";
  subMode: string;
  label: string;
  userId: string;
}

interface SortedBlock {
  target: string;
  content: string;
  reasoning: string;
}

// ─── Main ────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const startMs = Date.now();
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const apiKey = Deno.env.get("LOVABLE_API_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const now = new Date();
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  const log: string[] = [];
  const addLog = (msg: string) => {
    console.log(`[thread-sorter] ${msg}`);
    log.push(msg);
  };

  try {
    // ── 1. Fetch recent threads ──────────────────────────────────────

    const { data: didThreads, error: e1 } = await supabase
      .from("did_threads")
      .select("id, messages, sub_mode, thread_label, entered_name, is_locked, user_id")
      .in("sub_mode", ["mamka", "kata"])
      .eq("is_locked", false)
      .gte("last_activity_at", since)
      .order("last_activity_at", { ascending: false })
      .limit(15);

    if (e1) addLog(`did_threads fetch error: ${e1.message}`);

    const { data: hanaThreads, error: e2 } = await supabase
      .from("karel_hana_conversations")
      .select("id, messages, sub_mode, thread_label, is_locked, user_id")
      .eq("is_locked", false)
      .gte("last_activity_at", since)
      .order("last_activity_at", { ascending: false })
      .limit(15);

    if (e2) addLog(`hana_conversations fetch error: ${e2.message}`);

    const threads: ThreadRecord[] = [];

    for (const t of didThreads ?? []) {
      const msgs = Array.isArray(t.messages) ? t.messages as { role: string; content: string }[] : [];
      if (msgs.filter((m) => m.role === "user").length < 2) continue;
      threads.push({
        id: t.id,
        messages: msgs,
        sourceTable: "did_threads",
        subMode: t.sub_mode ?? "unknown",
        label: t.thread_label || t.entered_name || "bez n\u00e1zvu",
        userId: t.user_id || "8a7816ee-4fd1-43d4-8d83-4230d7517ae1",
      });
    }

    for (const t of hanaThreads ?? []) {
      const msgs = Array.isArray(t.messages) ? t.messages as { role: string; content: string }[] : [];
      if (msgs.filter((m) => m.role === "user").length < 2) continue;
      threads.push({
        id: t.id,
        messages: msgs,
        sourceTable: "karel_hana_conversations",
        subMode: t.sub_mode || "hana_personal",
        label: t.thread_label || "bez n\u00e1zvu",
        userId: t.user_id || "8a7816ee-4fd1-43d4-8d83-4230d7517ae1",
      });
    }

    addLog(`Found ${threads.length} unlocked threads with >=2 user messages (since ${since})`);

    if (threads.length === 0) {
      return new Response(
        JSON.stringify({ ok: true, threads: 0, writes: 0, log }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── 2. Process each thread ───────────────────────────────────────

    let totalWrites = 0;
    let totalLocked = 0;
    let totalEntityBlocked = 0;
    let totalFollowUps = 0;
    const dateLabel = now.toISOString().slice(0, 10);

    for (const thread of threads) {
      const trimmed = thread.messages.slice(-60);
      const transcript = trimmed
        .map((m) => `[${m.role}]: ${(m.content || "").slice(0, 800)}`)
        .join("\n");

      if (transcript.length < 50) {
        addLog(`Skip thread ${thread.id} (too short)`);
        continue;
      }

      const userPrompt = `Zdrojov\u00e9 vl\u00e1kno: "${thread.label}" (typ: ${thread.subMode})
Datum: ${dateLabel}

--- KONVERZACE ---
${transcript}
--- KONEC ---

Rozt\u0159i\u010f obsah do blok\u016f. Pokud vl\u00e1kno neobsahuje nic nov\u00e9ho nebo u\u017eite\u010dn\u00e9ho, vra\u0165 { "blocks": [] }.`;

      const result = await callAiForJson<{ blocks: SortedBlock[] }>({
        systemPrompt: SORTING_SYSTEM_PROMPT,
        userPrompt,
        model: "google/gemini-2.5-flash",
        apiKey,
        requiredKeys: ["blocks"],
        maxRetries: 1,
        fallback: { blocks: [] },
        callerName: "thread-sorter",
      });

      const blocks = result.data?.blocks ?? [];
      addLog(`Thread ${thread.id} ("${thread.label}"): ${blocks.length} blocks extracted`);

      if (blocks.length === 0) {
        await lockThread(supabase, thread, now);
        totalLocked++;
        continue;
      }

      // ── 3. Validate blocks + entity guardrails ───────────────────

      const approvedBlocks: SortedBlock[] = [];

      for (const b of blocks) {
        if (!b.target || !b.content || b.content.length < 10) continue;

        // Non-KARTA targets: standard validation
        if (VALID_TARGETS.includes(b.target)) {
          approvedBlocks.push(b);
          continue;
        }

        // KARTA_* targets: entity guardrail check
        const kartaMatch = b.target.match(/^KARTA_([A-Z_]+)$/);
        if (!kartaMatch) {
          addLog(`  Rejected block with invalid target: ${b.target}`);
          continue;
        }

        const entityName = kartaMatch[1];
        const classification = classifyEntity(entityName);

        switch (classification.classification) {
          case "confirmed_part":
            approvedBlocks.push(b);
            break;

          case "known_alias_of_part":
            // Rewrite target to canonical name
            approvedBlocks.push({
              ...b,
              target: `KARTA_${classification.canonicalName}`,
              reasoning: `${b.reasoning} [alias ${entityName} \u2192 ${classification.canonicalName}]`,
            });
            addLog(`  Alias resolved: ${entityName} \u2192 ${classification.canonicalName}`);
            break;

          case "uncertain_entity":
            // BLOCK the KARTA_* write, create follow-up question
            totalEntityBlocked++;
            addLog(`  BLOCKED KARTA_${entityName}: uncertain entity, creating follow-up`);
            await createEntityFollowUp(supabase, entityName, b.content, thread, dateLabel);
            totalFollowUps++;
            // Redirect useful content to KDO_JE_KDO instead
            approvedBlocks.push({
              ...b,
              target: "PAMET_KAREL/DID/KONTEXTY/KDO_JE_KDO",
              content: `[NEPOTVRZENA CAST - k ov\u011b\u0159en\u00ed] ${entityName}: ${b.content}`,
              reasoning: `${b.reasoning} [entita nepotvrzena, p\u0159esm\u011brov\u00e1no do KDO_JE_KDO]`,
            });
            break;

          case "non_part_context":
            // BLOCK the KARTA_* write, redirect to KDO_JE_KDO
            totalEntityBlocked++;
            addLog(`  BLOCKED KARTA_${entityName}: non-part (${classification.nonPartReason})`);
            approvedBlocks.push({
              ...b,
              target: "PAMET_KAREL/DID/KONTEXTY/KDO_JE_KDO",
              content: `${entityName} (${classification.nonPartReason}): ${b.content}`,
              reasoning: `${b.reasoning} [nen\u00ed DID \u010d\u00e1st, p\u0159esm\u011brov\u00e1no do KDO_JE_KDO]`,
            });
            break;
        }
      }

      // ── 3b. Content-level uncertain entity scan ──────────────────
      // Even when AI correctly avoids KARTA_*, scan all block content
      // for mentions of uncertain entities and create follow-ups.
      const allContent = blocks.map((b) => b.content + " " + b.reasoning).join(" ");
      const followUpEntities = await scanForUncertainEntities(
        supabase, allContent, thread, dateLabel, addLog,
      );
      totalFollowUps += followUpEntities;

      if (approvedBlocks.length === 0) {
        await lockThread(supabase, thread, now);
        totalLocked++;
        continue;
      }

      // ── 4. Write approved blocks ─────────────────────────────────

      const rows = approvedBlocks.map((b) => ({
        target_document: b.target,
        content: REPLACE_TARGETS.includes(b.target)
          ? `--- Rolling souhrn 3 dny (${dateLabel}) ---\n${b.content}`
          : `\n\n--- ${dateLabel} | zdroj: ${thread.subMode}/${thread.label} ---\n${b.content}`,
        write_type: REPLACE_TARGETS.includes(b.target) ? "replace" : "append",
        priority: "normal",
        status: "pending",
        user_id: thread.userId,
      }));

      const { error: writeErr } = await supabase
        .from("did_pending_drive_writes")
        .insert(rows);

      if (writeErr) {
        addLog(`  Write error for thread ${thread.id}: ${writeErr.message}`);
        continue;
      }

      totalWrites += approvedBlocks.length;
      addLog(`  \u2192 ${approvedBlocks.length} pending writes created`);

      await lockThread(supabase, thread, now);
      totalLocked++;
    }

    const elapsed = Date.now() - startMs;
    addLog(`Done in ${elapsed}ms: ${totalWrites} writes, ${totalLocked} locked, ${totalEntityBlocked} entity-blocked, ${totalFollowUps} follow-ups`);

    return new Response(
      JSON.stringify({
        ok: true,
        threads: threads.length,
        writes: totalWrites,
        locked: totalLocked,
        entity_blocked: totalEntityBlocked,
        follow_ups_created: totalFollowUps,
        elapsed_ms: elapsed,
        log,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    addLog(`Fatal error: ${msg}`);
    return new Response(
      JSON.stringify({ ok: false, error: msg, log }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────

async function lockThread(
  supabase: ReturnType<typeof createClient>,
  thread: ThreadRecord,
  now: Date,
) {
  const lockData = {
    is_locked: true,
    locked_at: now.toISOString(),
    archive_status: "locked",
  };

  const { error } = await supabase
    .from(thread.sourceTable)
    .update(lockData)
    .eq("id", thread.id);

  if (error) {
    console.warn(`[thread-sorter] Lock failed for ${thread.id}: ${error.message}`);
  }
}

/**
 * Scan block content for mentions of explicitly uncertain entities
 * and any entity-like names tagged with "k ověření" / "nepotvrzena".
 * Creates follow-up questions with dedup against existing pending ones.
 */
async function scanForUncertainEntities(
  supabase: ReturnType<typeof createClient>,
  allContent: string,
  thread: ThreadRecord,
  dateLabel: string,
  addLog: (msg: string) => void,
): Promise<number> {
  const contentNorm = normalizeName(allContent);
  const detectedEntities: string[] = [];

  // 1. Check explicitly uncertain entity names in content
  for (const unc of EXPLICITLY_UNCERTAIN) {
    if (contentNorm.includes(unc)) {
      detectedEntities.push(unc);
    }
  }

  // 2. Check for AI-generated uncertainty markers in raw content
  const uncertainMarkerRegex = /\[NEPOTVRZENA[^\]]*\]\s*([A-Z\u00c0-\u017e][a-z\u00e0-\u017e]+)/gi;
  const kOvereniRegex = /k\s+ov\u011b\u0159en\u00ed[^.]*?([A-Z\u00c0-\u017e][a-z\u00e0-\u017e]{2,})/gi;
  for (const regex of [uncertainMarkerRegex, kOvereniRegex]) {
    let match;
    while ((match = regex.exec(allContent)) !== null) {
      const name = normalizeName(match[1]);
      if (name.length >= 3 && !detectedEntities.includes(name)) {
        // Skip if it's a confirmed part or non-part
        const cls = classifyEntity(name.toUpperCase());
        if (cls.classification === "uncertain_entity") {
          detectedEntities.push(name);
        }
      }
    }
  }

  if (detectedEntities.length === 0) return 0;

  // 3. Dedup: check existing pending questions for these entities
  const { data: existing } = await supabase
    .from("did_pending_questions")
    .select("subject_id")
    .eq("subject_type", "entity_verification")
    .in("status", ["open", "answered"])
    .in("subject_id", detectedEntities.map((e) => e.toUpperCase()));

  const alreadyAsked = new Set(
    (existing ?? []).map((r: { subject_id: string | null }) =>
      normalizeName(r.subject_id ?? "")
    ),
  );

  let created = 0;
  for (const entity of detectedEntities) {
    if (alreadyAsked.has(entity)) {
      addLog(`  Skip follow-up for "${entity}": already pending`);
      continue;
    }
    await createEntityFollowUp(supabase, entity, allContent, thread, dateLabel);
    addLog(`  Created follow-up for uncertain entity: "${entity}"`);
    created++;
  }
  return created;
}

/**
 * Create a follow-up question in did_pending_questions
 * for uncertain entities that need therapist confirmation.
 */
async function createEntityFollowUp(
  supabase: ReturnType<typeof createClient>,
  entityName: string,
  extractedContent: string,
  thread: ThreadRecord,
  dateLabel: string,
) {
  const displayName = entityName.charAt(0).toUpperCase() + entityName.slice(1);
  const question = `Karel narazil na jm\u00e9no "${displayName}" ve vl\u00e1kn\u011b "${thread.label}" (${dateLabel}). `
    + `Nem\u016f\u017eu ur\u010dit, zda jde o potvrzenou DID \u010d\u00e1st. `
    + `M\u016f\u017ee\u0161 potvrdit, zda "${displayName}" je \u010d\u00e1st syst\u00e9mu, alias existuj\u00edc\u00ed \u010d\u00e1sti, nebo n\u011bco jin\u00e9ho?`;

  const contextSnippet = extractedContent.slice(0, 300);

  const { error } = await supabase
    .from("did_pending_questions")
    .insert({
      question,
      directed_to: thread.subMode === "kata" ? "kata" : "hanka",
      context: `Zdroj: ${thread.subMode}/${thread.label}\nObsah: ${contextSnippet}`,
      subject_type: "entity_verification",
      subject_id: entityName.toUpperCase(),
      status: "open",
      blocking: "card_creation",
    });

  if (error) {
    console.warn(`[thread-sorter] Follow-up question insert failed: ${error.message}`);
  }
}

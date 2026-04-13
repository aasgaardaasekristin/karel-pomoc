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
import { encodeGovernedWrite } from "../_shared/documentWriteEnvelope.ts";
import {
  segmentMessageIntoTopics,
  buildMessageClusters,
  type TopicSegment,
  type SegmentType,
} from "../_shared/topicSegmentation.ts";

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

import {
  CLASSIFIER_SYSTEM_PROMPT,
  type ClassifiedItem,
  type InformationSource,
  type InfoClass,
  resolveTarget,
  applySafetyFilter,
  isWriteAllowed,
} from "../_shared/informationClassifier.ts";
import { executeClassifiedItems } from "../_shared/classifiedActionExecutor.ts";
import {
  normalizeSignal,
  canWriteToPartCard,
  type SourceDomain,
} from "../_shared/signalNormalization.ts";

/**
 * Extended system prompt: combines legacy document-target sorting
 * WITH the new FÁZE 2 classification model.
 * 
 * The AI returns BOTH legacy "blocks" (for backward compat with entity guardrails)
 * AND new "classified_items" for action generation.
 */
const SORTING_SYSTEM_PROMPT = `Jsi Karel \u2013 supervizor a analytik DID terapeutick\u00e9ho syst\u00e9mu.

Dostane\u0161 konverza\u010dn\u00ed vl\u00e1kno (zpr\u00e1vy mezi u\u017eivatelem a Karlem).
Tv\u016fj \u00fakol: vyt\u011b\u017eit kl\u00ed\u010dov\u00e9 informace a:
A) Rozt\u0159\u00eddit je do blok\u016f podle c\u00edlov\u00e9ho dokumentu (legacy routing)
B) Klasifikovat ka\u017edou informaci podle jej\u00ed povahy (information classifier)

==== \u010c\u00c1ST A: BLOKY (legacy) ====

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
   \u2192 SD\u00cdLEN\u00c1 PAM\u011a\u0164 VZTAHU Karel\u2013Hani\u010dka.
     SEM PAT\u0158\u00cd POUZE:
     - spole\u010dn\u00e9 vzpom\u00ednky a pro\u017eitky
     - symbolick\u00e1 m\u00edsta, motivy, vtipy
     - co Hani\u010dka \u0159ekla o Karlovi / o jejich vztahu
     - \u017eiv\u00e9 vztahov\u00e9 posuny
     SEM NEPAT\u0158\u00cd: obecn\u00fd emo\u010dn\u00ed stav, pracovn\u00ed v\u011bci, klinick\u00e9 DID pozn\u00e1mky, provoz.
     FORM\u00c1T: max 3 v\u011bty. V\u011bcn\u011b. NIKDY nevym\u00fd\u0161lej.

4. PAMET_KAREL/DID/HANKA/VLAKNA_POSLEDNI
   \u2192 Shrnut\u00ed pr\u00e1v\u011b uzav\u0159en\u00e9ho vl\u00e1kna Hanky. Max 3-5 v\u011bt.

5. PAMET_KAREL/DID/KATA/SITUACNI_ANALYZA
   \u2192 aktu\u00e1ln\u00ed situace K\u00e1ti

6. PAMET_KAREL/DID/KATA/KARLOVY_POZNATKY
   \u2192 Karlovy post\u0159ehy o K\u00e1t\u011b

7. PAMET_KAREL/DID/KATA/KAREL
   \u2192 SD\u00cdLEN\u00c1 PAM\u011a\u0164 VZTAHU Karel\u2013K\u00e1\u0165a. Stejn\u00e1 pravidla. Max 3 v\u011bty.

8. PAMET_KAREL/DID/KATA/VLAKNA_POSLEDNI
   \u2192 Shrnut\u00ed pr\u00e1v\u011b uzav\u0159en\u00e9ho vl\u00e1kna K\u00e1ti. Max 3-5 v\u011bt.

9. PAMET_KAREL/DID/HANKA/VLAKNA_3DNY
   \u2192 Rolling souhrn 3 dn\u016f Hanky. Max 5-8 v\u011bt. REPLACE.

10. PAMET_KAREL/DID/KATA/VLAKNA_3DNY
   \u2192 Rolling souhrn 3 dn\u016f K\u00e1ty. Max 5-8 v\u011bt. REPLACE.

11. PAMET_KAREL/DID/KONTEXTY/KDO_JE_KDO
   \u2192 Faktick\u00e1 data: osoby, m\u00edsta, instituce, role.

12. KARTA_{JMENO_CASTI}
   \u2192 Klinick\u00e9 informace o DID \u010d\u00e1sti. Velk\u00e1 p\u00edsmena.

ENTITY PRAVIDLA:
- Loc\u00edk = PES, ne \u010d\u00e1st.
- Lobcang/Lobchang = alias pro Lobzhang.
- Indi\u00e1n = nepotvrzena \u010d\u00e1st \u2192 KDO_JE_KDO.
- Pokud si nejsi jist\u00fd \u2192 KDO_JE_KDO s pozn\u00e1mkou "k ov\u011b\u0159en\u00ed".

==== \u010c\u00c1ST B: KLASIFIKACE (nov\u00e9) ====

Pro ka\u017edou vy\u0165\u011b\u017eenou informaci nav\u00edc ur\u010di:

- "info_class": memory_private | daily_operational | strategic_outlook | long_term_trajectory | part_clinical_truth | dashboard_signal | task_generation | session_plan_generation | pending_question_generation | meeting_trigger
- "privacy_level": public | team_only | private | abstracted
- "evidence_level": D1 | D2 | D3 | I1 | H1
- "operational_implication": pokud privacy je private/abstracted, bezpe\u010dn\u00fd z\u00e1v\u011br (jinak null)
- "generated_actions": pole akc\u00ed:
  - action_type: create_task | create_session_plan | create_pending_question | trigger_meeting | update_part_card | crisis_escalation
  - assigned_to: hanka | kata | karel | both
  - description: co p\u0159esn\u011b
  - priority: urgent | high | normal | low
  - goal_type: diagnostic | stabilization | relational | risk | logistic (nebo null)
  - part_name: jm\u00e9no \u010d\u00e1sti (nebo null)

PRAVIDLA:
- Hana/osobn\u00ed obsah: NIKDY do UI. Jen abstrahovan\u00e9 opera\u010dn\u00ed z\u00e1v\u011bry.
- Max 3 \u00fakoly z jednoho vl\u00e1kna.
- Session plan jen p\u0159i jasn\u00e9m terapeutick\u00e9m d\u016fvodu.
- Meeting trigger jen p\u0159i z\u00e1sadn\u00edm rozporu nebo krizov\u00e9m rozhodnut\u00ed.
- Negeneeruj akce pro ban\u00e1ln\u00ed obsah.

OBECN\u00c1 PRAVIDLA:
- Pouze konkr\u00e9tn\u00ed, nov\u00e9, u\u017eite\u010dn\u00e9 informace
- Ignoruj small talk, opakov\u00e1n\u00ed
- Nikdy nevym\u00fd\u0161lej
- Max 200 slov na blok

Odpov\u011bz POUZE validn\u00edm JSON:
{
  "blocks": [ { "target": "...", "content": "...", "reasoning": "..." } ],
  "classified_items": [
    {
      "info_class": "...",
      "privacy_level": "...",
      "evidence_level": "...",
      "raw_content": "...",
      "reasoning": "...",
      "operational_implication": null,
      "part_name": null,
      "therapist": null,
      "generated_actions": []
    }
  ]
}

Pokud nen\u00ed co vyt\u011b\u017eit:
{ "blocks": [], "classified_items": [] }`;

// ─── Hana alias normalization ────────────────────────────────────────
const HANA_PERSONAL_ALIASES = ["personal", "hana_personal", "osobní", "hana", "osobni"];
function canonicalizeHanaSubMode(raw: string | null | undefined): string {
  const lower = (raw || "").toLowerCase().trim();
  if (HANA_PERSONAL_ALIASES.includes(lower)) return "hana_personal";
  return lower || "hana_personal";
}

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
        subMode: canonicalizeHanaSubMode(t.sub_mode),
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

      // ── MEZIFÁZE: Per-message topic segmentation ──
      // Build message clusters (1-3 consecutive user messages, max 5min gap)
      // then segment each cluster into topic segments BEFORE AI classification.
      // This prevents the AI from cross-contaminating unrelated topics.
      const clusters = buildMessageClusters(
        trimmed.map(m => ({ role: m.role, content: m.content || "" })),
        3,
        5 * 60 * 1000,
      );

      // Pre-segment user messages for metadata annotation
      const allSegments: TopicSegment[] = [];
      for (const cluster of clusters) {
        const segs = segmentMessageIntoTopics(cluster.text, thread.id, cluster.messageIds[0] || null);
        allSegments.push(...segs);
      }

      // Build transcript with segment annotations for AI context
      const transcript = trimmed
        .map((m) => `[${m.role}]: ${(m.content || "").slice(0, 800)}`)
        .join("\n");

      if (transcript.length < 50) {
        addLog(`Skip thread ${thread.id} (too short)`);
        continue;
      }

      // Add segment summary to help AI understand topic boundaries
      const segmentHint = allSegments.length > 0
        ? `\n\nPŘED-SEGMENTACE (topic decomposition):\n` +
          allSegments.map((s, i) => `  [${i+1}] ${s.segment_type} (conf=${s.confidence.toFixed(2)}${s.part_name ? `, část=${s.part_name}` : ""}): "${s.raw_segment.slice(0, 80)}..."`).join("\n") +
          `\n\nPOUŽIJ tuto před-segmentaci jako vodítko. Nemíchej osobní obsah s klinickým. Každý segment zpracuj zvlášť.\n`
        : "";

      const userPrompt = `Zdrojov\u00e9 vl\u00e1kno: "${thread.label}" (typ: ${thread.subMode})
Datum: ${dateLabel}
${segmentHint}
--- KONVERZACE ---
${transcript}
--- KONEC ---

Rozt\u0159i\u010f obsah do blok\u016f A klasifikuj ka\u017edou informaci. Pokud vl\u00e1kno neobsahuje nic nov\u00e9ho, vra\u0165 { "blocks": [], "classified_items": [] }.`;

      const result = await callAiForJson<{ blocks: SortedBlock[]; classified_items: any[] }>({
        systemPrompt: SORTING_SYSTEM_PROMPT,
        userPrompt,
        model: "google/gemini-2.5-flash",
        apiKey,
        requiredKeys: ["blocks"],
        maxRetries: 1,
        fallback: { blocks: [], classified_items: [] },
        callerName: "thread-sorter",
      });

      const blocks = result.data?.blocks ?? [];
      const rawClassified = result.data?.classified_items ?? [];
      addLog(`Thread ${thread.id} ("${thread.label}"): ${blocks.length} blocks, ${rawClassified.length} classified items`);

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

      // ── 4. Write approved blocks (governed envelope) ─────────────

      const rows = approvedBlocks.map((b) => {
        const isReplace = REPLACE_TARGETS.includes(b.target);
        const rawContent = isReplace
          ? `--- Rolling souhrn 3 dny (${dateLabel}) ---\n${b.content}`
          : `\n\n--- ${dateLabel} | zdroj: ${thread.subMode}/${thread.label} ---\n${b.content}`;

        // Derive subject_type from target — consistent with provenance model
        const subjectType = b.target.startsWith("KARTA_") ? "part"
          : b.target.includes("/KONTEXTY/") ? "family_context"
          : (b.target.includes("/HANKA/") || b.target.includes("/KATA/")) ? "therapist"
          : "system";
        const subjectId = b.target.startsWith("KARTA_")
          ? b.target.replace("KARTA_", "").toLowerCase()
          : b.target.includes("/HANKA/") ? "hanka"
          : b.target.includes("/KATA/") ? "kata"
          : (thread.subMode || "general");

        // Derive content_type from block type / target
        const contentType = b.target.startsWith("KARTA_") ? "session_result"
          : b.target.includes("SITUACNI_ANALYZA") ? "daily_plan"
          : b.target.includes("KARLOVY_POZNATKY") ? "therapist_memory_note"
          : b.target.includes("KDO_JE_KDO") ? "general_classification"
          : "general_classification";

        return {
          target_document: b.target,
          content: encodeGovernedWrite(rawContent, {
            source_type: "thread-sorter",
            source_id: thread.id,
            content_type: contentType,
            subject_type: subjectType,
            subject_id: subjectId,
          }),
          write_type: isReplace ? "replace" : "append",
          priority: "normal",
          status: "pending",
          user_id: thread.userId,
        };
      });

      const { error: writeErr } = await supabase
        .from("did_pending_drive_writes")
        .insert(rows);

      if (writeErr) {
        addLog(`  Write error for thread ${thread.id}: ${writeErr.message}`);
        continue;
      }

      totalWrites += approvedBlocks.length;
      addLog(`  \u2192 ${approvedBlocks.length} pending writes created`);

      // ── 5. Execute classified items (FÁZE 2 + 2.5 normalization) ──
      if (rawClassified.length > 0) {
        const sourceMap: Record<string, InformationSource> = {
          mamka: "did_therapist_hanka",
          kata: "did_therapist_kata",
          hana_personal: "hana_personal",
        };
        const domainMap: Record<string, SourceDomain> = {
          mamka: "therapist_hanka",
          kata: "therapist_kata",
          hana_personal: "hana_personal",
        };

        const classifiedItems: ClassifiedItem[] = rawClassified
          .filter((ci: any) => ci.info_class && ci.raw_content)
          .map((ci: any, idx: number) => {
            // FÁZE 2.5: Normalize each classified item through provenance layer
            const signal = normalizeSignal({
              raw_content: ci.raw_content,
              source_domain: domainMap[thread.subMode] || "part_conversation",
              source_id: thread.id,
              therapist: ci.therapist || undefined,
              part_name: ci.part_name || undefined,
            });

            // Apply normalization gates:
            // - If AI classified as part_clinical_truth but normalization says no → downgrade
            let finalInfoClass = ci.info_class as InfoClass;
            if (finalInfoClass === "part_clinical_truth" && !canWriteToPartCard(signal)) {
              console.warn(`[thread-sorter] Normalization blocked part_clinical_truth for ${ci.part_name} (confidence=${signal.confidence}, evidence=${signal.evidence_strength})`);
              finalInfoClass = "memory_private"; // Downgrade to private memory
            }

            return {
              id: `${thread.id}-ci-${idx}`,
              source: sourceMap[thread.subMode] || "did_part_conversation" as InformationSource,
              source_id: thread.id,
              info_class: finalInfoClass,
              privacy_level: ci.privacy_level || "team_only",
              raw_content: ci.raw_content,
              reasoning: ci.reasoning || "",
              operational_implication: ci.operational_implication || signal.derived_operational_implication || undefined,
              part_name: ci.part_name || signal.part_name || undefined,
              therapist: ci.therapist || signal.therapist || undefined,
              evidence_level: ci.evidence_level || "I1",
              generated_actions: Array.isArray(ci.generated_actions) ? ci.generated_actions : [],
            };
          });

        if (classifiedItems.length > 0) {
          const execResult = await executeClassifiedItems(
            supabase, classifiedItems, dateLabel, "thread-sorter",
          );
          addLog(`  FÁZE2.5: ${execResult.tasks_created} tasks, ${execResult.session_plans_created} sessions, ${execResult.questions_created} questions, ${execResult.meeting_triggers} meetings, ${execResult.privacy_blocked} blocked, dedup=${execResult.dedup_skipped}`);
        }
      }

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

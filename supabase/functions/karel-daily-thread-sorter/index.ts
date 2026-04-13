/**
 * karel-daily-thread-sorter — FÁZE 2.6
 *
 * Denní třídicí pass: načte vlákna za 24h z did_threads (mamka/kata)
 * a karel_hana_conversations (hana_personal), AI je roztřídí do bloků
 * a výsledky zapíše přímo do did_pending_drive_writes.
 * Po zpracování vlákno zamkne (is_locked + archive_status).
 *
 * FÁZE 2.6 CHANGES:
 * - Removed hardcoded CONFIRMED_PARTS, ALIAS_MAP, NON_PART_ENTITIES, EXPLICITLY_UNCERTAIN
 * - Entity classification now uses entityRegistry + entityResolution
 * - Uncertain entities handled by entityWatchdog
 * - 01_INDEX is the sole authority for DID part confirmation
 */

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { callAiForJson } from "../_shared/aiCallWrapper.ts";
import { encodeGovernedWrite } from "../_shared/documentWriteEnvelope.ts";
import {
  segmentMessageIntoTopics,
  buildMessageClusters,
  type TopicSegment,
  type SegmentType,
} from "../_shared/topicSegmentation.ts";
import { loadEntityRegistry, type EntityRegistry } from "../_shared/entityRegistry.ts";
import { resolveEntity, toLegacyClassification } from "../_shared/entityResolution.ts";
import { handleUncertainEntity, type EntitySourceContext } from "../_shared/entityWatchdog.ts";

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
- Pokud si nejsi jist\u00fd, zda jm\u00e9no je DID \u010d\u00e1st \u2192 KDO_JE_KDO s pozn\u00e1mkou "k ov\u011b\u0159en\u00ed".
- Nikdy nevytv\u00e1\u0159ej KARTA_* pro jm\u00e9na, kter\u00e1 neznaj\u00ed terapeuti.

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
  messages: { role: string; content: string; id?: string; timestamp?: string }[];
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

interface GovernedSortedBlock extends SortedBlock {
  segmentId?: string;
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
    // ── 0. Load entity registry (01_INDEX = sole authority) ──────────
    // Try to get Drive token for authoritative registry load
    let driveToken: string | null = null;
    try {
      const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
      const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
      const refreshToken = Deno.env.get("GOOGLE_REFRESH_TOKEN");
      if (clientId && clientSecret && refreshToken) {
        const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: refreshToken,
            grant_type: "refresh_token",
          }),
        });
        if (tokenRes.ok) {
          const tokenData = await tokenRes.json();
          driveToken = tokenData.access_token || null;
        }
      }
    } catch (e) {
      addLog(`Drive token refresh failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    const registry = await loadEntityRegistry(supabase, driveToken);
    addLog(`Entity registry loaded: indexAvailable=${registry.indexAvailable}, entries=${registry.entries.length}`);

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
      const approvedBlocksCollector = {
        items: [] as GovernedSortedBlock[],
        flush() {
          const result = [...this.items];
          this.items = [] as GovernedSortedBlock[];
          return result;
        },
      };
      const classifiedCollector = {
        items: [] as any[],
        flush() {
          const result = [...this.items];
          this.items = [] as any[];
          return result;
        },
      };

      const trimmed = thread.messages.slice(-60);

      // ── MEZIFÁZE: Per-segment AI processing ──
      const clusters = buildMessageClusters(
        trimmed.map((m) => ({
          role: m.role,
          content: m.content || "",
          id: m.id,
          timestamp: m.timestamp,
        })),
        3,
        5 * 60 * 1000,
      );

      const allSegments: TopicSegment[] = [];
      for (const cluster of clusters) {
        const segs = segmentMessageIntoTopics(cluster.text, thread.id, cluster.messageIds[0] || null, registry);
        allSegments.push(...segs);
      }

      const worthySegments = allSegments.filter(s => s.segment_type !== "background_noise");

      if (worthySegments.length === 0) {
        addLog(`Thread ${thread.id} ("${thread.label}"): no worthy segments after segmentation`);
        await lockThread(supabase, thread, now);
        totalLocked++;
        continue;
      }

      // ── 3. Per-segment AI calls ──
      addLog(`Thread ${thread.id} ("${thread.label}"): ${worthySegments.length} segments to process individually`);

      for (const segment of worthySegments) {
        const segmentContext = buildSegmentContext(trimmed, segment);

        const segmentPrompt = `Zdrojové vlákno: "${thread.label}" (typ: ${thread.subMode})
Datum: ${dateLabel}
Typ segmentu: ${segment.segment_type} (${segment.safe_label})
${segment.part_name ? `Detekovaná část (kandidát): ${segment.part_name}` : ""}
${segment.therapist ? `Terapeut: ${segment.therapist}` : ""}

--- SEGMENT ---
${segment.raw_segment.slice(0, 1500)}
--- KONEC SEGMENTU ---

${segmentContext ? `--- KONTEXT (okolní odpovědi) ---\n${segmentContext}\n--- KONEC KONTEXTU ---\n` : ""}
DŮLEŽITÉ: Klasifikuj POUZE obsah tohoto segmentu. Nemíchej s jinými tématy.
Roztřiď do bloků A klasifikuj. Pokud segment neobsahuje nic nového, vrať { "blocks": [], "classified_items": [] }.`;

        const segResult = await callAiForJson<{ blocks: SortedBlock[]; classified_items: any[] }>({
          systemPrompt: SORTING_SYSTEM_PROMPT,
          userPrompt: segmentPrompt,
          model: "google/gemini-2.5-flash",
          apiKey,
          requiredKeys: ["blocks"],
          maxRetries: 1,
          fallback: { blocks: [], classified_items: [] },
          callerName: "thread-sorter",
        });

        const segBlocks = segResult.data?.blocks ?? [];
        const segClassified = segResult.data?.classified_items ?? [];

        if (segBlocks.length > 0 || segClassified.length > 0) {
          addLog(`  Segment [${segment.segment_type}] (id=${segment.id}): ${segBlocks.length} blocks, ${segClassified.length} classified`);
        }

        await processBlocksEntityGuardrails(
          segBlocks,
          approvedBlocksCollector,
          addLog,
          supabase,
          thread,
          dateLabel,
          segment,
          registry,
        );
        accumulateClassified(segClassified, classifiedCollector, thread, segment);
      }

      // ── Flush accumulated results for this thread ──
      const approvedBlocks = approvedBlocksCollector.flush();
      const allClassifiedItems = classifiedCollector.flush();

      addLog(`Thread ${thread.id}: total ${approvedBlocks.length} approved blocks, ${allClassifiedItems.length} classified items`);

      if (approvedBlocks.length === 0 && allClassifiedItems.length === 0) {
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

        const subjectType = b.target.startsWith("KARTA_") ? "part"
          : b.target.includes("/KONTEXTY/") ? "family_context"
          : (b.target.includes("/HANKA/") || b.target.includes("/KATA/")) ? "therapist"
          : "system";
        const subjectId = b.target.startsWith("KARTA_")
          ? b.target.replace("KARTA_", "").toLowerCase()
          : b.target.includes("/HANKA/") ? "hanka"
          : b.target.includes("/KATA/") ? "kata"
          : (thread.subMode || "general");

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
              segment_id: b.segmentId,
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

      if (rows.length > 0) {
        const { error: writeErr } = await supabase
          .from("did_pending_drive_writes")
          .insert(rows);

        if (writeErr) {
          addLog(`  Write error for thread ${thread.id}: ${writeErr.message}`);
        } else {
          totalWrites += rows.length;
          addLog(`  → ${rows.length} pending writes created`);
        }
      }

      // ── 5. Execute classified items (FÁZE 2 + 2.5 normalization) ──
      if (allClassifiedItems.length > 0) {
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

        const normalizedItems: ClassifiedItem[] = allClassifiedItems
          .filter((ci: any) => ci.info_class && ci.raw_content)
          .map((ci: any, idx: number) => {
            const signal = normalizeSignal({
              raw_content: ci.raw_content,
              source_domain: domainMap[thread.subMode] || "part_conversation",
              source_id: thread.id,
              therapist: ci.therapist || undefined,
              part_name: ci.part_name || undefined,
              registry,
            });

            let finalInfoClass = ci.info_class as InfoClass;
            if (finalInfoClass === "part_clinical_truth" && !canWriteToPartCard(signal)) {
              console.warn(`[thread-sorter] Normalization blocked part_clinical_truth for ${ci.part_name} (confidence=${signal.confidence}, evidence=${signal.evidence_strength})`);
              finalInfoClass = "memory_private";
            }

            return {
              id: ci._id || `${thread.id}-ci-${idx}`,
              source: sourceMap[thread.subMode] || "did_part_conversation" as InformationSource,
              source_id: thread.id,
              segment_id: ci._segment_id || undefined,
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

        if (normalizedItems.length > 0) {
          const execResult = await executeClassifiedItems(
            supabase, normalizedItems, dateLabel, "thread-sorter",
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

// ─── Helper: process blocks through entity guardrails ────────────────

async function processBlocksEntityGuardrails(
  blocks: SortedBlock[],
  collector: { items: GovernedSortedBlock[] },
  addLog: (msg: string) => void,
  supabase: SupabaseClient,
  thread: ThreadRecord,
  dateLabel: string,
  segment: TopicSegment | null,
  registry: EntityRegistry,
) {
  for (const b of blocks) {
    if (!b.target || !b.content || b.content.length < 10) continue;

    if (VALID_TARGETS.includes(b.target)) {
      collector.items.push({ ...b, segmentId: segment?.id });
      continue;
    }

    const kartaMatch = b.target.match(/^KARTA_([A-Z_]+)$/);
    if (!kartaMatch) {
      addLog(`  Rejected block with invalid target: ${b.target}`);
      continue;
    }

    const entityName = kartaMatch[1];
    // FÁZE 2.6: Use entityResolution instead of hardcoded classifyEntity()
    const resolved = resolveEntity(entityName, registry);
    const legacy = toLegacyClassification(resolved);

    switch (legacy.classification) {
      case "confirmed_part":
        collector.items.push({ ...b, segmentId: segment?.id });
        break;

      case "known_alias_of_part":
        collector.items.push({
          ...b,
          segmentId: segment?.id,
          target: `KARTA_${legacy.canonicalName}`,
          reasoning: `${b.reasoning} [alias ${entityName} → ${legacy.canonicalName}]`,
        });
        addLog(`  Alias resolved: ${entityName} → ${legacy.canonicalName}`);
        break;

      case "uncertain_entity": {
        addLog(`  BLOCKED KARTA_${entityName}: uncertain entity (${resolved.reasons.join("; ")})`);
        // FÁZE 2.6: Use entityWatchdog instead of local createEntityFollowUp
        const watchdogCtx: EntitySourceContext = {
          thread_id: thread.id,
          thread_label: thread.label,
          sub_mode: thread.subMode,
          date_label: dateLabel,
          content_excerpt: b.content,
          user_id: thread.userId,
        };
        await handleUncertainEntity(supabase, resolved, watchdogCtx);
        // Redirect to KDO_JE_KDO
        collector.items.push({
          ...b,
          segmentId: segment?.id,
          target: "PAMET_KAREL/DID/KONTEXTY/KDO_JE_KDO",
          content: `[NEPOTVRZENA CAST - k ověření] ${entityName}: ${b.content}`,
          reasoning: `${b.reasoning} [entita nepotvrzena, přesměrováno do KDO_JE_KDO]`,
        });
        break;
      }

      case "non_part_context":
        addLog(`  BLOCKED KARTA_${entityName}: non-part (${legacy.nonPartReason})`);
        collector.items.push({
          ...b,
          segmentId: segment?.id,
          target: "PAMET_KAREL/DID/KONTEXTY/KDO_JE_KDO",
          content: `${entityName} (${legacy.nonPartReason}): ${b.content}`,
          reasoning: `${b.reasoning} [není DID část, přesměrováno do KDO_JE_KDO]`,
        });
        break;
    }
  }
}

// ─── Helper: accumulate classified items with segment provenance ─────

function accumulateClassified(
  rawClassified: any[],
  collector: { items: any[] },
  thread: ThreadRecord,
  segment: TopicSegment | null,
) {
  for (let idx = 0; idx < rawClassified.length; idx++) {
    const ci = rawClassified[idx];
    collector.items.push({
      ...ci,
      _id: segment
        ? `${thread.id}-seg-${segment.id}-ci-${idx}`
        : `${thread.id}-ci-${idx}`,
      _segment_id: segment?.id || undefined,
    });
  }
}

// ─── Helper: build minimal context around a segment ──────────────────

function buildSegmentContext(
  messages: { role: string; content: string }[],
  segment: TopicSegment,
): string {
  const segLower = segment.raw_segment.toLowerCase().slice(0, 100);
  const contextParts: string[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "user" && msg.content.toLowerCase().includes(segLower.slice(0, 40))) {
      if (i > 0 && messages[i - 1].role === "assistant") {
        contextParts.push(`[assistant]: ${messages[i - 1].content.slice(0, 300)}`);
      }
      if (i + 1 < messages.length && messages[i + 1].role === "assistant") {
        contextParts.push(`[assistant]: ${messages[i + 1].content.slice(0, 300)}`);
      }
      break;
    }
  }

  return contextParts.join("\n");
}

// ─── Helpers ─────────────────────────────────────────────────────────

async function lockThread(
  supabase: SupabaseClient,
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

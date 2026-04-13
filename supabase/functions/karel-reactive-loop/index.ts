/**
 * karel-reactive-loop — FÁZE 2.6
 *
 * Reactive processing loop: scans recent messages, tasks, meetings,
 * questions, and conversations every 20 minutes.
 *
 * FÁZE 2.6 CHANGES:
 * - Removed hardcoded DID_KEYWORDS part name list
 * - Removed hardcoded detectPartMention() list
 * - Uses entityRegistry + resolveEntity for part detection
 * - Part card writes gated by resolveEntity().can_write_existing_card
 * - Session-oriented tasks/questions gated by can_be_session_target
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  isWriteAllowed,
  applySafetyFilter,
  type ClassifiedItem,
} from "../_shared/informationClassifier.ts";
import { encodeGovernedWrite } from "../_shared/documentWriteEnvelope.ts";
import {
  normalizeSignal,
  canWriteToOperationalLayer,
  canWriteToPartCard,
  detectPartInText,
  type SourceDomain,
} from "../_shared/signalNormalization.ts";
import {
  segmentMessageIntoTopics,
  buildMessageClusters,
  type TopicSegment,
} from "../_shared/topicSegmentation.ts";
import { loadEntityRegistry, type EntityRegistry } from "../_shared/entityRegistry.ts";
import { resolveEntity } from "../_shared/entityResolution.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const COMMITMENT_KEYWORDS = [
  "zavolám", "udělám", "zajistím", "připravím", "pošlu", "zkusím",
  "slibuju", "domluvím", "naplánuji", "zorganizuji",
];

/**
 * Clinical/DID keywords for filtering relevant messages.
 * Part names are NO LONGER hardcoded here — detection uses registry.
 */
const CLINICAL_KEYWORDS = [
  "část", "alter", "sezení", "terapie", "disociace", "trauma",
  "přepnutí", "symptom", "ochránce", "flashback", "regulace",
  "grounding", "stabilizace", "krize", "trigger",
];

const STRESS_KEYWORDS = [
  "vyčerpaná", "unavená", "nestíhám", "kapacita", "přetížená", "stres",
  "nemůžu", "zátěž", "potřebuju pauzu", "nespala", "bolest", "úzkost",
];

const DID_OWNER_ID = "8a7816ee-4fd1-43d4-8d83-4230d7517ae1";

function detectCrisis(text: string): boolean {
  const keywords = ["krize","krizový","sebevražda","sebepoškozování","disociace",
    "útěk","nebezpečí","akutní"];
  return keywords.some(kw => text.toLowerCase().includes(kw.toLowerCase()));
}

function normalizeTherapist(raw: string): "hanka" | "kata" {
  const lower = (raw || "").toLowerCase().trim();
  if (["kata","káťa","katka"].includes(lower)) return "kata";
  return "hanka";
}

/**
 * Detect DID part mention in text using EntityRegistry.
 * Falls back to candidate signal detection if no registry.
 *
 * IMPORTANT: Returns a candidate name. Caller MUST use resolveEntity()
 * for identity confirmation before card operations.
 */
function detectPartMention(text: string, registry?: EntityRegistry | null): string | null {
  return detectPartInText(text, registry);
}

/**
 * Check if a message is DID-relevant using clinical keywords + registry names.
 */
function isDIDRelevant(content: string, registry?: EntityRegistry | null): boolean {
  const lower = content.toLowerCase();
  // Check clinical keywords
  if (CLINICAL_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()))) return true;
  // Check if any confirmed registry part name is mentioned
  // getAllKnownNames() already excludes unconfirmed_cache_only entries
  if (registry) {
    const allNames = registry.getAllKnownNames();
    if (allNames.some(name => content.includes(name))) return true;
  }
  return false;
}

/**
 * Derive a safe clinical implication from a private signal mentioning a part.
 */
function deriveClinicalImplicationFromPrivateSignal(partName: string, rawContent: string): string {
  const lower = rawContent.toLowerCase();
  const themes: string[] = [];
  if (["strach", "bojí", "úzkost", "panika", "děs"].some(w => lower.includes(w)))
    themes.push("zvýšená úzkostná reaktivita");
  if (["vztek", "agrese", "naštvaný", "zuří", "zuřivost"].some(w => lower.includes(w)))
    themes.push("signály zvýšené afektivní tenze");
  if (["smutek", "pláče", "brečí", "stýská", "ztráta"].some(w => lower.includes(w)))
    themes.push("emocionální zranitelnost — smutek/ztráta");
  if (["odmítnutí", "nechce", "odmítá", "zavírá", "stáhl"].some(w => lower.includes(w)))
    themes.push("signál stažení / odmítání kontaktu");
  if (["přepnutí", "switch", "disociace", "ztratil", "zmizel"].some(w => lower.includes(w)))
    themes.push("možný switching / disociativní signál");
  if (["důvěra", "věří", "nevěří", "podezřívá"].some(w => lower.includes(w)))
    themes.push("signál ve vztahové důvěře");
  if (["spánek", "nespí", "noční", "budí se", "děsivý sen"].some(w => lower.includes(w)))
    themes.push("narušení spánkového vzorce");
  if (themes.length === 0) {
    themes.push("nespecifikovaný signál vyžadující ověření v přímém kontaktu");
  }
  const today = new Date().toISOString().split("T")[0];
  return `[${today}] Odvozená klinická implikace pro ${partName}: ${themes.join("; ")}. Doporučeno ověřit v dalším sezení.`;
}

function generateReactiveResponse(taskText: string, isCrisis: boolean): string {
  if (isCrisis) return `Karel zaznamenal krizovou informaci a aktualizuje plán. ${taskText.slice(0,150)}`;
  return `Karel přijal informaci a zapracovává ji do plánu. ${taskText.slice(0,150)}`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const since = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  let statsA = 0, statsB = 0, statsC = 0, statsD = 0, statsAgenda = 0, statsExpired = 0;

  console.log('[REACTIVE-LOOP] Starting run at', new Date().toISOString());

  try {
    // ── 0. Load entity registry (01_INDEX = sole authority) ──
    // Reactive loop runs frequently — use DB cache as fallback (no Drive token refresh here)
    const registry = await loadEntityRegistry(sb);
    console.log(`[REACTIVE-LOOP] Registry: indexAvailable=${registry.indexAvailable}, entries=${registry.entries.length}`);

    // ═══ KROK 1 — Načtení nových zpráv z 5 zdrojů ═══

    const { data: manualTasks } = await sb
      .from("did_therapist_tasks")
      .select("*")
      .eq("source", "therapist_manual")
      .gt("created_at", since)
      .eq("processed_by_reactive", false);

    const { data: recentMeetings } = await sb
      .from("did_meetings")
      .select("id, topic, messages, last_reactive_message_count, updated_at")
      .gt("updated_at", since);

    const { data: answeredQuestions } = await sb
      .from("did_pending_questions")
      .select("*")
      .eq("status", "answered")
      .gt("answered_at", since)
      .eq("processed_by_reactive", false);

    const { data: didConvs } = await sb
      .from("did_conversations")
      .select("id, messages, sub_mode, updated_at")
      .gt("updated_at", since)
      .in("sub_mode", ["general", "mamka", "kata"]);

    const { data: hanaConvs } = await sb
      .from("karel_hana_conversations")
      .select("id, messages, sub_mode, updated_at")
      .gt("updated_at", since)
      .eq("is_locked", false);

    const HANA_PERSONAL_ALIASES = ["personal", "hana_personal", "osobní", "hana"];
    function canonicalizeHanaMode(raw: string | null): string {
      const lower = (raw || "").toLowerCase().trim();
      if (HANA_PERSONAL_ALIASES.includes(lower)) return "hana_personal";
      return lower || "hana_personal";
    }

    const recentConversations = [
      ...(didConvs || []).map(c => ({
        ...c,
        _sourceTable: "did_conversations" as const,
        sub_mode: c.sub_mode,
      })),
      ...(hanaConvs || []).map(c => ({
        ...c,
        _sourceTable: "karel_hana_conversations" as const,
        sub_mode: canonicalizeHanaMode(c.sub_mode),
      })),
    ];

    const { data: recentCrisisJournal } = await sb
      .from("crisis_journal")
      .select("*")
      .gt("created_at", since);

    // ═══ KROK 2 — Zpracování každého záznamu ═══

    // --- Zdroj A: manuální úkoly ---
    for (const task of manualTasks || []) {
      const text = task.task || task.title || "";
      const isCrisis = detectCrisis(text);

      if (isCrisis) {
        await sb.from("crisis_journal").insert({
          entry_type: "reactive_note",
          karel_notes: `Reactive loop: krizový manuální úkol od terapeuta: ${text.slice(0, 300)}`,
          date: new Date().toISOString().split("T")[0],
        });
      }

      await sb.from("did_therapist_tasks").insert({
        task: generateReactiveResponse(text, isCrisis),
        source: "karel_reactive",
        related_task_id: task.id,
        assigned_to: task.assigned_to || "hanka",
        status: "pending",
        priority: isCrisis ? "high" : "normal",
        user_id: task.user_id,
      });

      await sb.from("karel_conversation_agenda").insert({
        therapist: normalizeTherapist(task.assigned_to || "hanka"),
        topic: `Follow-up k úkolu: ${text.slice(0, 150)}`,
        topic_type: "followup",
        priority: isCrisis ? "urgent" : "normal",
        context: text.slice(0, 500),
        status: "pending",
      });

      await sb.from("did_therapist_tasks")
        .update({ processed_by_reactive: true })
        .eq("id", task.id);

      statsA++;
    }

    // --- Zdroj B: porady ---
    for (const meeting of recentMeetings || []) {
      const msgs = Array.isArray(meeting.messages) ? meeting.messages : [];
      const lastCount = meeting.last_reactive_message_count || 0;

      if (msgs.length <= lastCount) continue;

      const newMsgs = msgs.slice(lastCount);
      const lastMsg = newMsgs[newMsgs.length - 1] as any;
      const lastAuthor = (lastMsg?.author || lastMsg?.role || "").toLowerCase();

      if (lastAuthor && lastAuthor !== "karel") {
        const karelResponse = {
          role: "assistant",
          author: "Karel",
          content: `Karel zaregistroval: "${(lastMsg?.text || lastMsg?.content || "").slice(0, 200)}". Zapracovávám do plánu.`,
          timestamp: new Date().toISOString(),
        };
        const updatedMsgs = [...msgs, karelResponse];
        await sb.from("did_meetings")
          .update({
            messages: updatedMsgs,
            last_reactive_message_count: updatedMsgs.length,
          })
          .eq("id", meeting.id);
      } else {
        await sb.from("did_meetings")
          .update({ last_reactive_message_count: msgs.length })
          .eq("id", meeting.id);
      }

      for (const msg of newMsgs) {
        const content = (msg as any)?.text || (msg as any)?.content || "";
        if (detectCrisis(content)) {
          await sb.from("crisis_journal").insert({
            entry_type: "reactive_note",
            karel_notes: `Reactive loop: krizový obsah v poradě "${meeting.topic}": ${content.slice(0, 300)}`,
            date: new Date().toISOString().split("T")[0],
          });
        }

        const hasCommitment = COMMITMENT_KEYWORDS.some(kw => content.toLowerCase().includes(kw));
        if (hasCommitment && content.trim()) {
          const author = (msg as any)?.author || (msg as any)?.role || "";
          const committedBy = normalizeTherapist(author);
          const { data: existing } = await sb
            .from("karel_commitments")
            .select("id")
            .eq("commitment_text", content.slice(0, 300))
            .eq("source_id", meeting.id)
            .limit(1);

          if (!existing || existing.length === 0) {
            await sb.from("karel_commitments").insert({
              commitment_text: content.slice(0, 300),
              committed_by: committedBy,
              source_type: "meeting",
              source_id: meeting.id,
              due_date: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
              status: "open",
            });
          }
        }
      }

      statsB++;
    }

    // --- Zdroj C: zodpovězené otázky ---
    for (const q of answeredQuestions || []) {
      const answer = q.answer || q.response || "";
      const isCrisis = detectCrisis(answer);

      if (isCrisis) {
        await sb.from("crisis_journal").insert({
          entry_type: "reactive_note",
          karel_notes: `Reactive loop: krizová odpověď na otázku: ${answer.slice(0, 300)}`,
          date: new Date().toISOString().split("T")[0],
        });
      }

      // NOTE: This agenda insert does NOT require can_be_session_target gate because
      // topic_type "followup" with priority "when_appropriate" is NOT a direct-work proposal —
      // it's a follow-up on a therapist-answered question for informational continuity.
      await sb.from("karel_conversation_agenda").insert({
        therapist: normalizeTherapist(q.directed_to || "hanka"),
        topic: `Follow-up k zodpovězené otázce: ${(q.question || "").slice(0, 150)}`,
        topic_type: "followup",
        priority: isCrisis ? "urgent" : "when_appropriate",
        context: answer.slice(0, 500),
        status: "pending",
      });

      // FÁZE 2.6: Use registry-aware part detection + resolveEntity gate
      // CRITICAL: uncertain entities must NOT be silently skipped or just logged.
      // They must either trigger watchdog workflow or fail-closed (no part routing).
      const candidatePart = detectPartMention(answer, registry);
      if (candidatePart) {
        const resolved = resolveEntity(candidatePart, registry);
        if (resolved.can_write_existing_card) {
          // NOTE: answer.slice(0,500) here is THERAPIST input (from did_pending_questions),
          // NOT private Hana content. Therapist clinical observations are safe for KARTA write.
          // Personal thread raw text is NEVER written here — that path uses derived_clinical_implication only.
          const targetName = resolved.matched_canonical_name || candidatePart;
          await sb.from("did_pending_drive_writes").insert({
            target_document: `KARTA_${targetName.toUpperCase()}`,
            content: encodeGovernedWrite(
              `[Reaktivní zpracování] Odpověď terapeuta: ${answer.slice(0, 500)}`,
              {
                source_type: "reactive-loop",
                source_id: q.id,
                content_type: "session_result",
                subject_type: "part",
                subject_id: targetName,
              },
            ),
            write_type: "append",
            priority: "normal",
            user_id: DID_OWNER_ID,
          });
        } else if (resolved.entity_kind === "uncertain_entity") {
          // FÁZE 2.6: Uncertain entity MUST trigger watchdog — never silent skip
          console.log(`[REACTIVE-LOOP] Uncertain entity "${candidatePart}" in answered question → triggering watchdog`);
          // Import watchdog inline to avoid circular deps at module level
          const { handleUncertainEntity } = await import("../_shared/entityWatchdog.ts");
          await handleUncertainEntity(sb, resolved, {
            thread_id: q.id,
            thread_label: `answered-question`,
            sub_mode: q.directed_to || "hanka",
            date_label: new Date().toISOString().split("T")[0],
            content_excerpt: answer.slice(0, 300),
            user_id: DID_OWNER_ID,
          });
        } else {
          // Confirmed non-part (therapist, family, animal, etc.) — no card write, no watchdog needed
          console.log(`[REACTIVE-LOOP] Blocked KARTA write for "${candidatePart}": ${resolved.entity_kind} (can_write_existing_card=false)`);
        }
      }

      await sb.from("did_pending_questions")
        .update({ processed_by_reactive: true })
        .eq("id", q.id);

      statsC++;
    }

    // --- Zdroj D: DID-relevantní info z osobních vláken ---
    for (const conv of recentConversations || []) {
      const msgs = Array.isArray(conv.messages) ? conv.messages : [];
      const therapist: "hanka" | "kata" = conv.sub_mode === "kata" ? "kata" : "hanka";
      const sourceDomain: SourceDomain = conv.sub_mode === "kata"
        ? "therapist_kata"
        : (conv.sub_mode === "hana_personal" ? "hana_personal" : "therapist_hanka");

      // FÁZE 2.6: Use registry-aware relevance check instead of hardcoded DID_KEYWORDS
      const userMsgs = msgs
        .filter((m: any) => m?.role === "user" && isDIDRelevant(m?.content || "", registry))
        .map((m: any) => ({ role: "user", content: m?.content || "", id: m?.id || "", timestamp: m?.timestamp || "" }));

      const clusters = buildMessageClusters(userMsgs, 3, 5 * 60 * 1000);

      for (const cluster of clusters) {
        const segments = segmentMessageIntoTopics(
          cluster.text,
          conv.id,
          cluster.messageIds[0] || null,
          registry,
        );

        for (const seg of segments) {
          if (seg.segment_type === "background_noise") continue;

          const signal = normalizeSignal({
            raw_content: seg.raw_segment,
            source_domain: sourceDomain,
            source_id: conv.id,
            source_message_id: seg.source_message_id,
            therapist: seg.therapist || therapist,
            part_name: seg.part_name,
            registry,
          });

          // 1. PAMET_KAREL
          if (signal.recommended_actions.includes("write_pamet")) {
            const pametTarget = (seg.therapist || therapist) === "kata"
              ? "PAMET_KAREL/DID/KATA/KARLOVY_POZNATKY"
              : "PAMET_KAREL/DID/HANKA/KARLOVY_POZNATKY";

            await sb.from("did_pending_drive_writes").insert({
              target_document: pametTarget,
              content: encodeGovernedWrite(
                `[Osobní vlákno ${new Date().toISOString().split("T")[0]} | ${seg.segment_type}] ${seg.raw_segment.slice(0, 500)}`,
                {
                  source_type: "reactive-loop",
                  source_id: conv.id,
                  content_type: "therapist_memory_note",
                  subject_type: "therapist",
                  subject_id: seg.therapist || therapist,
                },
              ),
              write_type: "append",
              priority: "normal",
              status: "pending",
              user_id: DID_OWNER_ID,
            });
          }

          // 2. Operativní implikace
          if (seg.segment_type !== "personal_relational"
            && canWriteToOperationalLayer(signal)
            && signal.derived_operational_implication) {
            await sb.from("did_pending_drive_writes").insert({
              target_document: "KARTOTEKA_DID/00_CENTRUM/05A_OPERATIVNI_PLAN",
              content: encodeGovernedWrite(
                `\n\n--- ${new Date().toISOString().split("T")[0]} | reactive-loop | ${seg.segment_type} ---\n${signal.derived_operational_implication}`,
                {
                  source_type: "reactive-loop",
                  source_id: conv.id,
                  content_type: "situational_analysis",
                  subject_type: seg.part_name ? "part" : "therapist",
                  subject_id: seg.part_name || seg.therapist || therapist,
                },
              ),
              write_type: "append",
              priority: "normal",
              status: "pending",
              user_id: DID_OWNER_ID,
            });
          }

          // 3. Klinický dopad na část — FÁZE 2.6: gate through resolveEntity
          if (seg.segment_type === "part_clinical"
            && canWriteToPartCard(signal)
            && signal.derived_clinical_implication
            && signal.part_name) {
            // Verify entity can have a card before writing
            const partResolved = resolveEntity(signal.part_name, registry);
            if (partResolved.can_write_existing_card) {
              const targetName = partResolved.matched_canonical_name || signal.part_name;
              await sb.from("did_pending_drive_writes").insert({
                target_document: `KARTA_${targetName.toUpperCase()}`,
                content: encodeGovernedWrite(
                  signal.derived_clinical_implication,
                  {
                    source_type: "reactive-loop",
                    source_id: conv.id,
                    content_type: "session_result",
                    subject_type: "part",
                    subject_id: targetName,
                  },
                ),
                write_type: "append",
                priority: "normal",
                status: "pending",
                user_id: DID_OWNER_ID,
              });
            } else if (partResolved.entity_kind === "uncertain_entity") {
              // FÁZE 2.6: Uncertain entity in conversation segment → trigger watchdog, no silent skip
              console.log(`[REACTIVE-LOOP] Uncertain entity "${signal.part_name}" in conv segment → triggering watchdog`);
              const { handleUncertainEntity } = await import("../_shared/entityWatchdog.ts");
              await handleUncertainEntity(sb, partResolved, {
                thread_id: conv.id,
                thread_label: `conv-segment-${seg.segment_type}`,
                sub_mode: conv.sub_mode || "hanka",
                date_label: new Date().toISOString().split("T")[0],
                content_excerpt: (signal.derived_clinical_implication || "").slice(0, 300),
                user_id: DID_OWNER_ID,
              });
            } else {
              console.log(`[REACTIVE-LOOP] Blocked part card write for "${signal.part_name}": ${partResolved.entity_kind} (can_write_existing_card=false)`);
            }
          }

          // 4. Family context
          if (seg.segment_type === "family_context" && signal.recommended_actions.includes("write_pamet")) {
            const familyTarget = "PAMET_KAREL/DID/KONTEXTY/KDO_JE_KDO";
            await sb.from("did_pending_drive_writes").insert({
              target_document: familyTarget,
              content: encodeGovernedWrite(
                `[Rodinný kontext ${new Date().toISOString().split("T")[0]}] ${signal.safe_summary}`,
                {
                  source_type: "reactive-loop",
                  source_id: conv.id,
                  content_type: "therapist_memory_note",
                  subject_type: "family_context",
                  subject_id: seg.therapist || therapist,
                },
              ),
              write_type: "append",
              priority: "normal",
              status: "pending",
              user_id: DID_OWNER_ID,
            });
          }

          // 5. Agenda item
          if (seg.segment_type !== "background_noise") {
            // FÁZE 2.6 session-target gate: non-communicable parts become
            // observation-only items — no related_part, no direct-work appearance
            let agendaPriority = signal.signal_type === "risk" ? "urgent" : "when_appropriate";
            let agendaRelatedPart: string | null = signal.part_name || null;
            let agendaTopicType = "followup";
            let agendaTopicPrefix = `[${seg.segment_type}]`;

            if (agendaRelatedPart && seg.segment_type === "part_clinical") {
              const partResolved = resolveEntity(agendaRelatedPart, registry);
              if (!partResolved.can_be_session_target) {
                // Part is confirmed but not communicable — make truly observation-only:
                // - null related_part so no consumer treats this as direct-work proposal
                // - explicit observation topic_type + prefix
                agendaPriority = "when_appropriate";
                agendaTopicType = "observation";
                agendaTopicPrefix = `[monitoring-only: ${agendaRelatedPart}]`;
                agendaRelatedPart = null;
                console.log(`[REACTIVE-LOOP] Part "${signal.part_name}" not session-targetable → observation-only (related_part=null)`);
              }
            }

            await sb.from("karel_conversation_agenda").insert({
              therapist: seg.therapist || therapist,
              topic: `${agendaTopicPrefix} ${signal.safe_summary.slice(0, 100)}`,
              topic_type: agendaTopicType,
              priority: agendaPriority,
              context: `[Segmentováno] ${signal.normalized_summary}. ${signal.part_name ? `Část: ${signal.part_name}. ` : ""}Typ: ${seg.segment_type}, Confidence: ${signal.confidence.toFixed(2)}`,
              related_part: agendaRelatedPart,
              status: "pending",
            });
          }

          statsD++;
        }
      }
    }

    // ═══ KROK 3 — Agenda + praise ═══
    const { data: completedTasks } = await sb
      .from("did_therapist_tasks")
      .select("id, task, therapist")
      .eq("status", "done")
      .gt("updated_at", since);

    for (const task of completedTasks || []) {
      const { data: existingPraise } = await sb
        .from("karel_conversation_agenda")
        .select("id")
        .eq("topic_type", "praise")
        .ilike("context", `%${task.id}%`)
        .limit(1);

      if (!existingPraise || existingPraise.length === 0) {
        await sb.from("karel_conversation_agenda").insert({
          therapist: normalizeTherapist(task.assigned_to || "hanka"),
          topic: `Pochválit za splněný úkol: ${(task.task || "").slice(0, 100)}`,
          topic_type: "praise",
          priority: "when_appropriate",
          context: `task_id: ${task.id}`,
          status: "pending",
        });
        statsAgenda++;
      }
    }

    // ═══ KROK 4 — Overdue agenda ═══
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

    const { data: overdueAgenda } = await sb
      .from("karel_conversation_agenda")
      .select("id, priority, topic, therapist")
      .eq("status", "pending")
      .lt("created_at", threeDaysAgo);

    for (const item of overdueAgenda || []) {
      if (item.priority === "urgent") {
        await sb.from("did_pending_questions").insert({
          question: item.topic,
          directed_to: item.therapist === "kata" ? "kata" : "both",
          subject_type: "agenda_escalation",
          status: "pending",
          expires_at: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
        });
        await sb.from("karel_conversation_agenda")
          .update({ status: "escalated" })
          .eq("id", item.id);
      } else if (item.priority === "when_appropriate") {
        await sb.from("karel_conversation_agenda")
          .update({ status: "expired" })
          .eq("id", item.id);
      }
      statsExpired++;
    }

    // ═══ KROK 5 — Log ═══
    await sb.from("system_health_log").insert({
      event_type: "reactive_loop_run",
      severity: "info",
      message: `Reactive loop: A=${statsA} tasks, B=${statsB} meetings, C=${statsC} questions, D=${statsD} convos, agenda=${statsAgenda}, expired=${statsExpired}`,
    });

    console.log('[REACTIVE-LOOP] Completed successfully', { statsA, statsB, statsC, statsD, statsAgenda, statsExpired });

    return new Response(JSON.stringify({
      success: true,
      stats: { manualTasks: statsA, meetings: statsB, questions: statsC, conversations: statsD, agenda: statsAgenda, expired: statsExpired },
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[REACTIVE-LOOP] FATAL ERROR:", error?.message || error);
    await sb.from("system_health_log").insert({
      event_type: "reactive_loop_error",
      severity: "error",
      message: error instanceof Error ? error.message : "Unknown error",
    }).catch(() => {});
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

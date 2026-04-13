import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import {
  buildAuditEntry,
  routeWrite,
  type GovernanceRequest,
} from "../_shared/documentGovernance.ts";
import { encodeGovernedWrite } from "../_shared/documentWriteEnvelope.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ═══════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════

interface ClaimInput {
  card_section: string;
  claim_type: string;
  claim_text: string;
  evidence_level: string;
  confidence: number;
  source_observation_id?: string;
}

interface ProfileClaim {
  id: string;
  part_name: string;
  card_section: string;
  claim_type: string;
  claim_text: string;
  evidence_level: string;
  confidence: number | null;
  confirmation_count: number | null;
  source_observation_ids: string[] | null;
  last_confirmed_at: string | null;
  status: string | null;
  superseded_by: string | null;
  updated_at: string;
}

interface ClaimResult {
  action: string;
  claim_id: string;
  detail: string;
}

// ═══════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════

const IMMEDIATE_CHANGE_TYPES = ["current_state", "risk", "trigger", "therapeutic_response"];
const CUMULATIVE_CHANGE_TYPES = ["stable_trait", "preference", "relationship", "goal"];

const SECTION_NAMES: Record<string, string> = {
  A: "Aktuální stav, role, vztahy",
  B: "Psychologické charakteristiky a profilace",
  C: "Potřeby, strachy, triggery, rizika",
  D: "Doporučené přístupy a techniky",
  E: "Chronologie rozhovorů / událostí",
  F: "Relevantní kontext a preference",
  G: "Deník části",
  H: "Dlouhodobé cíle",
  I: "Konkrétní metody a aktivity na míru",
  J: "Priority a návrh intervence",
  K: "Významné reakce na dřívější aktivity",
  L: "Recent activity trace",
  M: "Analytické poznámky",
};

const CLAIM_TYPE_LABELS: Record<string, string> = {
  stable_trait: "✅ POTVRZENÝ RYS",
  current_state: "📍 AKTUÁLNÍ STAV",
  trigger: "⚠️ TRIGGER",
  preference: "💚 PREFERENCE",
  relationship: "🔗 VZTAH",
  risk: "🔴 RIZIKO",
  therapeutic_response: "💊 REAKCE NA METODU",
  hypothesis: "❓ HYPOTÉZA (k ověření)",
  goal: "🎯 CÍL",
};

// ═══════════════════════════════════════════════════════
// EVIDENCE HELPERS
// ═══════════════════════════════════════════════════════

function getEvidenceStrength(level: string): number {
  const map: Record<string, number> = {
    D1: 1.0, D2: 0.85, D3: 0.7, I1: 0.4, H1: 0.2,
  };
  return map[level] || 0.3;
}

function extractKeywords(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-záčďéěíňóřšťúůýž\s]/g, "")
    .split(/\s+/)
    .filter(w => w.length > 3)
    .slice(0, 5)
    .join(" & ");
}

function isSimilarClaim(existing: string, newText: string): boolean {
  const existWords = new Set(
    existing.toLowerCase().split(/\s+/).filter(w => w.length > 3)
  );
  const newWords = newText.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const overlap = newWords.filter(w => existWords.has(w)).length;
  return overlap >= 3;
}

function isConfirmation(existing: string, newText: string): boolean {
  const negations = [
    "ne", "není", "nikdy", "přestal", "přestala",
    "už ne", "naopak", "místo", "ale", "změnil",
    "změnila", "nechce", "odmítá",
  ];
  const hasNegation = negations.some(neg => newText.toLowerCase().includes(neg));
  return !hasNegation && isSimilarClaim(existing, newText);
}

// ═══════════════════════════════════════════════════════
// CLAIM PROCESSING
// ═══════════════════════════════════════════════════════

async function processProfileClaim(
  sb: SupabaseClient,
  partName: string,
  claim: ClaimInput,
): Promise<ClaimResult> {
  // KROK 1: Hledej podobný active claim
  const { data: existing } = await sb
    .from("did_profile_claims")
    .select("*")
    .eq("part_name", partName)
    .eq("card_section", claim.card_section)
    .eq("status", "active");

  const similar = existing?.find((e: ProfileClaim) =>
    isSimilarClaim(e.claim_text, claim.claim_text)
  );

  // KROK 2: Rozhodovací logika
  if (!similar) return handleNewClaim(sb, partName, claim);
  if (isConfirmation(similar.claim_text, claim.claim_text)) return handleConfirmation(sb, similar, claim);
  return handleContradiction(sb, partName, similar, claim);
}

async function handleNewClaim(
  sb: SupabaseClient,
  partName: string,
  claim: ClaimInput,
): Promise<ClaimResult> {
  const isImmediate = IMMEDIATE_CHANGE_TYPES.includes(claim.claim_type);
  const isHypothesis = ["I1", "H1"].includes(claim.evidence_level);
  const needsCumulative = CUMULATIVE_CHANGE_TYPES.includes(claim.claim_type);

  // Rate limit: stable_trait max 1× za 7 dní pro stejnou část + sekci
  if (claim.claim_type === "stable_trait") {
    const { data: recentChange } = await sb
      .from("did_profile_claims")
      .select("id")
      .eq("part_name", partName)
      .eq("card_section", claim.card_section)
      .eq("claim_type", "stable_trait")
      .gte("updated_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
      .limit(1)
      .maybeSingle();

    if (recentChange) {
      // Downgrade to hypothesis due to rate limit
      claim.claim_type = "hypothesis";
    }
  }

  let finalType = claim.claim_type;
  if (isHypothesis) finalType = "hypothesis";
  else if (needsCumulative && !isImmediate) finalType = "hypothesis";

  const { data } = await sb
    .from("did_profile_claims")
    .insert({
      part_name: partName,
      card_section: claim.card_section,
      claim_type: finalType,
      claim_text: claim.claim_text,
      evidence_level: claim.evidence_level,
      confidence: claim.confidence,
      last_confirmed_at: new Date().toISOString(),
      confirmation_count: 1,
      source_observation_ids: claim.source_observation_id ? [claim.source_observation_id] : [],
      status: "active",
    })
    .select("id")
    .single();

  // Pokud kumulativní typ → pending_question
  if (finalType === "hypothesis" && claim.claim_type !== "hypothesis") {
    await sb.from("did_pending_questions").insert({
      question: `Ověřit: ${claim.claim_text}`,
      context: `Nový claim pro ${partName} sekce ${claim.card_section}. Zatím jen 1 zdroj (${claim.evidence_level}). Potřeba min. 2-3 potvrzení pro zápis jako fakt.`,
      subject_type: "part",
      subject_id: partName,
      directed_to: "self",
      blocking: `Profil ${partName} sekce ${claim.card_section}`,
      status: "open",
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });
  }

  // Audit trail
  await sb.from("did_doc_sync_log").insert({
    source_type: "profile_claim_new",
    source_id: data!.id,
    target_document: `claim_${partName}_${claim.card_section}`,
    content_written: `${finalType}: ${claim.claim_text.slice(0, 200)}`,
    success: true,
  });

  return {
    action: finalType === "hypothesis" ? "created_as_hypothesis" : "created",
    claim_id: data!.id,
    detail: `${claim.claim_type} → ${finalType} (evidence: ${claim.evidence_level}, confidence: ${claim.confidence})`,
  };
}

async function handleConfirmation(
  sb: SupabaseClient,
  existing: ProfileClaim,
  newClaim: ClaimInput,
): Promise<ClaimResult> {
  const newCount = (existing.confirmation_count || 1) + 1;
  const newSources = [
    ...(existing.source_observation_ids || []),
    ...(newClaim.source_observation_id ? [newClaim.source_observation_id] : []),
  ];
  const newConfidence = Math.min(0.99, (existing.confidence || 0.5) + 0.1);
  const shouldPromote = existing.claim_type === "hypothesis" && newCount >= 3;

  await sb
    .from("did_profile_claims")
    .update({
      claim_type: shouldPromote ? "stable_trait" : existing.claim_type,
      confidence: newConfidence,
      last_confirmed_at: new Date().toISOString(),
      confirmation_count: newCount,
      source_observation_ids: newSources,
      status: "active",
    })
    .eq("id", existing.id);

  if (shouldPromote) {
    await sb
      .from("did_pending_questions")
      .update({
        status: "answered",
        answer: `Potvrzeno ${newCount}× z různých zdrojů. Povýšeno na stable_trait.`,
        answered_at: new Date().toISOString(),
        answered_by: "system",
      })
      .eq("subject_id", existing.part_name)
      .eq("status", "open")
      .ilike("question", `%${existing.claim_text.slice(0, 50)}%`);
  }

  // Audit trail
  await sb.from("did_doc_sync_log").insert({
    source_type: "profile_claim_confirm",
    source_id: existing.id,
    target_document: `claim_${existing.part_name}_${existing.card_section}`,
    content_written: `Confirmation #${newCount}${shouldPromote ? " → PROMOTED to stable_trait" : ""}`,
    success: true,
  });

  return {
    action: shouldPromote ? "promoted_to_stable" : "confirmed",
    claim_id: existing.id,
    detail: `Potvrzení #${newCount}. Confidence: ${existing.confidence} → ${newConfidence}${shouldPromote ? ". POVÝŠENO na stable_trait." : ""}`,
  };
}

async function handleContradiction(
  sb: SupabaseClient,
  partName: string,
  existing: ProfileClaim,
  newClaim: ClaimInput,
): Promise<ClaimResult> {
  const existingStrength = getEvidenceStrength(existing.evidence_level) * (existing.confirmation_count || 1);
  const newStrength = getEvidenceStrength(newClaim.evidence_level);

  if (newStrength < existingStrength) {
    // Slabší → hypothesis
    const { data } = await sb
      .from("did_profile_claims")
      .insert({
        part_name: partName,
        card_section: newClaim.card_section,
        claim_type: "hypothesis",
        claim_text: `[ROZPOR s existujícím] ${newClaim.claim_text}`,
        evidence_level: newClaim.evidence_level,
        confidence: newClaim.confidence * 0.5,
        last_confirmed_at: new Date().toISOString(),
        confirmation_count: 1,
        source_observation_ids: newClaim.source_observation_id ? [newClaim.source_observation_id] : [],
        status: "active",
      })
      .select("id")
      .single();

    await sb.from("did_pending_questions").insert({
      question: `ROZPOR v profilu ${partName} sekce ${newClaim.card_section}: Existující: "${existing.claim_text}" vs. Nové: "${newClaim.claim_text}"`,
      context: `Existující claim má ${existingStrength.toFixed(1)} sílu (${existing.evidence_level}, ${existing.confirmation_count}× potvrzeno). Nový má ${newStrength.toFixed(1)} sílu (${newClaim.evidence_level}). Nový NEZMĚNIL existující.`,
      subject_type: "part",
      subject_id: partName,
      directed_to: "self",
      blocking: `Profil ${partName} sekce ${newClaim.card_section} – rozpor`,
      status: "open",
      expires_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
    });

    await sb.from("did_doc_sync_log").insert({
      source_type: "profile_claim_contradiction_weaker",
      source_id: data!.id,
      target_document: `claim_${partName}_${newClaim.card_section}`,
      content_written: `Weaker contradiction: ${newClaim.claim_text.slice(0, 200)}`,
      success: true,
    });

    return {
      action: "contradiction_weaker",
      claim_id: data!.id,
      detail: `Nový claim (síla ${newStrength.toFixed(1)}) SLABŠÍ než existující (síla ${existingStrength.toFixed(1)}). Zapsán jako hypothesis. Vytvořena otázka k ověření.`,
    };
  }

  // Silnější → supersede starý
  await sb.from("did_profile_claims")
    .update({ status: "needs_revalidation" })
    .eq("id", existing.id);

  const { data } = await sb
    .from("did_profile_claims")
    .insert({
      part_name: partName,
      card_section: newClaim.card_section,
      claim_type: newClaim.claim_type,
      claim_text: newClaim.claim_text,
      evidence_level: newClaim.evidence_level,
      confidence: newClaim.confidence,
      last_confirmed_at: new Date().toISOString(),
      confirmation_count: 1,
      source_observation_ids: newClaim.source_observation_id ? [newClaim.source_observation_id] : [],
      status: "active",
    })
    .select("id")
    .single();

  await sb.from("did_profile_claims")
    .update({ superseded_by: data!.id })
    .eq("id", existing.id);

  await sb.from("did_pending_questions").insert({
    question: `ZMĚNA v profilu ${partName} sekce ${newClaim.card_section}: Staré: "${existing.claim_text}" → Nové: "${newClaim.claim_text}"`,
    context: `Nový claim nahradil existující. Ověřit v dalším sezení/vlákně zda jde o trvalou změnu nebo dočasný stav.`,
    subject_type: "part",
    subject_id: partName,
    directed_to: "self",
    blocking: null,
    status: "open",
    expires_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
  });

  await sb.from("did_doc_sync_log").insert({
    source_type: "profile_claim_contradiction_stronger",
    source_id: data!.id,
    target_document: `claim_${partName}_${newClaim.card_section}`,
    content_written: `Stronger contradiction superseded ${existing.id}: ${newClaim.claim_text.slice(0, 200)}`,
    success: true,
  });

  return {
    action: "contradiction_stronger",
    claim_id: data!.id,
    detail: `Nový claim (síla ${newStrength.toFixed(1)}) NAHRADIL existující (síla ${existingStrength.toFixed(1)}). Starý označen needs_revalidation.`,
  };
}

function buildPartCardDocument(partName: string, claims: ProfileClaim[]): string {
  const sections = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M"];
  let doc = `# KARTA ČÁSTI: ${partName}\n`;
  doc += `Poslední aktualizace: ${new Date().toISOString()}\n`;
  doc += `Počet aktivních claims: ${claims.length}\n\n`;

  for (const section of sections) {
    const sectionClaims = claims.filter(c => c.card_section === section);
    if (sectionClaims.length === 0) continue;

    doc += `## ${section}. ${SECTION_NAMES[section] || section}\n\n`;

    for (const claim of sectionClaims) {
      const label = CLAIM_TYPE_LABELS[claim.claim_type] || claim.claim_type;
      const conf = Math.round((claim.confidence || 0.5) * 100);
      const confirmed = claim.confirmation_count || 1;
      doc += `${label} [${claim.evidence_level}, ${conf}%, ${confirmed}× potvrzeno]\n`;
      doc += `${claim.claim_text}\n`;
      doc += `_Poslední potvrzení: ${claim.last_confirmed_at?.slice(0, 10) || "N/A"}_\n\n`;
    }
  }

  return doc;
}

async function enqueuePartCardSync(
  sb: SupabaseClient,
  partName: string,
  sourceId: string,
): Promise<{
  enqueued: boolean;
  target_document?: string;
  write_type?: string;
  audit_status?: string;
  error?: string;
}> {
  try {
    const { data: claims } = await sb
      .from("did_profile_claims")
      .select("*")
      .eq("part_name", partName)
      .eq("status", "active")
      .order("card_section", { ascending: true })
      .order("claim_type", { ascending: true });

    if (!claims || claims.length === 0) {
      console.log(`[update-part-profile] No active claims for ${partName}, skipping queue sync`);
      return { enqueued: false };
    }

    const doc = buildPartCardDocument(partName, claims);
    const governanceRequest: GovernanceRequest = {
      source_type: "update-part-profile",
      source_id: sourceId,
      content_type: "profile_claim",
      subject_type: "part",
      subject_id: partName,
      payload: doc,
    };
    const governanceResult = routeWrite(governanceRequest);

    const queuedContent = encodeGovernedWrite(governanceResult.payload, {
      source_type: governanceRequest.source_type,
      source_id: governanceRequest.source_id,
      content_type: governanceRequest.content_type,
      subject_type: governanceRequest.subject_type,
      subject_id: governanceRequest.subject_id,
    });

    const { error: queueError } = await sb.from("did_pending_drive_writes").insert({
      target_document: governanceResult.driveTarget,
      content: queuedContent,
      write_type: governanceResult.writeType,
      status: "pending",
      priority: "high",
    });

    if (queueError) throw queueError;

    try {
      const pendingAudit = buildAuditEntry(
        governanceRequest,
        governanceResult,
        null,
        undefined,
        "pending",
      );
      await sb.from("did_doc_sync_log").insert(pendingAudit);
    } catch (auditErr) {
      console.warn("[update-part-profile] Pending audit insert failed:", auditErr);
    }

    console.log(`[update-part-profile] ✅ Enqueued ${claims.length} claims for governed sync of ${partName}`);
    return {
      enqueued: true,
      target_document: governanceResult.driveTarget,
      write_type: governanceResult.writeType,
      audit_status: "pending",
    };
  } catch (err) {
    console.error(`[update-part-profile] Queue sync error:`, err);
    return { enqueued: false, error: String(err) };
  }
}

// ═══════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // Auth: service_role bypass or user auth
  const authHeader = req.headers.get("Authorization") || "";
  const srvKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "__never__";
  if (!authHeader.includes(srvKey)) {
    const supabaseAuth = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: { user }, error } = await supabaseAuth.auth.getUser();
    if (error || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  try {
    const body = await req.json();
    const { part_name, claims } = body;

    if (!part_name || !claims || !Array.isArray(claims)) {
      return new Response(JSON.stringify({ error: "part_name and claims[] required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Guardrail: max 10 claims per call
    if (claims.length > 10) {
      return new Response(JSON.stringify({ error: "Max 10 claims per call. Split into multiple calls." }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    console.log(`[update-part-profile] Processing ${claims.length} claims for ${part_name}`);

    const results: ClaimResult[] = [];
    for (const claim of claims) {
      if (!claim.card_section || !claim.claim_type || !claim.claim_text) {
        results.push({ action: "skipped", claim_id: "", detail: "Missing required fields" });
        continue;
      }
      const result = await processProfileClaim(sb, part_name, {
        card_section: claim.card_section.toUpperCase(),
        claim_type: claim.claim_type,
        claim_text: claim.claim_text,
        evidence_level: claim.evidence_level || "I1",
        confidence: claim.confidence ?? 0.5,
        source_observation_id: claim.source_observation_id,
      });
      results.push(result);
    }

    const syncSourceId = crypto.randomUUID();
    const driveResult = await enqueuePartCardSync(sb, part_name, syncSourceId);

    console.log(`[update-part-profile] ✅ Done: ${results.length} claims processed, enqueued=${driveResult.enqueued}`);

    return new Response(JSON.stringify({
      part_name,
      processed: results,
      drive_sync: driveResult,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (err) {
    console.error("[update-part-profile] Error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

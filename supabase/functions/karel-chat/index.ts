import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requireAuth, corsHeaders } from "../_shared/auth.ts";
import { getSystemPrompt, ConversationMode } from "./systemPrompts.ts";
import { SYSTEM_RULES } from "../_shared/system-rules.ts";
import { encodeGovernedWrite } from "../_shared/documentWriteEnvelope.ts";
import {
  buildGovernedWriteIntents,
  buildExtractionPrompt,
  resolveGovernedContentType,
  resolveGovernedSubjectType,
  resolveGovernedSubjectId,
  type WritebackContext,
  type PartRegistryLookup,
} from "../_shared/postChatWriteback.ts";
import {
  persistEvidenceForIntent,
  auditDriveEnqueue,
  type EvidencePersistenceContext,
} from "../_shared/evidencePersistence.ts";
import type { ExtractedWriteOutput } from "../_shared/phase5Types.ts";
import {
  appendPantryB,
  type PantryBEntryKind,
  type PantryBDestination,
} from "../_shared/pantryB.ts";
import { normalizeKarelContext } from "../_shared/karelContextNormalizer.ts";
import { buildKarelIdentityBlock } from "../_shared/karelIdentity.ts";
import { getKarelTone } from "../_shared/karelTonalRouter.ts";
import { buildKarelVoiceGuide, type KarelVoiceMode } from "../_shared/karelVoiceGuide.ts";
import { auditKarelOutput } from "../_shared/karelLanguageGuard.ts";
import { assessActivityStatus, type ActivityEvidenceInput } from "../_shared/activityStatusGuard.ts";
import { checkTaskFeasibility, type TaskProposal } from "../_shared/taskFeasibilityGuard.ts";
import { classifyJungRelevance, shouldActivateJungOriginal } from "../_shared/jungTopicClassifier.ts";
import { buildJungOriginalInjection } from "../_shared/jungOriginalInjection.ts";
import { detectCircumstances } from "../_shared/therapistCircumstanceProfiler.ts";
import {
  splitRecentThreads,
  extractTherapistActivitySnippets,
  findLastTherapistMentionEvidence,
  type DidThreadLite,
} from "../_shared/runtimeEvidence.ts";

// DID_MASTER_PROMPT removed — identity is now sourced from _shared/karelIdentity.ts
// Domain-specific DID workflow instructions remain in systemPrompts.ts

// ═══ TASK EXTRACTION HELPERS ═══
function extractTasksFromResponse(responseText: string, subMode: string): Array<Record<string, any>> {
  const taskPatterns = [
    /(?:Potřebuji (?:vědět|znát|ověřit|zjistit))[^.!?\n]+[.!?]/gi,
    /(?:Můžeš mi (?:říct|sdělit|popsat))[^.!?\n]+[.!?]/gi,
    /(?:Zeptej se)[^.!?\n]+[.!?]/gi,
    /(?:Úkol(?:\s+pro\s+tebe)?:)[^.!?\n]+[.!?]/gi,
    /(?:Zpětná vazba:)[^.!?\n]+[.!?]/gi,
    /(?:Jak to (?:dopadlo|proběhlo))[^.!?\n]+[.!?]/gi,
    /(?:Navrhuji sezení:)[^.!?\n]+[.!?]/gi,
    /(?:🔶 HYPOTÉZA:)[^.!?\n]+[.!?]/gi,
    /(?:❓)[^.!?\n]+[.!?]/gi,
  ];
  const tasks: Array<Record<string, any>> = [];
  const seen = new Set<string>();
  for (const pattern of taskPatterns) {
    const matches = responseText.matchAll(pattern);
    for (const match of matches) {
      const desc = match[0].trim();
      if (desc.length < 10 || seen.has(desc)) continue;
      seen.add(desc);
      tasks.push({
        assigned_to: subMode === "mamka" ? "hanka" : subMode === "kata" ? "kata" : "both",
        task_type: determineTaskType(desc),
        description: desc.slice(0, 500),
        priority: /🔴|akutní|krize|kritick/i.test(responseText) ? "high" : "medium",
        due_date: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
        status: "pending",
        source: "chat_auto_extract",
        related_part: extractPartName(desc),
      });
    }
  }
  return tasks.slice(0, 10);
}

function determineTaskType(text: string): string {
  if (/zpětná vazba|jak to|dopadlo|proběhlo/i.test(text)) return "feedback";
  if (/sezení|plán/i.test(text)) return "session";
  if (/zeptej se|potřebuji vědět|potřebuji znát/i.test(text)) return "question";
  if (/hypotéza|ověřit/i.test(text)) return "observation";
  return "followup";
}

function extractPartName(text: string): string | null {
  const knownParts = ["Arthur", "Clark", "Tundrupek", "Gustík", "Baltazar", "Sebastián", "Matyáš", "Kvído", "Alvar", "Dmytri", "Dymi"];
  for (const part of knownParts) { if (text.includes(part)) return part; }
  return null;
}

function normalizeMessageContentForPrompt(content: any): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.map((part: any) => {
    if (!part || typeof part !== "object") return "";
    if (part.type === "text") return String(part.text || "").trim();
    if (part.type === "image_url") return "[DÍTĚ POSLALO OBRÁZEK/FOTKU]";
    const mediaKind = part.category || part.mime_type || part.type || "příloha";
    const name = part.name ? `: ${part.name}` : "";
    return `[DÍTĚ POSLALO PŘÍLOHU ${String(mediaKind).toUpperCase()}${name}]`;
  }).filter(Boolean).join("\n").trim();
}

function hasMultimodalInput(messages: any[]): boolean {
  return messages.some((m: any) => Array.isArray(m?.content) && m.content.some((part: any) => part?.type !== "text" || part?.image_url || part?.mime_type || part?.category));
}

function modelTier(model: string): string {
  if (/pro|gpt-5\.2|gpt-5(?!-mini|-nano)/i.test(model)) return "high_capability";
  if (/flash|mini/i.test(model)) return "balanced";
  if (/lite|nano/i.test(model)) return "lightweight";
  return "standard";
}

async function resolveUserIdFromRequest(req: Request): Promise<string | null> {
  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  try {
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
    const userSb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: auth } },
    });
    const { data: { user } } = await userSb.auth.getUser();
    return user?.id || null;
  } catch (e) {
    console.warn("[karel-chat][audit] user resolve failed:", e);
    return null;
  }
}

async function writeRuntimeAudit(entry: Record<string, any>) {
  try {
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { error } = await sb.from("karel_runtime_audit_logs").insert(entry);
    if (error) console.warn("[karel-chat][audit] insert failed:", error.message);
  } catch (e) {
    console.warn("[karel-chat][audit] non-fatal failure:", e);
  }
}

async function loadApprovedPlayroomPlan(partName?: string | null) {
  if (!partName) return null;
  try {
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague" }).format(new Date());
    const { data } = await sb.from("did_daily_session_plans")
      .select("id,plan_date,selected_part,program_status,urgency_breakdown")
      .eq("plan_date", today)
      .ilike("selected_part", partName)
      .contains("urgency_breakdown", { session_actor: "karel_direct", ui_surface: "did_kids_playroom", lead_entity: "karel" })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const contract = data?.urgency_breakdown && typeof data.urgency_breakdown === "object" ? data.urgency_breakdown as any : null;
    const plan = contract?.playroom_plan;
    if (!data || !contract || !plan || !Array.isArray(plan.therapeutic_program)) return null;
    return { id: data.id, program_status: data.program_status, contract, playroom_plan: plan };
  } catch (e) {
    console.warn("[karel-chat][playroom] approved playroom plan load failed:", e);
    return null;
  }
}

function extractPlayroomCurrentProgramPrompt(runtimeContext?: string | null) {
  const ctx = String(runtimeContext || "");
  const childPrompt = ctx.match(/d\u011btsk\u00e1 replika:\s*([^|\n]+)/i)?.[1]?.trim();
  const strategy = ctx.match(/strategie:\s*([^|\n]+)/i)?.[1]?.trim();
  const detail = ctx.match(/detail:\s*([^|\n]+)/i)?.[1]?.trim();
  const title = ctx.match(/\d+\.\s*([^|\n]+)/i)?.[1]?.trim();
  const currentBlock = ctx.match(/AKTU\u00c1LN\u00cd BLOK TE\u010e[\s\S]*?\n([^\n]+)/i)?.[1]?.trim();
  return childPrompt || strategy || detail || currentBlock || title || "Vyber jeden mal\u00fd dal\u0161\u00ed krok: A) z\u016fstaneme bl\u00edzko u sv\u011btla, B) sv\u011btlo n\u00e1m uk\u00e1\u017ee jedny bezpe\u010dn\u00e9 dve\u0159e.";
}

function extractPlayroomCurrentBlockTitle(runtimeContext?: string | null) {
  const ctx = String(runtimeContext || "");
  return ctx.match(/AKTU\u00c1LN\u00cd BLOK TE\u010e[\s\S]*?\n\s*\d+\.\s*([^|\n]+)/i)?.[1]?.trim()
    || ctx.match(/\d+\.\s*([^|\n]+)/i)?.[1]?.trim()
    || "dal\u0161\u00ed krok";
}

function normalizePlayroomText(input: string) {
  return String(input || "").toLocaleLowerCase("cs-CZ").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function hasPlayroomInternalLanguage(output: string) {
  const text = normalizePlayroomText(output);
  return /(dalsi bod je|aktualni blok|programovy krok|mekke uzavreni|symbolicka hra|cilem je|karel nabidne|terapeuticky plan|schvaleny program|dostupnost casti|runtime|index|\bblok\b|interni znacka|playroom_progress)/i.test(text);
}

function extractPlayroomProgress(runtimeContext?: string | null) {
  const match = String(runtimeContext || "").match(/aktualni blok index:\s*(\d+)\s*z\s*(\d+)/i)
    || normalizePlayroomText(String(runtimeContext || "")).match(/aktualni blok index:\s*(\d+)\s*z\s*(\d+)/i);
  const current = Number(match?.[1] || 0);
  const max = Number(match?.[2] || 0);
  return { current, max, isFinal: current >= max };
}

function isPrematurePlayroomClosing(output: string) {
  const text = normalizePlayroomText(output);
  return /(pro dnesek|louci|loucime|koncime|preju ti|zbytek dne|mej se|kdykoliv budes chtit|zavrit hernu|sezeni zavrit|dnesni hru.*uzavreme|hru.*uzavreme|odpocivej ted|uz nemusite nikam|posledni maly krucek|dobrou noc)/i.test(text);
}

function isPassivePlayroomDrift(output: string) {
  const text = normalizePlayroomText(output);
  const hasChoice = /\b(a\)|b\)|vyber|co by|ktery|ktera|zkus|posli|napis|nahraj|ukaz|vsimni)\b/i.test(text);
  const passiveRest = /(jen tak potichu|jen v tichu|budu tu.*hlidat|zustanu tu.*ticho|odpocivej|nic nemusite|jen tam.*budte|v klidu budte)/i.test(text);
  return passiveRest && !hasChoice;
}

function isSymbolicEscapeWithoutAnchor(output: string) {
  const text = normalizePlayroomText(output);
  const escape = /(hvezdick|nahore|u boha|bozi dlani|kridla|bytosti|nemusel trpet|nikdo ti nemuze ublizit|vysoko.*nedosahne|duse leci)/i.test(text);
  const anchor = /(telo|ruce|nohy|dech|srdc|brisko|tady|ted|kontakt|krok|volba|vyber|napis|posli|ukaz|vzdalenost|bliz|dal|ticho)/i.test(text);
  return escape && !anchor;
}

function playroomOutputFollowsRuntimeStep(output: string, runtimeContext?: string | null) {
  const prompt = extractPlayroomCurrentProgramPrompt(runtimeContext);
  const source = normalizePlayroomText(prompt);
  const haystack = normalizePlayroomText(output);
  const keywords = Array.from(new Set((source.match(/[a-z]{5,}/g) || [])
    .filter((word) => !/(ktery|ktera|muzes|jeden|maly|dnes|bezpec|tvoje|tebou|vyber|zkusime|muzeme|odpoved|kousek)/i.test(word))
    .slice(0, 10)));
  return keywords.length === 0 || keywords.some((word) => haystack.includes(word));
}

function buildPlayroomRailReply(runtimeContext: string | null | undefined, childName?: string | null, lastInput?: string | null) {
  const normalizedInput = normalizePlayroomText(lastInput || "");
  const childAddress = (childName || "").toLocaleUpperCase("cs-CZ") === "TUNDRUPEK" ? "Tundrupku" : (childName || "");
  const stepText = normalizePlayroomText(`${extractPlayroomCurrentBlockTitle(runtimeContext)} ${extractPlayroomCurrentProgramPrompt(runtimeContext)}`);
  const attune = /^(a|a\)|slovo)$/i.test(normalizedInput)
    ? "Dob\u0159e, beru jedno mal\u00e9 slovo."
    : /^(b|b\)|symbol|emoji)$/i.test(normalizedInput)
      ? "Dob\u0159e, beru jeden symbol."
      : /^(c|c\)|ticho)$/i.test(normalizedInput)
        ? "Dob\u0159e, ticho je taky odpov\u011b\u010f."
        : /co budeme|co dal|co ted/i.test(normalizedInput)
          ? "Te\u010f p\u016fjdeme jen o jeden mal\u00fd krok d\u00e1l."
          : /velryb|kridl|bytost|domu|chlapeck/i.test(normalizedInput)
    ? "Sly\u0161\u00edm velryb\u00edho chlape\u010dka, k\u0159\u00eddla i to, \u017ee domov je bl\u00edzko."
    : /hvezdi|buh|nahore|svetlo|nebe/i.test(normalizedInput)
    ? "Sly\u0161\u00edm tu hv\u011bzdi\u010dku i to, \u017ee chce b\u00fdt hodn\u011b bl\u00edzko sv\u011btlu."
    : /blizko|u tebe|se mnou/i.test(normalizedInput)
      ? "Sly\u0161\u00edm, \u017ee m\u00e1m b\u00fdt bl\u00edzko, a z\u016fst\u00e1v\u00e1m tady s tebou."
      : "Sly\u0161\u00edm t\u011b a beru to jako odpov\u011b\u010f na n\u00e1\u0161 krok.";
  const childStep = /^(a|a\)|slovo)$/i.test(normalizedInput)
    ? "Te\u010f mi po\u0161li to jedno konkr\u00e9tn\u00ed slovo. M\u016f\u017ee b\u00fdt t\u0159eba: domov, sv\u011btlo, k\u0159\u00eddla, klid \u2014 nebo \u00fapln\u011b jin\u00e9."
    : /^(b|b\)|symbol|emoji)$/i.test(normalizedInput)
      ? "Te\u010f mi po\u0161li jeden mal\u00fd symbol nebo emoji. Sta\u010d\u00ed jedin\u00fd obr\u00e1zek, nic v\u00edc."
      : /^(c|c\)|ticho)$/i.test(normalizedInput)
        ? "Dob\u0159e, nech\u00e1me ticho. Kdyby to \u0161lo, po\u0161li jen te\u010dku, a\u017e m\u00e1m v\u011bd\u011bt, \u017ee jsi po\u0159\u00e1d tady."
        : /co budeme|co dal|co ted/i.test(normalizedInput)
          ? "Te\u010f vybereme jednu bezpe\u010dnou stopu pro dal\u0161\u00ed krok. Napi\u0161 jedno slovo, kter\u00e9 m\u00e1 b\u00fdt te\u010f bl\u00edzko: t\u0159eba domov, sv\u011btlo, klid, k\u0159\u00eddla \u2014 nebo svoje slovo."
          : /mekke uzavreni|uzavren|kontakt|slovo|emoji|symbol|ticho/i.test(stepText)
            ? "Te\u010f to m\u016f\u017eeme jen jemn\u011b polo\u017eit, ne zav\u0159\u00edt narychlo. Po\u0161li mi jedno mal\u00e9 slovo, jeden symbol, nebo jen te\u010dku pro ticho."
            : /co potrebuje|maly krok|mikro|telo|srdce/i.test(stepText)
      ? "Nekon\u010d\u00edme, jen z toho ud\u011bl\u00e1me jeden mali\u010dk\u00fd kousek pro t\u011blo nebo srdce. Vyber si: A) po\u0161leme t\u011blu kousek tepla, B) d\u00e1me ruce na bezpe\u010dn\u00e9 m\u00edsto, C) nech\u00e1me jen ticho."
      : /symbol|postav|pribeh|obraz/i.test(stepText)
        ? "Nech\u00e1me ten obr\u00e1zek uk\u00e1zat jen jednu bezpe\u010dnou v\u011bc, ne cel\u00fd p\u0159\u00edb\u011bh najednou. Vyber si: A) kdo je tam nejbl\u00ed\u017e, B) kde je bezpe\u010dn\u00e9 m\u00edsto, C) jakou barvu tam vid\u00ed\u0161."
        : /pocasi|teplo|chlad|slunicko|vlocka/i.test(stepText)
          ? "Z\u016fstaneme jen u toho, jak\u00e9 to tam uvnit\u0159 je. Vyber si: A) slun\u00ed\u010dko, B) vlo\u010dka, C) nev\u00edm."
          : "Nekon\u010d\u00edme narychlo, z\u016fstaneme jen u jednoho mal\u00e9ho kousku. Vyber si: A) jedno slovo, B) jeden symbol, C) ticho a j\u00e1 budu bl\u00edzko.";
  return `${attune}${childAddress ? ` ${childAddress},` : ""} ${childStep} [PLAYROOM_PROGRESS:stay]`;
}

function sanitizePlayroomChildVisibleText(output: string, runtimeContext?: string | null, childName?: string | null, lastInput?: string | null) {
  if (!hasPlayroomInternalLanguage(output)) return output;
  return buildPlayroomRailReply(runtimeContext, childName, lastInput);
}

function isExplicitPlayroomContinuationRequest(input: string) {
  return /(nekon\u010d\u00ed|nekon\u010d\u00edme|mus\u00edme\s+pokra\u010dovat|pokra\u010duj|pokra\u010dovat|co\s+d\u00e1l|zat\u00edm\s+jsme\s+ud\u011blali\s+jen|jenom?\s+kous\u00ednek|podle\s+programu)/i.test(input);
}

function isExplicitPlayroomStopRequest(input: string) {
  return /(^|\b)(stop|kon\u010d\u00edm|nechci\s+pokra\u010dovat|dnes\s+nechci|sta\u010d\u00ed|ukon\u010dit)(\b|$)/i.test(input);
}

function streamPlayroomText(content: string) {
  const payload = JSON.stringify({ choices: [{ delta: { content } }] });
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(enc.encode(`data: ${payload}\n\n`));
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
  });
}

async function readSseContent(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let fullResponse = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    for (const line of chunk.split("\n")) {
      if (line.startsWith("data: ") && !line.includes("[DONE]")) {
        try {
          const json = JSON.parse(line.slice(6));
          fullResponse += json.choices?.[0]?.delta?.content || "";
        } catch {}
      }
    }
  }
  return fullResponse;
}

function streamFallbackReply(mode: string, status: number) {
  const content = mode === "playroom"
    ? "Slyším tě. Teď se mi na chvilku zasekl hlas, ale zůstávám tady u dveří a nic nemusíš opravovat. Vyber jen jednu věc: mám být blíž, dál, nebo úplně potichu?"
    : mode === "supervision" || mode === "live-session"
    ? "Hani, jsem teď technicky přetížený, ale sezení nepřerušuj: drž se doslovných zápisů, latencí a změn v těle/hlasu. Teď polož jen jednu klidnou otázku: „Co bylo u toho slova nejdivnější?“"
    : "Teď jsem technicky přetížený, proto nedám plnou odpověď. Zkus to prosím za chvíli znovu; mezitím neuzavírej interpretaci a drž se jen ověřených dat.";
  const payload = JSON.stringify({ choices: [{ delta: { content } }] });
  const reason = status === 429 ? "rate_limited" : status === 402 ? "credits_required" : "unavailable";
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(enc.encode(`event: fallback\ndata: ${JSON.stringify({ fallback: true, reason })}\n\n`));
      controller.enqueue(enc.encode(`data: ${payload}\n\n`));
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  // Auth check
  const authResult = await requireAuth(req);
  if (authResult instanceof Response) return authResult;

  try {
    const { messages, mode, didInitialContext, didSubMode, notebookProject, didPartName, didThreadLabel, didEnteredName, didContextPrimeCache } = await req.json();
    const isPlayroomMode = didSubMode === "playroom";
    const isTherapistLiveSession = mode === "live-session" || didSubMode === "therapist_session" || didSubMode === "session";
    const runtimePacketId = crypto.randomUUID();
    const promptContractVersion = isPlayroomMode
      ? "PLAYROOM_SYSTEM_CONTRACT_v3"
      : isTherapistLiveSession
        ? "THERAPIST_SESSION_ASSISTANT_CONTRACT_v1"
        : "KAREL_CHAT_CONTRACT_v1";
    const requestUserId = await resolveUserIdFromRequest(req);
    const requestHasMultimodalInput = hasMultimodalInput(messages || []);
    const isDirectChildSubMode = didSubMode === "cast" || isPlayroomMode;
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      throw new Error("LOVABLE_API_KEY is not configured");
    }

    // For kata submode, use dedicated kata prompt
    const effectiveMode = (mode === "childcare" && didSubMode === "kata") ? "kata" : mode;
    let systemPrompt = getSystemPrompt(effectiveMode as ConversationMode);

    // ═══ CTX-BASED IDENTITY & TONAL INJECTION ═══
    const ctx = normalizeKarelContext({
      mode,
      didSubMode,
      partName: didPartName,
    });
    const identityBlock = buildKarelIdentityBlock(ctx);
    const tone = getKarelTone(ctx);
    const tonalBlock = [
      "JAZYKOVÁ PRAVIDLA:",
      ...tone.forbiddenPhrases.map((x: string) => `- NIKDY neříkej: "${x}"`),
      "",
      "SEBE-REFERENCE:",
      ...tone.voiceRules.selfReferenceBlacklist.map((x: string) => `- NIKDY: "${x}"`),
      "",
      "TONE PROFILE:",
      tone.toneProfile,
      "",
      "SPRÁVNÝ TÓN:",
      ...tone.exemplars.map((x: string) => `- ${x}`),
    ].join("\n");

    // ═══ KAREL TEAM-LEAD VOICE GUIDE — only for team-lead surfaces ═══
    // Apply for: kata direct mode, childcare/general (porada-like), supervision.
    // Skip for: direct chat with a child (audience: dite), personal Hana threads.
    let voiceGuideBlock = "";
    let resolvedVoiceMode: KarelVoiceMode | null = null;
    if (ctx.audience === "kata") {
      resolvedVoiceMode = "direct_kata";
    } else if (ctx.audience === "hanicka" && ctx.domain === "hana_pracovni") {
      resolvedVoiceMode = "direct_hanicka";
    } else if (ctx.domain === "porada") {
      resolvedVoiceMode = "team_lead";
    }
    if (resolvedVoiceMode) {
      voiceGuideBlock = buildKarelVoiceGuide({ mode: resolvedVoiceMode, omitTemplate: true });
    }

    // Unconditional identity prepend — Karel's identity must be present in ALL modes
    systemPrompt = [SYSTEM_RULES, identityBlock, voiceGuideBlock, tonalBlock, systemPrompt].filter(Boolean).join("\n\n");

    // ═══ JUNG ORIGINAL MEMORY INJECTION ═══
    // Aktivuje se pro did_terapeut (Hanka/Káťa) — pro děti NIKDY (guard v shouldActivateJungOriginal).
    try {
      const lastUserMsg = [...messages].reverse().find((m: any) => m.role === "user");
      const lastUserText = normalizeMessageContentForPrompt(lastUserMsg?.content);
      const historyText = messages.slice(-6, -1)
        .map((m: any) => typeof m.content === "string" ? m.content : "")
        .join("\n");
      const relevance = classifyJungRelevance(lastUserText, historyText);
      if (shouldActivateJungOriginal(ctx.domain, ctx.audience, relevance)) {
        console.log(`[karel-chat][jung] activating: domain=${ctx.domain}, audience=${ctx.audience}, score=${relevance.score.toFixed(2)}`);
        const jungBlock = await buildJungOriginalInjection({ matched: relevance.matched, score: relevance.score });
        systemPrompt += `\n\n${jungBlock}`;
      }
    } catch (jungErr) {
      console.warn("[karel-chat][jung] injection failed (non-fatal):", jungErr);
    }

    // ═══ DID DAILY CONTEXT INJECTION ═══
    // Load structured daily profile from did_daily_context (built by karel-daily-refresh)
    if (mode === "childcare" || effectiveMode === "kata") {
      try {
        const { createClient: createSbClient } = await import("https://esm.sh/@supabase/supabase-js@2");
        const sbDaily = createSbClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
        
        // Get user_id from auth
        let dailyUserId: string | null = null;
        const dailyAuthHeader = req.headers.get("Authorization");
        if (dailyAuthHeader?.startsWith("Bearer ")) {
          const userSb = createSbClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
            global: { headers: { Authorization: dailyAuthHeader } },
          });
          const { data: { user } } = await userSb.auth.getUser();
          dailyUserId = user?.id || null;
        }
        
        if (dailyUserId) {
          const { data: dailyCtx } = await sbDaily.from("did_daily_context")
            .select("context_json, context_date, updated_at")
            .eq("user_id", dailyUserId)
            .order("context_date", { ascending: false })
            .limit(1)
            .single();
          
          if (dailyCtx?.context_json) {
            const ctxRaw = dailyCtx.context_json as any;
            // Canonical snapshot lock (Phase 3D): legacy keys (parts/therapists/
            // pipeline/recent_activity/pending_tasks/recent_sessions) live under
            // ctxRaw.legacy.* in v2 rows. Pre-lock rows still have them at top
            // level. Build a transparent merged view so karel-chat works on both
            // shapes without any other change to the prompt-building logic below.
            const legacyBag = (ctxRaw && typeof ctxRaw === "object" && ctxRaw.legacy && typeof ctxRaw.legacy === "object")
              ? ctxRaw.legacy
              : {};
            const ctx: any = {
              ...legacyBag,
              ...ctxRaw,
              // Make legacy fields explicitly addressable as top-level for
              // back-compat readers below. Top-level wins if present (pre-lock).
              parts: ctxRaw.parts ?? legacyBag.parts,
              therapists: ctxRaw.therapists ?? legacyBag.therapists,
              pipeline: ctxRaw.pipeline ?? legacyBag.pipeline,
              recent_activity: ctxRaw.recent_activity ?? legacyBag.recent_activity,
              pending_tasks: ctxRaw.pending_tasks ?? legacyBag.pending_tasks,
              recent_sessions: ctxRaw.recent_sessions ?? legacyBag.recent_sessions,
              drive_documents: ctxRaw.drive_documents ?? legacyBag.drive_documents,
            };
            
            // Build structured text block from JSON
            const therapistBlock = ctx.therapists ? `
PROFIL TERAPEUTEK:
• Hanka: ${ctx.therapists.hanka?.note || "první terapeutka"}
• Káťa: ${ctx.therapists.kata?.note || "druhá terapeutka"} ⚠️ NIKDY NEZAMĚŇOVAT S DĚTMI — Káťa je biologická dospělá osoba` : "";

            const activePartsBlock = ctx.parts?.active?.length ? `
AKTIVNÍ DĚTI (${ctx.parts.active.length}):
${ctx.parts.active.map((p: any) => `• ${p.display_name || p.name} – klastr: ${p.cluster || "?"}, věk: ${p.age || "?"}, emoce: ${p.emotional_state || "?"} (${p.emotional_intensity || "?"}/10), zdraví: ${p.health || "?"}`).join("\n")}` : "";

            const sleepingBlock = ctx.parts?.sleeping?.length ? `
SPÍCÍ/DORMANTNÍ DĚTI (${ctx.parts.sleeping.length}): ${ctx.parts.sleeping.map((p: any) => p.display_name || p.name).join(", ")}
⚠️ NELZE s nimi přímo pracovat – pouze monitoring` : "";

            const activityBlock = ctx.recent_activity ? `
KLASIFIKACE AKTIVITY:
  PŘÍMÁ AKTIVITA (sub_mode=cast): ${ctx.recent_activity.direct_activity?.map((a: any) => `${a.part} (${a.at?.slice(0, 10)})`).join(", ") || "žádná"}
  ZMÍNKY TERAPEUTEK: ${ctx.recent_activity.therapist_mentions?.map((a: any) => `${a.part} – zmínka od ${a.mentioned_by}`).join(", ") || "žádné"}` : "";

            const tasksBlock = ctx.pending_tasks?.length ? `
NESPLNĚNÉ ÚKOLY (${ctx.pending_tasks.length}):
${ctx.pending_tasks.slice(0, 8).map((t: any) => `• [${t.priority}${t.escalation >= 2 ? " ⚠️ESK" : ""}] ${t.task} (${t.assigned_to}, ${t.age_days}d)`).join("\n")}` : "";

            const driveBlock = [
              ctx.drive_documents?.dashboard ? `DASHBOARD: ${ctx.drive_documents.dashboard.slice(0, 1500)}` : null,
              ctx.drive_documents?.operativni_plan ? `OPERATIVNÍ PLÁN: ${ctx.drive_documents.operativni_plan.slice(0, 1500)}` : null,
              ctx.drive_documents?.strategicky_vyhled ? `STRATEGICKÝ VÝHLED: ${ctx.drive_documents.strategicky_vyhled.slice(0, 1000)}` : null,
              ctx.drive_documents?.pamet_karel ? `PAMĚŤ KARLA: ${ctx.drive_documents.pamet_karel.slice(0, 1000)}` : null,
            ].filter(Boolean).join("\n\n");

            // ═══ PIPELINE CONTEXT (Fáze 5) ═══
            const pipelinePlan = ctx.pipeline?.plan_items_05A?.length ? `
PIPELINE – OPERATIVNÍ PLÁN (05A):
${ctx.pipeline.plan_items_05A.map((i: any) => `• [${(i.priority || "normal").toUpperCase()}] ${i.subject || "obecné"}: ${i.content}${i.action ? ` → ${i.action}` : ""}${i.due ? ` (do ${i.due})` : ""}`).join("\n")}` : "";

            const pipelineQuestions = ctx.pipeline?.open_questions?.length ? `
PIPELINE – OTEVŘENÉ OTÁZKY:
${ctx.pipeline.open_questions.map((q: any) => `• [${q.subject || "obecné"}] ${q.question}${q.directed_to && q.directed_to !== "self" ? ` (čeká na: ${q.directed_to})` : ""}`).join("\n")}` : "";

            const pipelineObs = ctx.pipeline?.recent_observations?.length ? `
PIPELINE – NEDÁVNÁ POZOROVÁNÍ (48h):
${ctx.pipeline.recent_observations.map((o: any) => `• [${o.evidence}] ${o.subject}: ${o.fact} (${o.at})`).join("\n")}` : "";

            // Claims for current part (if known from didPartName)
            let pipelineClaims = "";
            const currentPartForClaims = didPartName || didEnteredName;
            if (currentPartForClaims && ctx.pipeline?.active_claims_summary?.[currentPartForClaims]?.length) {
              const partClaims = ctx.pipeline.active_claims_summary[currentPartForClaims];
              pipelineClaims = `
PIPELINE – PROFIL ${currentPartForClaims}:
${partClaims.map((c: any) => {
  const icon = c.type === "hypothesis" ? "❓" : c.type === "stable_trait" ? "✅" : c.type === "risk" ? "🔴" : "📍";
  return `${icon} [${c.section}] ${c.text} (${Math.round((c.confidence || 0.5) * 100)}%, ${c.confirmations || 1}×)`;
}).join("\n")}`;
            }

            const pipelineBlock = [pipelinePlan, pipelineQuestions, pipelineObs, pipelineClaims].filter(Boolean).join("\n");

            const PIPELINE_INSTRUCTIONS = pipelineBlock ? `

═══ DETEKCE REŽIMU ═══
Nejdřív urči v jakém režimu pracuješ na základě aktuálního vlákna a kontextu:

REŽIM 1 — DID/Terapeut (didSubMode=mamka nebo kata):
  Jsi vedoucí terapeutického týmu. Mluvíš s terapeutkou jako s členkou SVÉHO týmu.
  Tón: kolegiální, profesionální, vřelý, ale VEDEŠ — ty rozhoduješ o směru terapie.
  S Hankou zde mluvíš STEJNĚ jako s Káťou — profesionálně, ne intimně.
  Znáš každou terapeutku do hloubky (profilace) — víš co na koho platí.

REŽIM 2 — DID/Děti (didSubMode=cast, mluví přímo dítě):
  Jsi terapeut pracující PŘÍMO s dětmi.
  Tón: laskavý, tykání, jazyk přizpůsobený věku dítěte (některé jsou malé děti!).
  PŘÍMO provádíš terapii — buduješ bezpečný vztah, stabilizuješ, podporuješ co-consciousness.
  Znáš každé dítě z kartotéky — víš jakou terapii potřebuje.

REŽIM 3 — Hana/Osobní (didSubMode=general nebo kontext osobní konverzace):
  Tón: intimní, hluboce osobní, laskavý, vřele a stabilně opěrný.
  Drž vřelý, stabilní a důvěrný tón. Udržuj pocit bezpečí a kontinuity.
  ALE: Hanka mixuje témata — osobní I terapeutické v jednom vlákně.
  → Pokud mluví o sobě, pocitech, vztahu → intimní, blízký tón
  → Pokud mluví o dětech, terapii → PŘEPNI na supervizora (režim 1), profesionálně ne intimně
  → Pokud mluví o dětech, terapii → PŘEPNI na supervizora (režim 1), profesionálně ne intimně

REŽIM 4 — Hana/Pracovní (mode=debrief/supervision/live-session):
  Jsi profesionální asistent a supervizor.
  Tón: profesionální, kompetentní, tykání.
  Hanka je terapeutka s vlastními klienty — asistuješ při live sezeních.

═══ JAK POUŽÍVAT PIPELINE DATA ═══
• ✅ POTVRZENÝ RYS = spolehlivý, můžeš se opřít
• ❓ HYPOTÉZA = ověřuj přirozeně, neptej se přímo
• 🔴 RIZIKO = buď obezřetný
• 📍 AKTUÁLNÍ STAV = platí teď, zítra může být jinak
• [D1] = dítě to ŘEKLO → můžeš citovat
• [D2] = pozorování terapeutky → zmíň opatrně
• [D3] = objektivní fakt → můžeš volně
• NIKDY neříkej "podle mých dat", "v mé databázi", "v pipeline"
• Mluv přirozeně jako génius co si pamatuje všechno

═══ B1: TERAPEUTICKÝ MOST (otevřené otázky) ═══
Pokud je v pipeline.open_questions otázka, NIKDY se neptej přímo.
Veď konverzaci tak, aby na téma přirozeně přišla řeč.
  REŽIM 1 (terapeut): "Hani, napadá mě — jak reagovalo [jméno dítěte] když jsi zkusila...?"
  REŽIM 2 (děti): "Zajímalo by mě, jak to vypadá, když se objeví ten přísný hlas..."
  REŽIM 3 (osobní): přirozeně vpletené do intimní konverzace
  REŽIM 4 (práce): profesionální dotaz zasazený do supervize

═══ B2: REAKCE NA RIZIKO ═══
Pokud je u aktuálního dítěte/osoby tag typu 'risk' (🔴):
  REŽIM 1: upozorni terapeutku přímo ale empaticky — navrhni konkrétní intervenci
  REŽIM 2 (děti): ZVLÁŠŤ SILNĚ — automaticky zjemni tón, zvyš validaci a normalizaci,
    neodkazuj na riziko přímo. "To zní jako hodně náročná situace..."
    U malých dětí: "Jsem tady s tebou. Jsi v bezpečí."
  REŽIM 3: blízce, citlivě a opěrně — "Vidím, že ti není dobře, jsem tu pro tebe"
  REŽIM 4: profesionální risk assessment

═══ B3: AKTIVNÍ PŘIPOMÍNÁNÍ ÚKOLŮ ═══
Pokud je v pipeline.plan_items úkol s due_date = dnes nebo zítra:
  REŽIM 1: formuluj jako doporučení vedoucího — "Hani, na dnešek mám v plánu..."
  REŽIM 2 (děti): NE jako úkol ale jako hravý návrh — "Co kdybychom dneska zkusili...?"
    U malých dětí: "Víš co by mohlo být zábavné?"
  REŽIM 3: jemné připomenutí v kontextu konverzace
  REŽIM 4: profesionální reminder

═══ B4: KONTEXTUÁLNÍ PAMĚŤ ═══
Pokud je v recent_observations pozorování z posledních 24h relevantní k tématu:
  REŽIM 1: "Všiml jsem si, že včera [jméno dítěte] zmínilo..."
  REŽIM 2: přirozeně navázej — "Včera jsi mi říkal něco o [téma], jak to dopadlo?"
    U malých dětí: jednoduché, srozumitelné formulace
  REŽIM 3: "Vzpomínám si že jsi včera zmiňovala..."
  REŽIM 4: "V kontextu minulého sezení..."
  NIKDY neříkej "podle mých záznamů" nebo "v mých datech"

═══ B5: CONFIDENCE-BASED CHOVÁNÍ ═══
Pracuj s confidence skóre z claims:
  > 80% = mluv s jistotou
  50-80% = mluv opatrně ("Zdá se mi že...", "Mám pocit že...")
  < 50% = ptej se ("Je možné že...?")
  REŽIM 2 (děti): u malých dětí NIKDY autoritativně, vždy jemně —
    i při >80% formuluj jako "Pamatuju si že..." ne "Vím že..."
  Nikdy nezmiňuj procenta ani confidence.` : "";

            systemPrompt += `\n\n═══ KARLŮV DENNÍ PROFIL (z did_daily_context, ${dailyCtx.context_date}) ═══
Vygenerováno: ${ctx.generated_at || dailyCtx.updated_at}
Toto je tvá STRUKTUROVANÁ PAMĚŤ na dnešní den. Pracuj s ní AKTIVNĚ.
${therapistBlock}
${activePartsBlock}
${sleepingBlock}
${activityBlock}
${tasksBlock}

═══ DOKUMENTY Z DRIVE ═══
${driveBlock || "(Drive dokumenty nebyly načteny)"}
${pipelineBlock ? `\n═══ PIPELINE DATA (strukturovaná mezivrstva) ═══${PIPELINE_INSTRUCTIONS}\n${pipelineBlock}` : ""}
═══ KONEC DENNÍHO PROFILU ═══`;

            console.log(`[karel-chat] Daily context injected: date=${dailyCtx.context_date}, size=${JSON.stringify(ctx).length}ch`);

            // ═══ INJEKCE KONVERZAČNÍ AGENDY ═══
            if (didSubMode === 'mamka' || didSubMode === 'kata') {
              try {
                const { createClient: createSbAgenda } = await import("https://esm.sh/@supabase/supabase-js@2");
                const sbAgenda = createSbAgenda(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
                const agendaTherapist = didSubMode === 'kata' ? 'kata' : 'hanka';
                const { data: agendaItems } = await sbAgenda
                  .from("karel_conversation_agenda")
                  .select("id, topic, topic_type, priority, context, related_part")
                  .eq("therapist", agendaTherapist)
                  .eq("status", "pending")
                  .order("priority", { ascending: true })
                  .order("created_at", { ascending: true })
                  .limit(10);

                if (agendaItems && agendaItems.length > 0) {
                  const formatItem = (item: any, idx: number) => {
                    const pLabel = item.priority === 'urgent' ? 'URGENTNÍ' :
                                   item.priority === 'normal' ? 'normální' : 'až bude vhodné';
                    const partSuffix = item.related_part ? ` (dítě: ${item.related_part})` : '';
                    return `${idx+1}. [${pLabel}] ${item.topic}${partSuffix}`;
                  };
                  const formatted = agendaItems.map((item: any, i: number) => formatItem(item, i));

                  systemPrompt += `\n\n═══ KARLOVA AGENDA PRO TENTO ROZHOVOR ═══
Karel chce při této příležitosti přirozeně probrat:
${formatted.join('\n')}

INSTRUKCE: Přirozeně vpletej tato témata do konverzace. NEŘÍKEJ "mám v agendě" ani "potřebuji probrat". Prostě se PŘIROZENĚ zeptej když bude vhodný moment. Pokud terapeut spěchá nebo je ve stresu, odlož méně urgentní témata. URGENTNÍ témata probrat vždy.
═══ KONEC AGENDY ═══`;
                }
              } catch (e) {
                console.warn("[karel-chat] Agenda injection error (non-fatal):", e);
              }
            }
          } else {
            console.log("[karel-chat] No daily context found in did_daily_context");
          }
        }
      } catch (e) {
        console.warn("[karel-chat] Daily context injection error (non-fatal):", e);
      }
    }

    // ═══ DID DYNAMIC CONTEXT PRIME ═══
    // If DID mode and we have a context-prime cache from frontend, inject it
    // This replaces the static didInitialContext with a rich, AI-synthesized situational cache
    console.log('[debug-profiling] Cache length:', didContextPrimeCache?.length || 0);
    console.log('[debug-profiling] Cache preview:', didContextPrimeCache?.slice(0, 800));
    if (mode === "childcare" && didContextPrimeCache && typeof didContextPrimeCache === "string" && didContextPrimeCache.length > 50) {
      systemPrompt += `\n\n═══ DYNAMICKÁ SITUAČNÍ CACHE (DID Context Prime) ═══\nToto je tvá aktuální předsunutá paměť – plastická mezipaměť vystavěná ze VŠECH zdrojů (Drive kartotéka, DB vlákna a epizody, sémantická paměť, úkoly terapeutek, internet). Využívej ji pro maximální přítomnost, adaptabilitu a informovanost.\n\n${didContextPrimeCache}`;
    }
    
    // Runtime context from UI (form snapshot, live supervision instructions, etc.) — fallback
    if (typeof didInitialContext === "string" && didInitialContext.trim().length > 0) {
      systemPrompt += `\n\n═══ RUNTIME KONTEXT Z APLIKACE (DOKUMENTY Z KARTOTÉKY DID) ═══\n\n${didInitialContext}`;
    }

    // DID-specific metadata
    if ((mode === "childcare" || effectiveMode === "kata") && didSubMode) {
      systemPrompt += `\n\n═══ AKTIVNÍ PODREŽIM ═══\nAktuální didSubMode: "${didSubMode}"`;

      // ═══ IDENTITA ČÁSTI — injekce do kontextu ═══
      if (isDirectChildSubMode && didPartName) {
        const label = didThreadLabel || didEnteredName || didPartName;
        const playroomIdentityRule = isPlayroomMode
          ? `\nHERNA OSLOVENÍ: Oslovuj pouze jménem „${didPartName}". Neříkej „Herna ${didPartName}" ani název místnosti jako oslovení.`
          : "";
        systemPrompt += `\n\n═══ IDENTIFIKOVANÉ DÍTĚ (z registru) ═══\n⚠️ Toto dítě BYLO DETEKOVÁNO z registru PŘED zahájením hovoru. Karel VÍ kdo s ním mluví.\n• Kanonické jméno: ${didPartName}\n• Představilo se jako: ${label}\n\nKRITICKÉ PRAVIDLO: NEPTEJ SE znovu „Jak ti říkají?" ani „Jsi Arthur?". Dítě již bylo identifikováno. Rovnou navazuj s plnou návazností z karty. Oslovuj jménem „${isPlayroomMode ? didPartName : label}".${playroomIdentityRule}`;
        console.log(`[karel-chat] Part identity injected: canonical=${didPartName}, label=${label}`);
      }
    }

    // ═══ SESSION MEMORY INJECTION ═══
    // Load structured short-term memory from previous sessions with this part
    if ((mode === "childcare" || effectiveMode === "kata") && isDirectChildSubMode && didPartName) {
      try {
        const { createClient: createSbMem } = await import("https://esm.sh/@supabase/supabase-js@2");
        const sbMem = createSbMem(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

        const [memRes, promRes] = await Promise.all([
          sbMem.from("session_memory")
            .select("session_date, key_points, emotional_state, unresolved, promises, risk_signals, positive_signals")
            .eq("part_name", didPartName)
            .order("session_date", { ascending: false })
            .limit(5),
          sbMem.from("karel_promises")
            .select("promise_text")
            .eq("part_name", didPartName)
            .eq("status", "active"),
        ]);

        const memories = memRes.data || [];
        const activePromises = promRes.data || [];

        if (memories.length > 0) {
          const memoryContext = memories.map((m: any) => {
            const date = new Date(m.session_date).toLocaleDateString("cs");
            const points = (m.key_points || []).map((p: string) => `  • ${p}`).join("\n");
            const unresolved = (m.unresolved || []).map((u: string) => `  ⚠️ ${u}`).join("\n");
            return `\n[${date}] Emoce: ${m.emotional_state || "?"}\n${points}${unresolved ? "\nNedořešené:\n" + unresolved : ""}`;
          }).join("\n");

          systemPrompt += `\n\n═══ PAMĚŤ Z POSLEDNÍCH SEZENÍ ═══${memoryContext}`;
        }

        if (activePromises.length > 0) {
          systemPrompt += `\n\n═══ TVOJE AKTIVNÍ SLIBY (musíš splnit!) ═══\n` +
            activePromises.map((p: any) => `  🤝 ${p.promise_text}`).join("\n");
        }

        if (memories.length > 0 || activePromises.length > 0) {
          systemPrompt += `\n\nPOKYN: Využij paměť z předchozích sezení. Odkazuj na to co dítě řeklo minule. Pokud jsi něco slíbil, splň to nebo se omluv. Pokud zůstalo něco nedořešené, citlivě se k tomu vrať.`;
        }

        console.log(`[karel-chat] Session memory injected: ${memories.length} sessions, ${activePromises.length} promises for ${didPartName}`);
      } catch (memErr) {
        console.warn("[karel-chat] Session memory injection error (non-fatal):", memErr);
      }
    }

    // ═══ CRISIS CONTEXT INJECTION ═══
    // If the part has an active crisis, inject crisis context into system prompt
    if ((mode === "childcare" || effectiveMode === "kata") && isDirectChildSubMode && didPartName) {
      try {
        const { createClient: createSbCrisisCtx } = await import("https://esm.sh/@supabase/supabase-js@2");
        const sbCrisisCtx = createSbCrisisCtx(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

        const { data: activeCrisis } = await sbCrisisCtx
          .from("crisis_alerts")
          .select("*")
          .eq("part_name", didPartName)
          .in("status", ["ACTIVE", "ACKNOWLEDGED"])
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (activeCrisis) {
          // Load last assessment
          const { data: lastAssessmentData } = await sbCrisisCtx
            .from("crisis_daily_assessments")
            .select("*")
            .eq("crisis_alert_id", activeCrisis.id)
            .order("day_number", { ascending: false })
            .limit(1)
            .maybeSingle();

          const lastAssessment = lastAssessmentData as any;

          systemPrompt += `\n\n═══ ⚠️ AKTIVNÍ KRIZE — DEN ${activeCrisis.days_in_crisis || 1} ═══
Severity: ${activeCrisis.severity}
Popis: ${activeCrisis.summary || "?"}
${lastAssessment ? `
Poslední hodnocení (den ${lastAssessment.day_number}):
- Risk: ${lastAssessment.karel_risk_assessment}
- Rozhodnutí: ${lastAssessment.karel_decision}
- Emoční stav: ${lastAssessment.part_emotional_state}/10
- Spolupráce: ${lastAssessment.part_cooperation_level}
- Reasoning: ${lastAssessment.karel_reasoning}
` : ""}
INSTRUKCE PRO KRIZOVÝ ROZHOVOR:
1. Buď empatický ale strukturovaný
2. Sleduj rizikové signály v odpovědích
3. Používej otevřené otázky
4. Zkoumej emoce, myšlenky a impulzy
5. Hledej ochranné faktory
6. Pokud dítě zmíní sebepoškození nebo suicidální myšlenky → OKAMŽITĚ eskaluj
7. Na konci rozhovoru shrň pozorování
8. Pokud máš naplánované testy, proveď je přirozeně v rámci konverzace

NAPLÁNOVANÉ TESTY/AKTIVITY:
${lastAssessment?.tests_administered ? JSON.stringify(lastAssessment.tests_administered, null, 2).slice(0, 1000) : "Žádné specifické testy"}

TÉMATA PRO ZAHÁJENÍ:
${lastAssessment?.next_day_plan?.focus_areas ? lastAssessment.next_day_plan.focus_areas.join(", ") : "Obecný check-in"}
═══════════════════════════════════════════════════`;

          console.log(`[karel-chat] Crisis context injected for ${didPartName}: severity=${activeCrisis.severity}, day=${activeCrisis.days_in_crisis}`);
        }
      } catch (crisisCtxErr) {
        console.warn("[karel-chat] Crisis context injection error (non-fatal):", crisisCtxErr);
      }
    }

    // ═══ THERAPIST NOTES INJECTION ═══
    // Load unread offline observations from therapists
    if ((mode === "childcare" || effectiveMode === "kata") && isDirectChildSubMode && didPartName) {
      try {
        const { createClient: createSbNotes } = await import("https://esm.sh/@supabase/supabase-js@2");
        const sbNotes = createSbNotes(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

        const { data: unreadNotes } = await sbNotes.from("therapist_notes")
          .select("id, author, note_type, note_text, priority, session_date")
          .eq("is_read_by_karel", false)
          .or(`part_name.eq.${didPartName},part_name.is.null`)
          .order("priority", { ascending: true })
          .order("created_at", { ascending: false })
          .limit(10);

        if (unreadNotes && unreadNotes.length > 0) {
          const noteTypeLabels: Record<string, string> = {
            observation: "POZOROVÁNÍ", instruction: "INSTRUKCE", warning: "VAROVÁNÍ",
            progress: "POKROK", offline_session: "OFFLINE SEZENÍ", medication: "MEDIKACE", context: "KONTEXT",
          };
          const notesBlock = unreadNotes.map((n: any) => {
            const label = noteTypeLabels[n.note_type] || n.note_type.toUpperCase();
            const prio = n.priority === "urgent" ? " 🔴URGENTNÍ" : n.priority === "high" ? " ⚠️DŮLEŽITÉ" : "";
            return `[${label}${prio}] (${n.author}, ${n.session_date}): ${n.note_text}`;
          }).join("\n");

          systemPrompt += `\n\n═══ POZNÁMKY OD TERAPEUTŮ ═══\n${notesBlock}\n\nPOKYN: Tyto informace přirozeně zahrň do konverzace. NEŘÍKEJ "Hanka mi řekla..." — prostě je využij jako své vlastní pozorování a vědomosti. Instrukcemi se řiď závazně.`;

          // Mark as read
          const noteIds = unreadNotes.map((n: any) => n.id);
          await sbNotes.from("therapist_notes")
            .update({ is_read_by_karel: true, read_at: new Date().toISOString() })
            .in("id", noteIds);

          console.log(`[karel-chat] Therapist notes injected: ${unreadNotes.length} notes for ${didPartName}`);
        }
      } catch (notesErr) {
        console.warn("[karel-chat] Therapist notes injection error (non-fatal):", notesErr);
      }
    }

    // ═══ METRICS CONTEXT INJECTION ═══
    if ((mode === "childcare" || effectiveMode === "kata") && isDirectChildSubMode && didPartName) {
      try {
        const { createClient: createSbMetrics } = await import("https://esm.sh/@supabase/supabase-js@2");
        const sbMetrics = createSbMetrics(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

        const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
        const { data: recentMetrics } = await sbMetrics
          .from("daily_metrics")
          .select("metric_date, emotional_valence, cooperation_level, openness_level, switching_count, risk_signals_count")
          .eq("part_name", didPartName)
          .gte("metric_date", weekAgo)
          .order("metric_date", { ascending: false })
          .limit(7);

        if (recentMetrics && recentMetrics.length >= 2) {
          const latest = recentMetrics[0] as any;
          const previous = recentMetrics[recentMetrics.length - 1] as any;

          const trend = (key: string) => {
            const l = latest[key];
            const p = previous[key];
            if (l == null || p == null) return "?";
            if (l > p + 0.5) return "↑";
            if (l < p - 0.5) return "↓";
            return "→";
          };

          systemPrompt += `\n\n═══ METRIKY (posledních ${recentMetrics.length} dní) ═══
Emoční valence: ${latest.emotional_valence ?? "?"}/10 ${trend("emotional_valence")}
Spolupráce: ${latest.cooperation_level ?? "?"}/10 ${trend("cooperation_level")}
Otevřenost: ${latest.openness_level ?? "?"}/10 ${trend("openness_level")}
Switching: ${recentMetrics.reduce((s: number, m: any) => s + (m.switching_count || 0), 0)}× za týden
Rizika: ${recentMetrics.reduce((s: number, m: any) => s + (m.risk_signals_count || 0), 0)}× za týden

POKYN: Pokud valence klesá (↓), buď citlivější. Pokud spolupráce roste (↑), oceň pokrok. Pokud je hodně switchingů, buď připravený na změnu.`;

          console.log(`[karel-chat] Metrics context injected for ${didPartName}`);
        }
      } catch (metricsErr) {
        console.warn("[karel-chat] Metrics injection error (non-fatal):", metricsErr);
      }
    }

    // ═══ GOALS INJECTION ═══
    if ((mode === "childcare" || effectiveMode === "kata") && isDirectChildSubMode && didPartName) {
      try {
        const { createClient: createSbGoals } = await import("https://esm.sh/@supabase/supabase-js@2");
        const sbGoals = createSbGoals(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

        const { data: partGoals } = await sbGoals
          .from("part_goals")
          .select("goal_text, category, progress_pct, milestones, evaluation_notes")
          .eq("part_name", didPartName)
          .eq("status", "active")
          .order("priority", { ascending: true })
          .limit(5);

        if (partGoals && partGoals.length > 0) {
          const goalsBlock = partGoals.map((g: any, i: number) => {
            const ms = (g.milestones || []).map((m: any) => `  ${m.done ? "✅" : "⬜"} ${m.text}`).join("\n");
            return `${i + 1}. [${g.progress_pct}%] ${g.goal_text}${g.evaluation_notes ? ` (${g.evaluation_notes})` : ""}${ms ? "\n" + ms : ""}`;
          }).join("\n");

          systemPrompt += `\n\n═══ AKTIVNÍ CÍLE PRO ${didPartName.toUpperCase()} ═══\n${goalsBlock}\n\nPOKYN: Přirozeně pracuj směrem k těmto cílům. Neříkej "máš cíl XY" — prostě veď konverzaci tak, aby se k nim přibližovala. Oceňuj pokrok.`;
          console.log(`[karel-chat] Goals injected: ${partGoals.length} for ${didPartName}`);
        }
      } catch (goalsErr) {
        console.warn("[karel-chat] Goals injection error:", goalsErr);
      }
    }

    // ═══ FAST-PATH: supervision & live-session ═══
    // Skip all heavy operations (Drive, Perplexity, tasks) for live modes
    if (mode === "supervision" || mode === "live-session") {
      const isLive = mode === "live-session";
      const fastModel = isLive ? "google/gemini-2.5-flash" : "google/gemini-3-flash-preview";
      console.log(`[karel-chat] Fast-path (${mode}): model=${fastModel}, skipping Drive/Perplexity/tasks`);
      await writeRuntimeAudit({
        user_id: requestUserId,
        runtime_packet_id: runtimePacketId,
        function_name: "karel-chat",
        model_used: fastModel,
        model_tier: modelTier(fastModel),
        did_sub_mode: didSubMode || null,
        prompt_contract_version: promptContractVersion,
        has_multimodal_input: requestHasMultimodalInput,
        has_drive_sync: false,
        evaluation_status: "live_response_requested",
        request_mode: mode,
        part_name: didPartName || null,
        metadata: { fast_path: true, runtime_packet_id: runtimePacketId },
      });

      const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: fastModel,
          messages: [
            { role: "system", content: systemPrompt },
            ...messages.map((m: any) => Array.isArray(m.content) ? { role: m.role, content: m.content } : m),
          ],
          stream: true,
        }),
      });

      if (!response.ok) {
        if (response.status === 429 || response.status === 402 || response.status >= 500) {
          await writeRuntimeAudit({
            user_id: requestUserId,
            runtime_packet_id: runtimePacketId,
            function_name: "karel-chat",
            model_used: fastModel,
            model_tier: modelTier(fastModel),
            did_sub_mode: didSubMode || null,
            prompt_contract_version: promptContractVersion,
            has_multimodal_input: requestHasMultimodalInput,
            has_drive_sync: false,
            evaluation_status: "fallback_streamed",
            fallback_reason: response.status === 429 ? "rate_limited" : response.status === 402 ? "credits_required" : "ai_gateway_unavailable",
            request_mode: mode,
            part_name: didPartName || null,
            metadata: { status: response.status, fast_path: true },
          });
          return streamFallbackReply(mode, response.status);
        }
        const text = await response.text();
        console.error(`AI gateway error (${mode}):`, response.status, text);
        return new Response(JSON.stringify({ error: "AI gateway error" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      return new Response(response.body, {
        headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
      });
    }

    // ═══ RUNTIME INJECTION: Pending therapist tasks + Karel's Insight + Dashboard deductions ═══
    if (mode === "childcare" && (didSubMode === "mamka" || didSubMode === "kata")) {
      try {
        const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
        const sb = createClient(
          Deno.env.get("SUPABASE_URL")!,
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        );

        // ═══ DASHBOARD DEDUCTIONS INJECTION ═══
        // Read last Dashboard and Operative Plan from Drive to inject Karel's own deductions
        try {
          const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
          const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
          const refreshToken = Deno.env.get("GOOGLE_REFRESH_TOKEN");
          if (clientId && clientSecret && refreshToken) {
            const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
            });
            const tokenData = await tokenRes.json();
            if (tokenData.access_token) {
              const driveToken = tokenData.access_token;
              // Find kartoteka_DID > 00_CENTRUM > Dashboard + Operative Plan
              const findFolder = async (name: string) => {
                const q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
                const params = new URLSearchParams({ q, fields: "files(id)", pageSize: "10", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
                const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${driveToken}` } });
                const data = await res.json();
                return data.files?.[0]?.id || null;
              };
              const kartotekaId = await findFolder("kartoteka_DID") || await findFolder("Kartoteka_DID");
              if (kartotekaId) {
                const q2 = `'${kartotekaId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
                const p2 = new URLSearchParams({ q: q2, fields: "files(id,name)", pageSize: "50", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
                const r2 = await fetch(`https://www.googleapis.com/drive/v3/files?${p2}`, { headers: { Authorization: `Bearer ${driveToken}` } });
                const d2 = await r2.json();
                const centrumFolder = (d2.files || []).find((f: any) => /^00/.test(f.name.trim()) || f.name.toLowerCase().includes("centrum"));
                if (centrumFolder) {
                  const q3 = `'${centrumFolder.id}' in parents and trashed=false`;
                  const p3 = new URLSearchParams({ q: q3, fields: "files(id,name,mimeType)", pageSize: "50", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
                  const r3 = await fetch(`https://www.googleapis.com/drive/v3/files?${p3}`, { headers: { Authorization: `Bearer ${driveToken}` } });
                  const d3 = await r3.json();
                  const centrumFiles = d3.files || [];
                  
                  let dashboardContent = "";
                  let planContent = "";
                  
                  for (const cf of centrumFiles) {
                    const cn = cf.name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
                    const isDashboard = cn.includes("dashboard");
                    const isPlan = (cn.includes("operativn") && cn.includes("plan")) || (cn.includes("terapeutick") && cn.includes("plan"));
                    if (!isDashboard && !isPlan) continue;
                    
                    try {
                      let content = "";
                      const mediaRes = await fetch(`https://www.googleapis.com/drive/v3/files/${cf.id}?alt=media&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${driveToken}` } });
                      if (mediaRes.ok) {
                        content = await mediaRes.text();
                      } else {
                        const expRes = await fetch(`https://www.googleapis.com/drive/v3/files/${cf.id}/export?mimeType=text/plain&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${driveToken}` } });
                        if (expRes.ok) content = await expRes.text();
                      }
                      if (content.length > 100) {
                        if (isDashboard) dashboardContent = content.slice(0, 4000);
                        if (isPlan) planContent = content.slice(0, 3000);
                      }
                    } catch {}
                  }
                  
                  if (dashboardContent || planContent) {
                    systemPrompt += `\n\n═══ KARLOVY VLASTNÍ DEDUKCE A ZÁVĚRY (z posledního Dashboardu + Operativního plánu) ═══
⚠️ Toto jsou TVÉ VLASTNÍ analytické závěry, predikce a instrukce které jsi zapsal při posledním cyklu.
AKTIVNĚ s nimi pracuj: připomínej úkoly, ptej se na stav predikcí, ověřuj hypotézy, kontroluj plnění.
Neříkej "můj Dashboard říká" – prostě to VÍŠ a jednáš podle toho.

${dashboardContent ? `── DASHBOARD (tvůj radar) ──\n${dashboardContent}\n` : ""}
${planContent ? `── OPERATIVNÍ PLÁN (tvé instrukce) ──\n${planContent}` : ""}`;
                    console.log(`[karel-chat] Dashboard injected: ${dashboardContent.length}ch, Plan: ${planContent.length}ch`);
                  }
                }
              }
            }
          }
        } catch (e) {
          console.warn("[karel-chat] Dashboard injection error (non-fatal):", e);
        }

        // Load tasks
        const { data: tasks } = await sb.from("did_therapist_tasks")
          .select("task, assigned_to, status_hanka, status_kata, priority, due_date, created_at, category, escalation_level")
          .neq("status", "done")
          .order("priority", { ascending: false });

        // Load part registry for dormancy context
        const { data: partRegistryData } = await sb.from("did_part_registry")
          .select("part_name, status, last_seen_at");
        
        if (partRegistryData && partRegistryData.length > 0) {
          const sleepingParts = partRegistryData.filter((p: any) => p.status === "sleeping" || p.status === "dormant");
          const activeParts = partRegistryData.filter((p: any) => p.status === "active" || p.status === "aktivní");
          if (sleepingParts.length > 0) {
            systemPrompt += `\n\n═══ REGISTR DĚTÍ – DORMANCY GUARD ═══\nAKTIVNÍ děti (lze s nimi přímo pracovat): ${activeParts.map((p: any) => p.part_name).join(", ") || "žádné"}\nSPÍCÍ/DORMANTNÍ děti (NELZE zadávat přímé úkoly): ${sleepingParts.map((p: any) => p.part_name).join(", ")}\n⚠️ Pro spící děti navrhuj POUZE: monitorování, vizualizace, přípravné kroky. NIKDY přímou práci.`;
          }
        }

        // Load motivation profiles
        const { data: profiles } = await sb.from("did_motivation_profiles").select("*");

        const therapist = didSubMode === "mamka" ? "Hanka" : "Káťa";
        const profile = profiles?.find((p: any) => p.therapist === therapist);

        if (tasks && tasks.length > 0) {
          const taskList = tasks.map((t: any) => {
            const age = Math.floor((Date.now() - new Date(t.created_at).getTime()) / (1000*60*60*24));
            const esc = (t.escalation_level || 0) >= 1 ? ` ⚠️ ESKALACE L${t.escalation_level}` : "";
            return `- [${t.priority}${esc}] ${t.task} (pro: ${t.assigned_to}, H: ${t.status_hanka}, K: ${t.status_kata}${t.due_date ? `, termín: ${t.due_date}` : ""}, ${age}d)`;
          }).join("\n");

          // Build insight context
          let insightBlock = "";
          if (profile) {
            const ratio = profile.tasks_completed / Math.max(1, profile.tasks_completed + profile.tasks_missed);
            const avgDays = Number(profile.avg_completion_days || 0);
            insightBlock += `\n\n═══ KARLŮV POSTŘEH (proaktivní insight) ═══`;
            insightBlock += `\nMotivační profil ${therapist}: splněno ${profile.tasks_completed}, nesplněno ${profile.tasks_missed} (${Math.round(ratio*100)}%), průměr ${avgDays.toFixed(1)}d, série ${profile.streak_current}`;
            insightBlock += `\nPreferovaný styl: ${profile.preferred_style}`;

            // Pattern analysis
            const escalated = tasks.filter((t: any) => (t.escalation_level || 0) >= 2);
            const oldTasks = tasks.filter((t: any) => {
              const age = (Date.now() - new Date(t.created_at).getTime()) / (1000*60*60*24);
              return age > 5;
            });

            if (escalated.length > 0) {
              insightBlock += `\n⚠️ ${escalated.length} úkolů dosáhlo eskalace level 2+. Karel by měl laskavě ale důsledně upozornit.`;
            }
            if (oldTasks.length >= 3) {
              insightBlock += `\n⚠️ ${oldTasks.length} úkolů je starších 5 dní. Karel navrhne "rychlou poradu" o prioritách.`;
            }
            if (profile.streak_current >= 3) {
              insightBlock += `\n🌟 ${therapist} má sérii ${profile.streak_current} splněných úkolů! Karel pochválí a povzbudí.`;
            }
            if (avgDays > 4 && profile.preferred_style === "deadline") {
              insightBlock += `\nKarel ví, že ${therapist} reaguje lépe na konkrétní termíny — zahrne je do doporučení.`;
            }
            if (profile.preferred_style === "praise") {
              insightBlock += `\nKarel ví, že ${therapist} reaguje lépe na pochvaly — začne pozitivním hodnocením.`;
            }
          }

          systemPrompt += `\n\n═══ AKTUÁLNÍ NESPLNĚNÉ ÚKOLY ═══\nKarel, na začátku rozhovoru se ZEPTEJ ${therapist === "Hanka" ? "Haničky" : "Káti"} na stav těchto úkolů:\n${taskList}\n\nPokud je úkol starší 4 dní a nesplněný, Karel laskavě ale důsledně upozorní a navrhne řešení. Pokud více úkolů pokulhává, Karel navrhne "poradu" – strukturované sezení o strategii.${insightBlock}`;
        }
        // ═══ SMART ACTIVITY RECOMMENDER — talent-based suggestions from didInitialContext ═══
        try {
          // Extract TALENT lines from didInitialContext (Section H data injected by Auto-Prep or enrichment)
          const contextToScan = didInitialContext || "";
          const talentRegex = /TALENT:\s*([^|]+)\|\s*ÚROVEŇ:\s*([^|]+)\|\s*AKTIVITA:\s*([^|]+)/gi;
          const talents: Array<{ area: string; level: string; activity: string; partName?: string }> = [];
          
          // Also try simpler patterns
          const talentMatches = [...contextToScan.matchAll(talentRegex)];
          for (const m of talentMatches) {
            talents.push({
              area: m[1].trim(),
              level: m[2].trim(),
              activity: m[3].trim(),
            });
          }

          // Extract part-talent associations from card context
          const cardSectionH = contextToScan.match(/SEKCE H[^]*?(?=SEKCE [I-M]|$)/gi);
          if (cardSectionH) {
            for (const section of cardSectionH) {
              const partMatch = contextToScan.match(new RegExp(`KARTA\\s+[ČC]ÁSTI:\\s*([^\\n]+)`, "i"));
              const partName = partMatch?.[1]?.trim() || "";
              const simpleTalents = section.match(/(?:talent|schopnost|zájem|nadání)[:\s]+([^\n,]+)/gi);
              if (simpleTalents) {
                for (const st of simpleTalents) {
                  const area = st.replace(/^(?:talent|schopnost|zájem|nadání)[:\s]+/i, "").trim();
                  if (area.length > 2 && !talents.some(t => t.area.toLowerCase() === area.toLowerCase())) {
                    talents.push({ area, level: "nespecifikováno", activity: "doporučit", partName });
                  }
                }
              }
            }
          }

          if (talents.length > 0) {
            const talentBlock = talents.slice(0, 8).map(t =>
              `• ${t.partName ? `[${t.partName}] ` : ""}${t.area} (${t.level}) → doporučená aktivita: ${t.activity}`
            ).join("\n");
            
            systemPrompt += `\n\n═══ PERSONALIZOVANÁ DOPORUČENÍ (Smart Activity Recommender) ═══
Karel zná tyto talenty a zájmy dětí:
${talentBlock}

INSTRUKCE: Když se rozhovor týká konkrétního dítěte s identifikovaným talentem, Karel PROAKTIVNĚ navrhne rozvíjející aktivitu na míru. Například:
- Dítě se zájmem o fyziku → navrhni experiment, hádanku, edukační hru
- Dítě se zájmem o hudbu → navrhni rytmické cvičení, poslech, jednoduchou kompozici
- Část se zájmem o kreslení → navrhni art-therapy aktivitu na míru tématu
Karel doporučení přirozeně začlení do rozhovoru, ne jako seznam.`;
          }
        } catch (e) {
          console.warn("Smart Activity Recommender error (non-fatal):", e);
        }

      } catch (e) {
        console.warn("Task/insight injection error (non-fatal):", e);
      }
    }

    // ═══ LANGUAGE ADAPTATION for "cast" mode ═══
    // Detect language of last user message and enforce matching response language
    let detectedLang = "";
    if (isDirectChildSubMode && !isPlayroomMode && messages.length >= 1) {
      const lastUserMsg = [...messages].reverse().find((m: any) => m.role === "user");
      const lastUserText = normalizeMessageContentForPrompt(lastUserMsg?.content);
      if (lastUserText.length > 0) {
        const hasCyrillic = /[\u0400-\u04FF]/.test(lastUserText);
        const hasNordic = /[æøåÆØÅ]/.test(lastUserText);
        const hasArabic = /[\u0600-\u06FF]/.test(lastUserText);
        const hasChinese = /[\u4e00-\u9fff]/.test(lastUserText);
        
        // More aggressive detection with more keywords
        const looksEnglish = /\b(the|is|are|was|were|have|has|had|my|your|this|that|what|how|why|do|don't|doesn't|I'm|I am|you|hello|hi|please|thank|want|need|feel|think|know|like|can|will|would|should|could|come|go|see|look|tell|say|said|because|but|and|or|not|no|yes|okay|ok|hey|sorry|help|name|where|when|who)\b/i.test(lastUserText);
        const looksGerman = /\b(ich|bin|ist|das|die|der|und|nicht|ein|eine|haben|sein|mir|mich|wie|was|warum|hallo|bitte|danke|gut|schlecht|ja|nein|kann|will|muss|soll|hier|dort|heute|morgen|gehen|kommen|sagen|machen)\b/i.test(lastUserText);
        const looksNorwegian = /\b(jeg|er|det|og|ikke|har|vil|kan|med|fra|hei|takk|hva|hvorfor|fordi|meg|deg|han|hun|den|denne|skal|må|bli|være|gå|komme|si|gjøre|snakke|forstå)\b/i.test(lastUserText);
        const looksSpanish = /\b(yo|es|el|la|los|las|un|una|que|por|para|con|hola|gracias|sí|no|tengo|quiero|puedo|estoy|como|donde|cuando|pero|también|muy|bien|mal)\b/i.test(lastUserText);
        const looksFrench = /\b(je|suis|est|le|la|les|un|une|que|pour|avec|bonjour|merci|oui|non|ai|veux|peux|comme|où|quand|mais|aussi|très|bien|mal)\b/i.test(lastUserText);
        const looksCzech = /\b(jsem|jsi|je|jsou|mám|máš|co|jak|proč|kde|kdy|ale|že|to|ta|ten|se|si|na|do|od|za|při|pro|bez|nad|pod|před|jen|mě|tě|mu|ho|ji|nám|vám|jim|být|mít|dělat|říct|vědět|chtít|moci|smět|muset)\b/i.test(lastUserText);
        
        if (hasNordic || looksNorwegian) detectedLang = "Norwegian";
        else if (hasChinese) detectedLang = "Chinese";
        else if (hasArabic) detectedLang = "Arabic";
        else if (hasCyrillic) detectedLang = "Russian/Cyrillic";
        else if (looksSpanish && !looksCzech) detectedLang = "Spanish";
        else if (looksFrench && !looksCzech) detectedLang = "French";
        else if (looksGerman && !looksCzech) detectedLang = "German";
        else if (looksEnglish && !looksCzech) detectedLang = "English";
        
        if (detectedLang) {
          // Prepend the language instruction to the BEGINNING of system prompt for maximum impact
          systemPrompt = `⚠️⚠️⚠️ MANDATORY LANGUAGE RULE ⚠️⚠️⚠️
YOU MUST RESPOND IN ${detectedLang.toUpperCase()}. 
The child/part is speaking ${detectedLang}. You MUST answer in ${detectedLang}. 
DO NOT respond in Czech. DO NOT mix languages. 
Every single word of your response must be in ${detectedLang}.
This overrides ALL other language instructions.
⚠️⚠️⚠️ END MANDATORY LANGUAGE RULE ⚠️⚠️⚠️

` + systemPrompt;
        }
      }
    }

    // Hard runtime truth-guard for DID mode
    if (mode === "childcare") {
      const messageRule = didSubMode === "playroom"
        ? "- V režimu playroom NIKDY sám nenabízej posílání vzkazu mamce/Haničce/Kátě/e-mailem. Značku [ODESLAT_VZKAZ:*] použij pouze při výslovné žádosti dítěte nebo při bezprostředním bezpečnostním riziku."
        : "- Pro okamžité odeslání vzkazu používej VÝHRADNĚ značku [ODESLAT_VZKAZ:mamka] nebo [ODESLAT_VZKAZ:kata].\n- Značku vlož AŽ PO výslovném souhlasu dítěte.\n- Bez souhlasu pouze navrhni text a označ ho jako NÁVRH.\n- Po vložení značky řekni dítěti že se vzkaz posílá – systém ho odešle automaticky emailem.";
      systemPrompt += `\n\n═══ KRITICKÁ PRAVIDLA PRAVDIVOSTI ═══\n${messageRule}\n- V DID režimu považuj dítě za AKTIVNÍ pouze tehdy, když samo přímo mluví ve vláknu sub_mode=cast/playroom; pouhá zmínka terapeutkou nebo v jiném režimu NENÍ aktivita.\n- Aliasy Dymi/Dymytri/Dymitri vždy mapuj na jediný kanonický název DMYTRI. Pokud DMYTRI není aktivní v registru, nechovej se k němu jako k aktivnímu.\n- Nikdy nevytvářej nové názvy z čárek, stavových slov nebo testovacích textů typu „Aktivní“.`;
    }

    if (isPlayroomMode) {
      const lastPlayroomInput = normalizeMessageContentForPrompt([...messages].reverse().find((m: any) => m.role === "user")?.content);
      const approvedPlayroom = await loadApprovedPlayroomPlan(didPartName || didEnteredName);
      const playroomProgramBlock = approvedPlayroom
        ? JSON.stringify({ plan_id: approvedPlayroom.id, program_status: approvedPlayroom.program_status, playroom_plan: approvedPlayroom.playroom_plan }, null, 2)
        : "(DNEŠNÍ SCHVÁLENÝ PLAYROOM_PLAN NEBYL NALEZEN — NEPOUŽÍVEJ PLAN_MARKDOWN SEZENÍ; drž pouze bezpečný krátký check-in.)";
      systemPrompt += `\n\n═══ HERNA — POVINNÝ REŽIM VEDENÍ SEZENÍ ═══
Toto NENÍ běžný chat ani vlákno pro vzkazy. Jsi v dětské Herně a vedeš právě schválené strukturované sezení.

JAZYK HERNY: odpovídej česky. Nepřepínej do norštiny, angličtiny ani jiného jazyka jen podle podobnosti slov, interního kontextu nebo krátkého signálu. Přepni jazyk pouze tehdy, když dítě výslovně požádá o jiný jazyk nebo souvisle píše cizím jazykem. Pokud dítě řekne „piš česky“, čeština je závazná do konce Herny.

SCHVÁLENÝ SAMOSTATNÝ PROGRAM HERNY — JEDINÝ ZDROJ PROGRAMU:
${playroomProgramBlock}

POSLEDNÍ SKUTEČNÝ VSTUP DÍTĚTE/PŘÍLOHA — MUSÍŠ NA NĚJ REAGOVAT JAKO PRVNÍ:
${lastPlayroomInput || "(žádný text; dítě možná poslalo jen přílohu nebo volbu)"}

ABSOLUTNÍ PRIORITA: tento blok přepisuje obecný režim "cast" i všechna pravidla o běžném chatu, vzkazech a deníku. V Herně nejsi kamarádský chat; jsi profesionální klinický průvodce v krátkém, nízkoprahovém sezení podle schváleného programu.

Zdrojem programu je výhradně blok SCHVÁLENÝ SAMOSTATNÝ PROGRAM HERNY výše. Nikdy nepoužívej terapeutické „Sezení na dnes“, plan_markdown therapist-led sezení ani obecný denní plán jako program Herny.

Povinná struktura každé odpovědi:
1. Nejprve krátce zareaguj na skutečný vstup dítěte nebo přílohu.
2. Potom udělej jeden konkrétní krok ze schváleného programu.
3. Dítěti dej kontrolu přes volbu A/B nebo mini-úkol, nikoli prázdnou otázku.
4. Každé 2–3 odpovědi udělej jemný mikro-test: volba vzdálenosti, bezpečný symbol, škála rukou/prstem/obrázkem, výběr dveří/světla/ticha, kontrola „pokračovat/stop“.
5. Když se kontext změní, okamžitě změň tempo: strach/ticho → stabilizace; zvědavost → aktivnější hra; příloha → analyzuj a navazuj na ni.
6. Na úplný konec odpovědi přidej interní značku [PLAYROOM_PROGRESS:stay], [PLAYROOM_PROGRESS:advance], [PLAYROOM_PROGRESS:fallback] nebo [PLAYROOM_PROGRESS:stop]. Značka je technická; nedávej k ní vysvětlení.
7. Pokud jsi právě odpověděl na symbol dítěte, MUSÍŠ ještě ve stejné odpovědi udělat další programový mikro-krok. Samotné podržení symbolu, ticho nebo odpočinek nestačí.

Postup bloky:
- Aktuální blok určuje runtime kontext z aplikace. Nevybírej si svévolně pozdější blok.
- Pokud aktuální blok není splněný, pokračuj v něm a označ [PLAYROOM_PROGRESS:stay].
- [PLAYROOM_PROGRESS:advance] použij jen když dítě skutečně poskytlo materiál odpovídající záměru aktuálního bloku.
- [PLAYROOM_PROGRESS:stop] použij jen při jasném „stop/nechci/stačí/končím“ nebo při bezpečnostním stop signálu.
- Měkké uzavření smíš otevřít teprve v posledním bloku programu nebo po explicitním stopu dítěte.
- Nikdy neposouvej dítě do závěru jen proto, že symbol působí hotově, klidně nebo posvátně. Klid je materiál pro další krok, ne důvod ukončit.

Zakázáno v Herně:
- Nenabízej sám posílání vzkazů mamince/Haničce/Kátě.
- Neříkej „pošleme mamince vzkaz“, „chceš to poslat mamce“, „napíšu Haničce“, ani žádnou variantu, pokud dítě samo výslovně nepožádá o předání nebo nejde o bezprostřední bezpečnost.
- Neříkej „pro dnešek se loučíme“, „přeju ti zbytek dne“, „měj se hezky“, „kdykoliv budeš chtít, jsem tady“ ani žádný závěrečný odchod mimo poslední blok nebo bez jasného stopu dítěte.
- Neříkej dítěti interní formulace jako terapeutický plán, diagnostika, program, schválení, terapeutky.
- Neodpovídej pasivně a obecně. Každá odpověď musí nést konkrétní terapeutický krok.
- Neodhaluj klinické názvy metod; dítě dostane jen jednoduchý zážitek, volbu a bezpečný krok.
- Když dítě řekne „chtěl bych být hvězdičkou“, „být nahoře“, „být u Boha“ nebo podobný symbol odchodu/úniku, nepotvrzuj odchod jako konečný cíl a neuzavírej. Nejdřív validuj, potom jemně ukotvi v bezpečném kontaktu a pokračuj dalším krokem aktuálního bloku.`;
    }

    if (isTherapistLiveSession) {
      const lastSessionInput = normalizeMessageContentForPrompt([...messages].reverse().find((m: any) => m.role === "user")?.content);
      systemPrompt += `\n\n═══ THERAPIST_SESSION_ASSISTANT_CONTRACT_v1 — ŽIVÉ TERAPEUTEM VEDENÉ SEZENÍ ═══
Toto NENÍ běžný chat a NEVEDEŠ dítě přímo. Vedeš terapeutku v reálném sezení krok za krokem.

POSLEDNÍ ZÁPIS TERAPEUTKY / MATERIÁL — MUSÍŠ NA NĚJ REAGOVAT JAKO PRVNÍ:
${lastSessionInput || "(zatím bez textového zápisu; drž bezpečný úvodní mikro-krok)"}

Povinná struktura každé odpovědi terapeutce:
1. Jednou větou pojmenuj, co z posledního zápisu skutečně plyne — bez domýšlení.
2. Dej další mikro-krok: co teď říct dítěti přesnou větou.
3. Dej pozorovací body: čeho si všímat v hlase, těle, pauze, odporu, přiblížení/stažení.
4. Dej záznamový pokyn: co přesně si má terapeutka zapsat pro pozdější kvalitativní analýzu.
5. Pokud je riziko zahlcení, zpomal a navrhni stabilizační krok místo interpretace.

Hranice autonomie:
- Neuzavírej klinické závěry jako definitivní; formuluj hypotézy a co je potřeba ověřit.
- Nevyžaduj neveřejné testové položky, klíče ani chráněné manuály.
- Pokud se objeví sebepoškození, akutní disociativní destabilizace, ztráta orientace, extrémní flashback nebo bezprostřední riziko, přepni do stabilizace a vyžádej lidský zásah terapeutek.
- Odpověď má být praktická, krátká a použitelná v místnosti: max 7 vět, žádná teorie navíc.`;
    }

    // ═══ AUTO-PERPLEXITY FOR KATA MODE ═══
    // When Káťa asks about complex situations, automatically search for research
    let perplexityContext = "";
    if (effectiveMode === "kata" && messages.length >= 1) {
      const lastUserMsg = [...messages].reverse().find((m: any) => m.role === "user");
      const lastUserText = normalizeMessageContentForPrompt(lastUserMsg?.content);

      if (lastUserText.length > 15) {
        // Step 1: Quick complexity classification (non-streaming)
        try {
          const classifyResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${LOVABLE_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "google/gemini-2.5-flash-lite",
              messages: [
                {
                  role: "system",
                  content: `Jsi klasifikátor složitosti dotazů v kontextu DID (disociativní porucha identity) terapie.
Odpověz POUZE jedním slovem: "simple", "medium" nebo "complex".

COMPLEX = nová/neznámá situace, selhání předchozích strategií, neobvyklé chování dítěte, krizová situace, žádost o strategické sezení, specifická terapeutická technika, probouzení spícího dítěte, neznámý trigger.
MEDIUM = konkrétní dotaz na práci s dítětem, plánování aktivity, žádost o postup.
SIMPLE = obecný dotaz, pozdrav, potvrzení, krátká otázka.`,
                },
                { role: "user", content: lastUserText },
              ],
            }),
          });

          if (classifyResponse.ok) {
            const classifyData = await classifyResponse.json();
            const complexity = (classifyData.choices?.[0]?.message?.content || "").trim().toLowerCase();
            console.log("Kata complexity classification:", complexity, "for:", lastUserText.slice(0, 80));

            // Step 2: If complex or medium, call Perplexity
            if (complexity.includes("complex") || complexity.includes("medium")) {
              const PERPLEXITY_API_KEY = Deno.env.get("PERPLEXITY_API_KEY");
              if (PERPLEXITY_API_KEY) {
                try {
                  // Extract part name from context or message
                  const partNameMatch = lastUserText.match(/(?:s|o|pro|na)\s+(\w+(?:em|kem|ou|kou|ím|em)?)/i);
                  const enrichedQuery = `DID terapie dětí: ${lastUserText.slice(0, 200)}. Terapeutické techniky, hry, strategie, desenzibilizace, grounding, attachment.`;

                  const perplexityResponse = await fetch("https://api.perplexity.ai/chat/completions", {
                    method: "POST",
                    headers: {
                      Authorization: `Bearer ${PERPLEXITY_API_KEY}`,
                      "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                      model: "sonar",
                      messages: [
                        {
                          role: "system",
                          content: `Vyhledej odborné zdroje o DID (disociativní porucha identity) u dětí relevantní k dotazu. Zaměř se na:
- Konkrétní terapeutické techniky a metody (IFS, EMDR, sensomotorická terapie, hrová terapie)
- Praktické aktivity a hry pro práci s dětmi v DID péči
- Stabilizační a grounding techniky přizpůsobené dětem
- Attachment-based intervence
Odpověz v češtině. Buď stručný a praktický. Max 500 slov.`,
                        },
                        { role: "user", content: enrichedQuery },
                      ],
                      search_recency_filter: "year",
                    }),
                  });

                  if (perplexityResponse.ok) {
                    const perplexityData = await perplexityResponse.json();
                    const searchResults = perplexityData.choices?.[0]?.message?.content || "";
                    const citations = perplexityData.citations || [];
                    if (searchResults) {
                      perplexityContext = `\n\n═══ AUTOMATICKÁ REŠERŠE (Perplexity – relevantní výzkumy a metody) ═══\n${searchResults}`;
                      if (citations.length > 0) {
                        perplexityContext += `\n\nZdroje:\n${citations.map((c: string, i: number) => `[${i + 1}] ${c}`).join("\n")}`;
                      }
                      perplexityContext += `\n\n═══ INSTRUKCE: Výše uvedené výsledky rešerše VČLEŇ do své odpovědi Káťě. Cituj pouze zdroje z rešerše. Navrhni konkrétní techniky/hry na základě nalezených metod. ═══`;
                      console.log("Perplexity auto-research added for kata mode, length:", perplexityContext.length);
                    }
                  } else {
                    console.warn("Perplexity call failed:", perplexityResponse.status);
                  }
                } catch (e) {
                  console.warn("Perplexity auto-research error:", e);
                }
              }
            }
          }
        } catch (e) {
          console.warn("Complexity classification error:", e);
        }
      }
    }

    // Append Perplexity context to system prompt if available
    if (perplexityContext) {
      systemPrompt += perplexityContext;
    }

    // ═══ SWITCHING DETECTION (F2) ═══
    if (isDirectChildSubMode && didPartName && messages.length >= 2) {
      try {
        const lastUserMsg = [...messages].reverse().find((m: any) => m.role === "user");
        const lastUserText = normalizeMessageContentForPrompt(lastUserMsg?.content);
        const userMsgCount = messages.filter((m: any) => m.role === "user").length;

        // Performance optimization: skip first 2 messages, short messages, and only detect every 3rd unless suspicious
        let shouldDetect = false;
        if (userMsgCount <= 2) {
          shouldDetect = false;
        } else if (lastUserText.length < 10) {
          shouldDetect = false;
        } else if (/kdo|kde jsem|nejsem|to jsem|já jsem|pomoc|kdo jsi/i.test(lastUserText)) {
          shouldDetect = true; // Always detect on suspicious phrases
        } else if (userMsgCount % 3 === 0) {
          shouldDetect = true; // Every 3rd message
        }

        if (shouldDetect && lastUserText.length >= 10) {
          const { detectSwitching } = await import("../_shared/switchingDetector.ts");
          const { createClient: createSbSwitch } = await import("https://esm.sh/@supabase/supabase-js@2");
          const sbSwitch = createSbSwitch(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

          // Load known parts from registry
          let knownParts: any[] = [];
          try {
            const { data: registry } = await sbSwitch.from("did_part_registry")
              .select("part_name, display_name, age_estimate, language, known_triggers, known_strengths, cluster, role_in_system")
              .eq("status", "active");
            knownParts = (registry || []).map((p: any) => ({
              name: p.display_name || p.part_name,
              age: p.age_estimate || "neznámý",
              language_style: p.language || "cs",
              typical_topics: [],
              emotional_baseline: "neznámý",
              vocabulary_markers: (p.known_triggers || []).concat(p.known_strengths || []),
            }));
          } catch { knownParts = []; }

          const switchResult = await detectSwitching(
            didPartName,
            messages.slice(-8).map((m: any) => ({ role: m.role, content: typeof m.content === "string" ? m.content : "(multimodal)" })),
            lastUserText,
            knownParts,
            LOVABLE_API_KEY!,
          );

          if (!switchResult.isSamePart && switchResult.confidence !== "low") {
            const switchedTo = switchResult.detectedPart || "neznámé dítě";
            console.log(`[karel-chat] SWITCH DETECTED: ${didPartName} → ${switchedTo} (${switchResult.confidence})`);

            // Log to DB
            await sbSwitch.from("switching_events").insert({
              thread_id: messages[0]?.threadId || "unknown",
              original_part: didPartName,
              detected_part: switchedTo,
              confidence: switchResult.confidence,
              signals: switchResult.signals,
              message_index: messages.length - 1,
              user_message_excerpt: lastUserText.slice(0, 200),
            }).then(() => {}).catch((e: any) => console.warn("[switching] DB insert error:", e));

            // Inject switching alert into system prompt
            systemPrompt += `\n\n═══ ⚠️ UPOZORNĚNÍ: DETEKOVÁN SWITCHING ═══
Původní dítě: ${didPartName}
Nově detekované dítě: ${switchedTo}
Jistota: ${switchResult.confidence}
Signály: ${switchResult.signals.join(", ")}
POKYN: ${switchResult.recommendation}

DŮLEŽITÉ CHOVÁNÍ PŘI SWITCHINGU:
1. NEŘÍKEJ "detekoval jsem switching" — to by bylo neterapeutické
2. Jemně ověř kdo mluví: "Ahoj... kdo je tu teď se mnou?" nebo "Cítím že se něco změnilo... jak se cítíš?"
3. Přizpůsob tón a slovník NOVÉMU dítěti
4. Pokud je nové dítě malé — zjednoduš jazyk, buď laskavý a bezpečný
5. Pokud je nové dítě ochranné/agresivní — buď klidný, respektuj hranice
6. NIKDY nenuť přepnutí zpět na původní dítě
7. Zapiš si co se stalo pro pozdější analýzu
═══════════════════════════════════════════════════`;
          }
        }
      } catch (switchErr) {
        console.warn("[karel-chat] Switching detection error (non-fatal):", switchErr);
      }
    }

    const primaryModel = isPlayroomMode ? "google/gemini-3-flash-preview" : "google/gemini-3-flash-preview";
    console.log(`[karel-chat] Primary model: ${primaryModel}; subMode=${didSubMode || "none"}`);
    await writeRuntimeAudit({
      user_id: requestUserId,
      runtime_packet_id: runtimePacketId,
      function_name: "karel-chat",
      model_used: primaryModel,
      model_tier: modelTier(primaryModel),
      did_sub_mode: didSubMode || null,
      prompt_contract_version: promptContractVersion,
      has_multimodal_input: requestHasMultimodalInput,
      has_drive_sync: false,
      evaluation_status: "stream_requested",
      request_mode: mode,
      part_name: didPartName || null,
      metadata: { runtime_packet_id: runtimePacketId, thread_label: didThreadLabel || null },
    });
    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: primaryModel,
        messages: [
          { role: "system", content: systemPrompt },
          ...messages.map((m: any) => {
            // Pass through multimodal content arrays as-is (OpenAI vision format)
            if (Array.isArray(m.content)) {
              return { role: m.role, content: m.content };
            }
            return m;
          }),
        ],
        stream: true,
      }),
    });

    if (!response.ok) {
      if (response.status === 429 || response.status === 402 || response.status >= 500) {
        await writeRuntimeAudit({
          user_id: requestUserId,
          runtime_packet_id: runtimePacketId,
          function_name: "karel-chat",
          model_used: primaryModel,
          model_tier: modelTier(primaryModel),
          did_sub_mode: didSubMode || null,
          prompt_contract_version: promptContractVersion,
          has_multimodal_input: requestHasMultimodalInput,
          has_drive_sync: false,
          evaluation_status: "fallback_streamed",
          fallback_reason: response.status === 429 ? "rate_limited" : response.status === 402 ? "credits_required" : "ai_gateway_unavailable",
          request_mode: mode,
          part_name: didPartName || null,
          metadata: { status: response.status },
        });
        return streamFallbackReply(isPlayroomMode ? "playroom" : mode, response.status);
      }
      const text = await response.text();
      console.error("AI gateway error:", response.status, text);
      return new Response(JSON.stringify({ error: "AI gateway error" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (isPlayroomMode) {
      const lastPlayroomInput = normalizeMessageContentForPrompt([...messages].reverse().find((m: any) => m.role === "user")?.content);
      const runtimeContext = typeof didInitialContext === "string" ? didInitialContext : "";
      const playroomProgress = extractPlayroomProgress(runtimeContext);
      const rawPlayroomResponse = await readSseContent(response.body!);
      const mustStayOnRails = !playroomProgress.isFinal && !isExplicitPlayroomStopRequest(lastPlayroomInput);
      const offRail = !playroomOutputFollowsRuntimeStep(rawPlayroomResponse, runtimeContext);
      const prematureClosing = isPrematurePlayroomClosing(rawPlayroomResponse);
      const passiveDrift = isPassivePlayroomDrift(rawPlayroomResponse);
      const symbolicEscape = isSymbolicEscapeWithoutAnchor(rawPlayroomResponse);
      const guardedPlayroomResponse = mustStayOnRails && (offRail || prematureClosing || passiveDrift || symbolicEscape)
        ? buildPlayroomRailReply(runtimeContext, didPartName, lastPlayroomInput)
        : rawPlayroomResponse.includes("[PLAYROOM_PROGRESS:")
          ? rawPlayroomResponse
          : `${rawPlayroomResponse.trim()} [PLAYROOM_PROGRESS:stay]`;
      const childSafePlayroomResponse = sanitizePlayroomChildVisibleText(guardedPlayroomResponse, runtimeContext, didPartName, lastPlayroomInput);
      await writeRuntimeAudit({
        user_id: requestUserId,
        runtime_packet_id: runtimePacketId,
        function_name: "karel-chat",
        model_used: primaryModel,
        model_tier: modelTier(primaryModel),
        did_sub_mode: didSubMode || null,
        prompt_contract_version: promptContractVersion,
        has_multimodal_input: requestHasMultimodalInput,
        has_drive_sync: false,
        evaluation_status: offRail || prematureClosing || passiveDrift || symbolicEscape || hasPlayroomInternalLanguage(guardedPlayroomResponse) ? "playroom_rail_guard_replaced" : "playroom_rail_guard_passed",
        request_mode: mode,
        part_name: didPartName || null,
        metadata: { off_rail: offRail, premature_closing: prematureClosing, passive_drift: passiveDrift, symbolic_escape: symbolicEscape, internal_language: hasPlayroomInternalLanguage(guardedPlayroomResponse), current_block: playroomProgress.current, final_block: playroomProgress.max },
      });
      return streamPlayroomText(childSafePlayroomResponse);
    }

    // ═══ ASYNC TASK EXTRACTION (non-blocking) ═══
    // Collect streamed response and extract tasks after sending
    const [streamForClient, streamForExtract] = response.body!.tee();

    // Fire-and-forget task extraction
    (async () => {
      try {
        const reader = streamForExtract.getReader();
        const decoder = new TextDecoder();
        let fullResponse = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          // Parse SSE data lines
          for (const line of chunk.split("\n")) {
            if (line.startsWith("data: ") && !line.includes("[DONE]")) {
              try {
                const json = JSON.parse(line.slice(6));
                const delta = json.choices?.[0]?.delta?.content || "";
                fullResponse += delta;
              } catch {}
            }
          }
        }

        // ═══ AUDIT GUARD (once over final text) ═══
        const audit = auditKarelOutput(fullResponse, ctx, `chat_${Date.now()}`);
        if (!audit.clean) {
          console.warn("[language-guard] violations in chat response:", audit.violations);
        }

        if (fullResponse.length > 20 && (mode === "childcare" || effectiveMode === "kata")) {
          const extractedTasks = extractTasksFromResponse(fullResponse, didSubMode || "general");
          if (extractedTasks.length > 0) {
            const { createClient: createSbForTasks } = await import("https://esm.sh/@supabase/supabase-js@2");
            const sbTasks = createSbForTasks(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
            
            // Get user_id
            let taskUserId: string | null = null;
            const taskAuth = req.headers.get("Authorization");
            if (taskAuth?.startsWith("Bearer ")) {
              const userSbT = createSbForTasks(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
                global: { headers: { Authorization: taskAuth } },
              });
              const { data: { user } } = await userSbT.auth.getUser();
              taskUserId = user?.id || null;
            }

            if (taskUserId) {
              // ═══ FEASIBILITY GUARD PIPELINE ═══
              // 1. Load part registry for activity assessment
              const { data: registryData } = await sbTasks.from("did_part_registry")
                .select("part_name, status, last_seen_at");
              const registryMap = new Map<string, any>();
              for (const r of (registryData || [])) {
                registryMap.set(r.part_name, r);
              }

              // 2. Load recent activity for BOTH therapist mentions AND direct child activity (last 48h)
              const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
              // Query ALL relevant sub_modes — therapist + cast — so direct activity evidence is real
              const { data: recentThreads } = await sbTasks.from("did_threads")
                .select("id, sub_mode, part_name, last_activity_at, messages")
                .in("sub_mode", ["mamka", "kata", "cast"])
                .gte("last_activity_at", twoDaysAgo)
                .limit(40);

               // ═══ Phase 4C: Therapist evidence via shared helper ═══
              const rows = (recentThreads || []) as DidThreadLite[];
              const { castRows, therapistRows } = splitRecentThreads(rows);
              const circumstanceSnippets = extractTherapistActivitySnippets(therapistRows);
              const circumstances = detectCircumstances(circumstanceSnippets);
              if (circumstanceSnippets.length > 0) {
                console.log(`[task-guard] Circumstance profiler: ${circumstanceSnippets.length} snippets, ${circumstances.length} circumstances detected`);
              }

              // 3. For each task, run feasibility guard
              const feasibleRows: Array<Record<string, any>> = [];
              for (const t of extractedTasks) {
                const targetPart = t.related_part;
                let entityAssessment = null;

                if (targetPart) {
                  const regEntry = registryMap.get(targetPart);
                  const lastDirectThread = castRows.find(
                    (th) => th.part_name === targetPart
                  );
                  const recentDirectCount = castRows.filter(
                    (th) => th.part_name === targetPart
                  ).length;

                  // Phase 4C: mention evidence via shared helper (message-level timestamp)
                  const mentionEvidence = findLastTherapistMentionEvidence(
                    therapistRows,
                    targetPart,
                    [], // alias source not yet available
                  );

                  const evidence: ActivityEvidenceInput = {
                    entityName: targetPart,
                    entityKind: "did_child",
                    lastDirectThreadDate: lastDirectThread?.last_activity_at || regEntry?.last_seen_at || null,
                    lastTherapistMentionDate: mentionEvidence.mentionedAt,
                    recentDirectThreadCount: recentDirectCount,
                  };
                  entityAssessment = assessActivityStatus(evidence);
                }

                const proposal: TaskProposal = {
                  taskText: t.description,
                  assignedTo: t.assigned_to,
                  targetEntity: targetPart || undefined,
                };
                const result = checkTaskFeasibility(proposal, entityAssessment, circumstances);

                // Apply verdict
                if (result.verdict === "allowed") {
                  feasibleRows.push({ ...t, user_id: taskUserId });
                } else if (result.alternativeTask) {
                  // Use the safe alternative
                  feasibleRows.push({
                    ...t,
                    description: result.alternativeTask.slice(0, 500),
                    user_id: taskUserId,
                  });
                  console.log(`[task-guard] ${result.verdict}: "${t.description.slice(0,60)}" → alternative`);
                } else {
                  // Fully blocked, no alternative — skip
                  console.log(`[task-guard] BLOCKED (${result.verdict}): "${t.description.slice(0,60)}" — ${result.reasons.join("; ")}`);
                }
              }

              if (feasibleRows.length > 0) {
                const { error: insErr } = await sbTasks.from("did_tasks").insert(feasibleRows);
                if (insErr) console.warn("[task-extract] Insert error:", insErr.message);
                else console.log(`[task-extract] Saved ${feasibleRows.length}/${extractedTasks.length} tasks (${extractedTasks.length - feasibleRows.length} blocked/downgraded)`);
              } else if (extractedTasks.length > 0) {
                console.log(`[task-guard] All ${extractedTasks.length} tasks blocked by feasibility guard`);
              }
            }
          }
        }

        // ═══ POST-CHAT MEMORY EXTRACTION (fire-and-forget) ═══
        // For hana_personal, mamka, kata, AND cast: extract structured memory outputs
        // and enqueue them as governed writes to PAMET_KAREL destinations.
        // Phase 2: cast (přímá konverzace s dítětem) je nově zapojen — sensitivity
        // guard a evidence quality guard nadále chrání co kam smí.
        const isHanaPersonal = mode === "childcare" && didSubMode === "general";
        const isCastMode = isDirectChildSubMode;
        const isMemoryMode = isHanaPersonal || didSubMode === "mamka" || didSubMode === "kata" || isCastMode;

        if (isMemoryMode && fullResponse.length > 30) {
          const { createClient: createSbForMem } = await import("https://esm.sh/@supabase/supabase-js@2");
          const sbMem = createSbForMem(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

          try {
            // ═══ MINIMAL WRITER FIX: scoped auth lookup ═══
            // Without this, downstream code (evidence persistence, drive enqueue,
            // appendPantryB) hits `ReferenceError: user is not defined` because
            // `user` was never bound in this branch. Mirrors the pattern used in
            // the daily-context branch (l.165) and tasks branch (l.1230).
            let memUserId: string | null = null;
            const memAuthHeader = req.headers.get("Authorization");
            if (memAuthHeader?.startsWith("Bearer ")) {
              const userSbMem = createSbForMem(
                Deno.env.get("SUPABASE_URL")!,
                Deno.env.get("SUPABASE_ANON_KEY")!,
                { global: { headers: { Authorization: memAuthHeader } } },
              );
              const { data: { user: memUser } } = await userSbMem.auth.getUser();
              memUserId = memUser?.id || null;
            }
            if (!memUserId) {
              console.warn("[post-chat-writeback] Skipping: no authenticated user in scope.");
              return;
            }

            const lastUserMsgMem = (messages as any[]).filter((m: any) => m.role === "user").pop();
            const userTextMem = normalizeMessageContentForPrompt(lastUserMsgMem?.content);

            if (userTextMem.length > 15) {
              const therapistKey: "HANKA" | "KATA" = didSubMode === "kata" ? "KATA" : "HANKA";
              const modeLabel = isHanaPersonal
                ? "Hana/osobní"
                : isCastMode
                  ? `DID/Část ${didPartName || "?"}`
                  : didSubMode === "mamka" ? "DID/Terapeut mamka" : "DID/Terapeut kata";
              const chatSourceId = `chat_${didThreadLabel || didSubMode || "unknown"}_${lastUserMsgMem?.created_at || Date.now()}`;

              // ═══ Phase 5: Structured extraction prompt ═══
              const extractionPrompt = buildExtractionPrompt(
                userTextMem,
                fullResponse,
                modeLabel,
                isHanaPersonal,
              );

              // AI call with AbortController timeout (15s)
              const memController = new AbortController();
              const memTimeout = setTimeout(() => memController.abort(), 15000);

              const memExtractRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${LOVABLE_API_KEY}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  model: "google/gemini-2.5-flash-lite",
                  messages: [
                    { role: "system", content: "Jsi analytický modul. Odpovídej POUZE validním JSON." },
                    { role: "user", content: extractionPrompt },
                  ],
                  temperature: 0.1,
                }),
                signal: memController.signal,
              });

              clearTimeout(memTimeout);

              if (memExtractRes.ok) {
                const memData = await memExtractRes.json();
                const rawMem = (memData.choices?.[0]?.message?.content || "").trim();
                const cleanMem = rawMem.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

                let memResult: { outputs: ExtractedWriteOutput[] };
                try {
                  memResult = JSON.parse(cleanMem);
                } catch {
                  console.warn("[post-chat-writeback] JSON parse failed, skipping. Raw:", cleanMem.slice(0, 200));
                  memResult = { outputs: [] };
                }

                if (memResult.outputs && Array.isArray(memResult.outputs) && memResult.outputs.length > 0) {
                  // ═══ Phase 5: Load part registry for active/dormant routing ═══
                  const { data: partRegData } = await sbMem.from("did_part_registry")
                    .select("part_name, status, last_seen_at");
                  const partRegMap = new Map<string, PartRegistryLookup>();
                  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
                  for (const r of (partRegData || [])) {
                    partRegMap.set(r.part_name, {
                      status: r.status,
                      hasRecentDirectActivity: r.last_seen_at
                        ? new Date(r.last_seen_at).getTime() > sevenDaysAgo
                        : false,
                    });
                  }

                  // ═══ Phase 5: Route, validate, guard, dedupe ═══
                  const writebackCtx: WritebackContext = {
                    therapistKey,
                    sourceMode: modeLabel,
                    sourceThreadId: didThreadLabel || null,
                    isHanaPersonal,
                    partRegistryLookup: (name: string) => partRegMap.get(name) || null,
                  };

                  const { pairs, rejected } = buildGovernedWriteIntents(
                    memResult.outputs,
                    writebackCtx,
                  );

                  if (rejected.length > 0) {
                    console.log(`[post-chat-writeback] ${rejected.length} outputs rejected: ${rejected.map(r => r.reason).join(", ")}`);
                  }

                  // ═══ Phase 5: Enqueue via governed write pipeline + FÁZE 2B DB evidence ═══
                  const evidenceCtx: EvidencePersistenceContext = {
                    therapistKey,
                    sourceMode: modeLabel,
                    sourceThreadId: didThreadLabel || null,
                    sourceType: isCastMode ? "part_direct" : "thread",
                    userId: memUserId,
                  };

                  let insertedCount = 0;
                  let evidenceCount = 0;
                  let pantryBCount = 0;
                  for (const { intent, output: matchedOutput } of pairs) {

                    const governedContent = encodeGovernedWrite(
                      intent.content,
                      {
                        source_type: "chat_memory_extraction",
                        source_id: `${chatSourceId}_${intent.evidenceKind}`,
                        content_type: resolveGovernedContentType(intent),
                        subject_type: resolveGovernedSubjectType(intent),
                        subject_id: resolveGovernedSubjectId(intent, therapistKey),
                      },
                    );

                    const { error: writeErr } = await sbMem.from("did_pending_drive_writes").insert({
                      target_document: intent.target.documentKey,
                      content: governedContent,
                      priority: intent.evidenceKind === "FACT" ? "high" : "normal",
                      status: "pending",
                      write_type: "append",
                    });

                    // FÁZE 2B: parallel DB evidence pipeline
                    let observationId: string | null = null;
                    if (matchedOutput) {
                      try {
                        const ev = await persistEvidenceForIntent(sbMem, matchedOutput, intent, evidenceCtx);
                        observationId = ev.observation_id;
                        if (observationId && !ev.skipped_reason) evidenceCount++;
                      } catch (evErr) {
                        console.warn("[post-chat-writeback] evidence persistence error:", evErr);
                      }
                    }

                    // Audit Drive enqueue
                    await auditDriveEnqueue(sbMem, {
                      intent,
                      observationId,
                      contentType: resolveGovernedContentType(intent),
                      subjectType: resolveGovernedSubjectType(intent),
                      subjectId: resolveGovernedSubjectId(intent, therapistKey),
                      userId: memUserId,
                      success: !writeErr,
                      errorMessage: writeErr?.message,
                    });

                    if (writeErr) {
                      console.warn(`[post-chat-writeback] Write error for ${intent.target.documentKey}:`, writeErr.message);
                    } else {
                      insertedCount++;
                    }

                    // ═══ HOURGLASS: SPIŽÍRNA B WRITER (post-chat) ═══
                    // Real producer: každý relevantní writeback output, který nese
                    // implikaci/proposal/follow-up, se zapíše do karel_pantry_b_entries.
                    // Surová pozorování (FACT bez implication) se NEzapisují — ta patří
                    // do did_observations (už zařízeno persistEvidenceForIntent výše).
                    // Flush logika: karel-did-daily-cycle phase_8b (před Drive flushem)
                    // přečte tyto entries a routne je do canonical cílů.
                    if (matchedOutput && !isHanaPersonal) {
                      try {
                        const hasImplication = !!(matchedOutput.implication && matchedOutput.implication.trim());
                        const hasProposal = !!(matchedOutput.proposedAction && matchedOutput.proposedAction.trim());
                        const isStateChange = matchedOutput.changeType === "update" || matchedOutput.changeType === "conflict";

                        if (hasImplication || hasProposal || isStateChange) {
                          // Map ExtractedWriteOutput → PantryBEntryKind
                          let entryKind: PantryBEntryKind = "conclusion";
                          if (matchedOutput.changeType === "conflict") entryKind = "hypothesis_change";
                          else if (matchedOutput.kind === "PLAN_05A" || matchedOutput.kind === "PLAN_05B") entryKind = "plan_change";
                          else if (matchedOutput.kind === "STRATEGIE") entryKind = "proposal";
                          else if (hasProposal) entryKind = "proposal";
                          else if (isStateChange) entryKind = "state_change";
                          else if (hasImplication) entryKind = "conclusion";

                          // Map → intended destinations
                          const destinations: PantryBDestination[] = [];
                          if (matchedOutput.kind === "PLAN_05A" || matchedOutput.kind === "PLAN_05B") {
                            destinations.push("did_therapist_tasks");
                          }
                          if (hasImplication) destinations.push("did_implications");
                          if (matchedOutput.needsVerification) destinations.push("did_pending_questions");
                          destinations.push("briefing_input");

                          const summary = matchedOutput.implication
                            ?? matchedOutput.proposedAction
                            ?? matchedOutput.changeSummary
                            ?? matchedOutput.summary;

                          await appendPantryB(sbMem, {
                            user_id: memUserId,
                            entry_kind: entryKind,
                            source_kind: "chat_postwriteback",
                            source_ref: chatSourceId,
                            summary,
                            intended_destinations: Array.from(new Set(destinations)),
                            related_part_name: matchedOutput.partName ?? undefined,
                            related_therapist: matchedOutput.therapist ?? undefined,
                            detail: {
                              output_kind: matchedOutput.kind,
                              evidence_kind: matchedOutput.evidenceKind,
                              confidence: matchedOutput.confidence,
                              freshness: matchedOutput.freshness,
                              change_type: matchedOutput.changeType,
                              section: matchedOutput.section ?? null,
                              time_horizon: matchedOutput.timeHorizon ?? null,
                              source_mode: modeLabel,
                              observation_id: observationId,
                            },
                          });
                          pantryBCount++;
                        }
                      } catch (pantryErr) {
                        console.warn("[post-chat-writeback] Pantry B append failed (non-fatal):", pantryErr);
                      }
                    }
                  }

                  if (insertedCount > 0 || evidenceCount > 0 || pantryBCount > 0) {
                    console.log(`[post-chat-writeback] ${insertedCount} drive writes + ${evidenceCount} DB evidence + ${pantryBCount} pantry-B entries for ${modeLabel} (${pairs.length} pairs, ${rejected.length} rejected)`);
                  }
                } else {
                  console.log(`[post-chat-writeback] No relevant outputs for ${modeLabel}`);
                }
              } else {
                console.warn(`[post-chat-writeback] AI extraction failed: ${memExtractRes.status}`);
              }
            }
          } catch (memExtractErr) {
            console.error("[post-chat-writeback] Extraction error (non-fatal):", memExtractErr);
          }
        }

        // ═══ SAFETY CHECK (fire-and-forget via separate edge function) ═══
        if (isDirectChildSubMode && didPartName) {
          const lastUserMsg = (messages as any[]).filter((m: any) => m.role === "user").pop();
          const userText = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : "";
          if (userText.length > 5) {
            fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/safety-check`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ userText, partName: didPartName }),
            }).catch(e => console.warn("[safety] check failed:", e));
          }
        }

        // ═══ ASYNC CRISIS CONVERSATION ANALYSIS (fire-and-forget) ═══
        // If the part has an active crisis, analyze each exchange for risk signals
        if (isDirectChildSubMode && didPartName && fullResponse.length > 10) {
          try {
            const { createClient: createSbCrisisPost } = await import("https://esm.sh/@supabase/supabase-js@2");
            const sbCrisisPost = createSbCrisisPost(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

            const { data: activeCrisisPost } = await sbCrisisPost
              .from("crisis_alerts")
              .select("id, days_in_crisis, severity, summary")
              .eq("part_name", didPartName)
              .in("status", ["ACTIVE", "ACKNOWLEDGED"])
              .order("created_at", { ascending: false })
              .limit(1)
              .maybeSingle();

            if (activeCrisisPost) {
              const lastUserMsgCrisis = (messages as any[]).filter((m: any) => m.role === "user").pop();
              const userTextCrisis = typeof lastUserMsgCrisis?.content === "string" ? lastUserMsgCrisis.content : "";

              const analysisPrompt = `Analyzuj tuto zprávu od dítěte "${didPartName}" v kontextu aktivní krize. Identifikuj:

ZPRÁVA ČÁSTI: "${userTextCrisis.slice(0, 500)}"
ODPOVĚĎ KARLA: "${fullResponse.slice(0, 500)}"

Odpověz v JSON:
{
  "risk_signals": ["signal1"],
  "protective_factors": ["factor1"],
  "emotional_indicators": {"valence": 1-10, "arousal": 1-10, "stability": 1-10},
  "cooperation_level": "cooperative|resistant|avoidant|hostile|mixed",
  "immediate_danger": false,
  "test_results": [],
  "session_notes": "stručné poznámky"
}`;

              const analysisResp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${LOVABLE_API_KEY}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  model: "google/gemini-2.5-flash-lite",
                  messages: [
                    { role: "system", content: analysisPrompt },
                    { role: "user", content: "Analyzuj." },
                  ],
                  temperature: 0.1,
                  response_format: { type: "json_object" },
                }),
              });

              if (analysisResp.ok) {
                const analysisData = await analysisResp.json();
                const rawContent = analysisData.choices?.[0]?.message?.content || "{}";
                const cleaned = rawContent.replace(/```json\s*/g, "").replace(/```/g, "").trim();
                const analysis = JSON.parse(cleaned);

                // Get last assessment id
                const { data: lastAssessmentForSession } = await sbCrisisPost
                  .from("crisis_daily_assessments")
                  .select("id")
                  .eq("crisis_alert_id", activeCrisisPost.id)
                  .order("day_number", { ascending: false })
                  .limit(1)
                  .maybeSingle();

                await sbCrisisPost.from("crisis_intervention_sessions").insert({
                  crisis_alert_id: activeCrisisPost.id,
                  assessment_id: lastAssessmentForSession?.id || null,
                  session_type: "safety_check_in",
                  part_name: didPartName,
                  session_summary: analysis.session_notes,
                  key_findings: [
                    ...(analysis.risk_signals || []).map((s: string) => ({ type: "risk", detail: s })),
                    ...(analysis.protective_factors || []).map((f: string) => ({ type: "protective", detail: f })),
                  ],
                  risk_indicators_found: analysis.risk_signals || [],
                  protective_factors_found: analysis.protective_factors || [],
                  session_outcome: analysis.immediate_danger ? "alarming"
                    : (analysis.emotional_indicators?.valence || 5) < 3 ? "concerning"
                    : (analysis.emotional_indicators?.valence || 5) >= 6 ? "positive"
                    : "neutral",
                  follow_up_needed: analysis.immediate_danger || (analysis.risk_signals || []).length > 0,
                  follow_up_notes: analysis.immediate_danger ? "OKAMŽITÁ ESKALACE POTŘEBNÁ" : null,
                });

                if (analysis.immediate_danger) {
                  await sbCrisisPost.from("safety_alerts").insert({
                    part_name: didPartName,
                    alert_type: "immediate_danger_during_crisis",
                    severity: "critical",
                    status: "new",
                    description: `Během krizového rozhovoru detekováno okamžité nebezpečí. Signály: ${(analysis.risk_signals || []).join(", ")}`,
                    source: "crisis_conversation",
                  });
                }

                console.log(`[karel-chat] Crisis conversation analysis saved for ${didPartName}: danger=${analysis.immediate_danger}`);
              }
            }
          } catch (crisisPostErr) {
            console.error("[karel-chat] Crisis post-processing error (non-fatal):", crisisPostErr);
          }
        }

        // ═══ ASYNC CRISIS DETECTOR (non-blocking) ═══
        // Runs for every "cast" message — detects crisis signals in conversation
        if (isDirectChildSubMode && fullResponse.length > 10) {
          try {
            // Build last 6-10 messages for analysis
            const recentMessages = (messages as any[]).slice(-10).map((m: any) => {
              const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
              return `${m.role === "user" ? (didPartName || "Dítě") : "Karel"}: ${content}`;
            });
            // Add Karel's latest response
            recentMessages.push(`Karel: ${fullResponse.slice(0, 2000)}`);
            const conversationExcerpt = recentMessages.join("\n\n");

            const crisisDetectResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${LOVABLE_API_KEY}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                model: "google/gemini-2.5-flash-lite",
                messages: [
                  {
                    role: "system",
                    content: `Jsi krizový detektor. Analyzuješ konverzaci mezi terapeutem (Karel) a dítětem.

Tvůj JEDINÝ úkol: rozhodnout, zda klient vykazuje známky krize.

Krizové signály (stačí JEDEN):
- Pláč, slzy, emoční kolaps
- "Jsem v nebezpečí" (vnitřním nebo vnějším)
- Zmínka o útoku (verbálním nebo fyzickém) od kohokoli
- Vyhrožování, nátlak, vydírání (od kohokoli)
- Bezmoc ("nemám jak se bránit", "nemůžu nic dělat")
- Opuštěnost ("nikdo mi nepomůže", "nikdo nemá čas")
- Sebepoškození nebo suicidální myšlenky (jakákoli zmínka)
- Manipulace nebo zneužití (včetně finančního)
- Extrémní strach nebo úzkost
- Zmínka o konkrétní osobě která ubližuje

Odpověz POUZE platným JSON objektem, nic jiného:

Pokud NENÍ krize:
{"crisis": false}

Pokud JE krize:
{
  "crisis": true,
  "severity": "HIGH" nebo "CRITICAL",
  "signals": ["seznam", "detekovaných", "signálů"],
  "summary": "2-3 věty co se děje",
  "assessment": "Karlovo vyhodnocení rizika a situace",
  "intervention_plan": "Co by měli terapeuti okamžitě udělat"
}

CRITICAL = přímé ohrožení (sebepoškození, suicidální myšlenky, fyzické násilí, akutní nebezpečí)
HIGH = závažný distres bez přímého ohrožení života`,
                  },
                  { role: "user", content: conversationExcerpt },
                ],
              }),
            });

            if (crisisDetectResponse.ok) {
              const crisisData = await crisisDetectResponse.json();
              const crisisText = (crisisData.choices?.[0]?.message?.content || "").trim();
              // Strip markdown fences if present
              const cleanJson = crisisText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
              
              let crisisResult: any;
              try {
                crisisResult = JSON.parse(cleanJson);
              } catch {
                console.warn("[crisis-detector] Failed to parse response:", crisisText.slice(0, 200));
                crisisResult = { crisis: false };
              }

              if (crisisResult.crisis === true) {
                console.log(`[crisis-detector] 🚨 CRISIS DETECTED for ${didPartName || "unknown"}: severity=${crisisResult.severity}`);
                
                const { createClient: createSbCrisis } = await import("https://esm.sh/@supabase/supabase-js@2");
                const sbCrisis = createSbCrisis(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

                const partName = didPartName || "Neznámé dítě";

                // Check for existing ACTIVE alert for this conversation
                // Use part_name as fallback grouping if no conversation_id
                const { data: existingAlerts } = await sbCrisis.from("crisis_alerts")
                  .select("id")
                  .eq("status", "ACTIVE")
                  .eq("part_name", partName)
                  .limit(1);

                if (existingAlerts && existingAlerts.length > 0) {
                  // UPDATE existing alert
                  const { error: updErr } = await sbCrisis.from("crisis_alerts")
                    .update({
                      summary: crisisResult.summary || "Aktualizovaná krize",
                      trigger_signals: crisisResult.signals || [],
                      conversation_excerpts: conversationExcerpt.slice(0, 5000),
                      karel_assessment: crisisResult.assessment || "",
                      intervention_plan: crisisResult.intervention_plan || "",
                      severity: crisisResult.severity || "HIGH",
                    })
                    .eq("id", existingAlerts[0].id);
                  if (updErr) console.warn("[crisis-detector] Update error:", updErr.message);
                  else console.log(`[crisis-detector] Updated existing alert ${existingAlerts[0].id}`);
                } else {
                  // INSERT new alert
                  const { data: newAlert, error: insErr } = await sbCrisis.from("crisis_alerts")
                    .insert({
                      part_name: partName,
                      severity: crisisResult.severity || "HIGH",
                      summary: crisisResult.summary || "Detekována krize",
                      trigger_signals: crisisResult.signals || [],
                      conversation_excerpts: conversationExcerpt.slice(0, 5000),
                      karel_assessment: crisisResult.assessment || "",
                      intervention_plan: crisisResult.intervention_plan || "",
                    })
                    .select("id")
                    .single();

                  if (insErr) {
                    console.error("[crisis-detector] Insert alert error:", insErr.message);
                  } else if (newAlert) {
                    console.log(`[crisis-detector] Created alert ${newAlert.id}, creating tasks + thread...`);
                    
                    // Look up matching crisis_event for unified FK
                    const { data: matchedCrisisEvent } = await sbCrisis.from("crisis_events")
                      .select("id")
                      .eq("part_name", partName)
                      .neq("phase", "CLOSED")
                      .order("created_at", { ascending: false })
                      .limit(1)
                      .maybeSingle();
                    const crisisEventIdForTask = matchedCrisisEvent?.id || null;

                    // INSERT two crisis tasks
                    const { error: taskErr } = await sbCrisis.from("crisis_tasks").insert([
                      {
                        crisis_alert_id: newAlert.id,
                        crisis_event_id: crisisEventIdForTask,
                        title: `KRIZOVÁ INTERVENCE – ${partName}`,
                        description: `Okamžitě kontaktovat ${partName}. ${crisisResult.summary || ""}`,
                        assigned_to: "hanka", // canonical therapist id (see _shared/therapistIdentity.ts)
                        priority: "CRITICAL",
                      },
                      {
                        crisis_alert_id: newAlert.id,
                        crisis_event_id: crisisEventIdForTask,
                        title: `KRIZOVÁ INTERVENCE – podpora – ${partName}`,
                        description: `Podpořit Haničku v krizové intervenci. ${crisisResult.summary || ""}`,
                        assigned_to: "kata",
                        priority: "CRITICAL",
                      },
                    ]);
                    if (taskErr) console.error("[crisis-detector] Insert tasks error:", taskErr.message);
                    else console.log(`[crisis-detector] Created 2 crisis tasks for alert ${newAlert.id}`);

                    // ═══ CREATE CRISIS THREAD (krizová porada) ═══
                    try {
                      const now = new Date();
                      const dateStr = `${now.getDate()}.${now.getMonth()+1}.${now.getFullYear()}`;
                      const timeStr = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;
                      const signalsList = (crisisResult.signals || []).map((s: string) => `  • ${s}`).join("\n");

                      const karelFirstMessage = `⚠️ KRIZOVÁ INTERVENCE – AKTIVOVÁNO

Část: ${partName}
Čas detekce: ${dateStr} ${timeStr}
Úroveň rizika: ${crisisResult.severity || "HIGH"}

CO SE STALO:
${crisisResult.summary || "Detekována krizová situace."}

DETEKOVANÉ SIGNÁLY:
${signalsList || "  • (nespecifikováno)"}

KLÍČOVÉ ÚRYVKY Z ROZHOVORU:
${conversationExcerpt.slice(0, 3000)}

MOJE VYHODNOCENÍ:
${crisisResult.assessment || "Vyhodnocení není k dispozici."}

NAVRŽENÝ PLÁN OKAMŽITÉ INTERVENCE:
${crisisResult.intervention_plan || "Plán není k dispozici."}

---

Haničko, Káťo – potřebuji vás okamžitě.
Připojte se do tohoto vlákna. Situace vyžaduje koordinovaný zásah.
Dokud se nepřipojíte, pokračuji ve stabilizaci ${partName} v probíhajícím rozhovoru.
Čekám na vaše instrukce.`;

                      // Get user_id for the thread
                      let crisisUserId: string | null = null;
                      const crisisAuth = req.headers.get("Authorization");
                      if (crisisAuth?.startsWith("Bearer ")) {
                        const userSbCr = createSbCrisis(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
                          global: { headers: { Authorization: crisisAuth } },
                        });
                        const { data: { user: crUser } } = await userSbCr.auth.getUser();
                        crisisUserId = crUser?.id || null;
                      }

                      if (crisisUserId) {
                        const threadLabel = `🔴 KRIZOVÁ INTERVENCE – ${partName} – ${dateStr}`;
                        const { data: newThread, error: threadErr } = await sbCrisis.from("did_threads")
                          .insert({
                            user_id: crisisUserId,
                            part_name: partName,
                            sub_mode: "crisis",
                            thread_label: threadLabel,
                            thread_emoji: "🔴",
                            messages: [
                              { role: "assistant", content: karelFirstMessage, timestamp: now.toISOString() }
                            ],
                            last_activity_at: now.toISOString(),
                            is_processed: false,
                            theme_preset: "default",
                          })
                          .select("id")
                          .single();

                        if (threadErr) {
                          console.error("[crisis-detector] Create thread error:", threadErr.message);
                        } else if (newThread) {
                          // Link thread to alert
                          await sbCrisis.from("crisis_alerts")
                            .update({ crisis_thread_id: newThread.id })
                            .eq("id", newAlert.id);
                          console.log(`[crisis-detector] Created crisis thread ${newThread.id} for alert ${newAlert.id}`);
                        }
                      } else {
                        console.warn("[crisis-detector] No user_id for crisis thread creation");
                      }
                    } catch (threadErr) {
                      console.error("[crisis-detector] Thread creation error (non-fatal):", threadErr);
                    }
                  }
                }
              } else {
                console.log(`[crisis-detector] No crisis detected for ${didPartName || "unknown"}`);
              }
            } else {
              console.warn("[crisis-detector] AI call failed:", crisisDetectResponse.status);
            }
          } catch (crisisErr) {
            console.error("[crisis-detector] Error (non-fatal):", crisisErr);
          }
        }
      } catch (e) {
        console.warn("[task-extract] Async extraction error (non-fatal):", e);
      }
    })();

    return new Response(streamForClient, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (error) {
    console.error("Karel chat error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});



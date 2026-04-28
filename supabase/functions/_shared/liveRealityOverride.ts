export type RealityVerificationStatus = "verified" | "partially_verified" | "therapist_report_only" | "unverified";

export type RealityVerificationSummary = {
  factual_status: RealityVerificationStatus;
  source_url: string | null;
  source_title: string | null;
  source_date: string | null;
  event_summary: string;
  current_uncertainty: string;
  clinically_relevant_facts: string[];
  details_to_avoid_telling_child: string[];
  fetch_error?: string;
};

export type LiveRealityOverrideDetection = {
  reality_override_detected: boolean;
  external_event_detected: boolean;
  requires_live_replan: boolean;
  original_plan_paused: boolean;
  urls: string[];
  trigger_matches: string[];
};

export const REALITY_OVERRIDE_TRIGGER_RE = /(?:skute(?:č|c)n(?:é|e|á|a)\s+(?:zv(?:í|i)(?:ř|r)e|ud(?:á|a)lost|osoba)|re(?:á|a)ln(?:ě|e)\s+(?:ve\s+sv(?:ě|e)t(?:ě|e)|rozhoduje|děje|deje)|pos(?:í|i)lala\s+jsem\s+(?:ti\s+)?odkaz|tady\s+je\s+odkaz|nepochopil\s+jsi\s+situaci|nen(?:í|i)\s+to\s+(?:fiktivn(?:í|i)|symbol|projekce)|jde\s+o\s+aktu(?:á|a)ln(?:í|i)\s+zpr(?:á|a)vu|dnes\s+se\s+rozhoduje|aktu(?:á|a)ln(?:í|i)\s+z(?:á|a)chrann|url|https?:\/\/)/i;

export const BANNED_REALITY_OVERRIDE_PHRASES = [
  "vůbec to nemění náš plán",
  "vubec to nemeni nas plan",
  "vůbec to nemění plán",
  "vubec to nemeni plan",
  "pokračujme přesně podle plánu",
  "pokracujme presne podle planu",
  "je to silný diagnostický signál",
  "je to silny diagnosticky signal",
  "je to projekce jeho vlastních pocitů",
  "je to projekce jeho vlastnich pocitu",
  "ukazuje, že se cítí v pasti",
  "ukazuje, ze se citi v pasti",
  "nakresli člověka",
  "nakresli cloveka",
  "otestujeme disociaci",
  "vyhodnotím míru přepínání",
  "vyhodnotim miru prepinani",
  "profesionálně vyhodnotím",
  "profesionalne vyhodnotim",
  "latence je diagnostická",
  "latence je diagnosticka",
];

export function extractUrls(text: string): string[] {
  return Array.from(new Set((text.match(/https?:\/\/[^\s)\]}>"']+/gi) ?? []).map((u) => u.replace(/[.,;:!?]+$/, ""))));
}

export function detectLiveRealityOverride(text: string): LiveRealityOverrideDetection {
  const urls = extractUrls(text);
  const triggerMatches = text.match(REALITY_OVERRIDE_TRIGGER_RE) ? [text.match(REALITY_OVERRIDE_TRIGGER_RE)?.[0] ?? "reality_override"] : [];
  const detected = triggerMatches.length > 0 || urls.length > 0;
  return {
    reality_override_detected: detected,
    external_event_detected: detected && (urls.length > 0 || /ud(?:á|a)lost|zpr(?:á|a)vu|zv(?:í|i)(?:ř|r)e|velryb|z(?:á|a)chran|re(?:á|a)ln/i.test(text)),
    requires_live_replan: detected,
    original_plan_paused: detected,
    urls,
    trigger_matches: triggerMatches,
  };
}

export function containsBannedRealityOverridePhrase(text: string): boolean {
  const normalized = text.toLowerCase();
  return BANNED_REALITY_OVERRIDE_PHRASES.some((phrase) => normalized.includes(phrase));
}

function stripHtml(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function meta(html: string, name: string): string | null {
  const re = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i");
  return html.match(re)?.[1]?.trim() ?? null;
}

export async function verifyExternalReality(urls: string[], therapistFrame: string): Promise<RealityVerificationSummary> {
  const firstUrl = urls[0] ?? null;
  if (!firstUrl) {
    return {
      factual_status: "therapist_report_only",
      source_url: null,
      source_title: null,
      source_date: null,
      event_summary: therapistFrame.slice(0, 500),
      current_uncertainty: "Nebyl dodán URL zdroj; pracuji pouze s faktickým rámcem terapeutky.",
      clinically_relevant_facts: ["Terapeutka opravila faktický rámec v živém sezení."],
      details_to_avoid_telling_child: ["Nepřidávat dramatické detaily, které dítě samo nezmínilo."],
    };
  }

  try {
    const res = await fetch(firstUrl, { headers: { "User-Agent": "KarelLiveSessionRealityVerifier/1.0" }, signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const title = meta(html, "og:title") ?? html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() ?? null;
    const date = meta(html, "article:published_time") ?? meta(html, "date") ?? meta(html, "og:updated_time");
    const description = meta(html, "og:description") ?? meta(html, "description") ?? stripHtml(html).slice(0, 600);
    return {
      factual_status: title || description ? "partially_verified" : "verified",
      source_url: firstUrl,
      source_title: title,
      source_date: date,
      event_summary: description || therapistFrame.slice(0, 500),
      current_uncertainty: "URL byl načten, ale klinicky se používá jen stručný souhrn; detaily článku nejsou automaticky sdělovány dítěti.",
      clinically_relevant_facts: ["Jde o faktický externí rámec, ne o projektivní materiál dítěte.", "Dítěti sdělit jen minimum potřebné pro realitní orientaci a bezpečí."],
      details_to_avoid_telling_child: ["Dramatické detaily záchrany, rizika úhynu, bezmoc nebo časový tlak, pokud je dítě samo neotevře."],
    };
  } catch (e) {
    return {
      factual_status: "therapist_report_only",
      source_url: firstUrl,
      source_title: null,
      source_date: null,
      event_summary: therapistFrame.slice(0, 500),
      current_uncertainty: "URL se nepodařilo přímo načíst; obsah článku nesmí být domýšlen.",
      clinically_relevant_facts: ["Terapeutka poskytla faktickou korekci; Karel ji přijímá jako rámec sezení."],
      details_to_avoid_telling_child: ["Nepředstírat ověření článku.", "Nepřidávat neověřené detaily."],
      fetch_error: e instanceof Error ? e.message : String(e),
    };
  }
}

export function buildLiveReplanPatch(args: { therapistName: string; partName: string; therapistCorrection: string; detection: LiveRealityOverrideDetection; verification: RealityVerificationSummary; blockedIntervention?: string; currentBlockIndex?: number | null; currentBlockText?: string | null }) {
  const addr = args.therapistName === "Káťa" ? "Káťo" : "Hani";
  const id = `live-replan-${Date.now()}`;
  return {
    id,
    reason: "therapist_factual_correction_external_event",
    reality_override_detected: true,
    external_event_detected: args.detection.external_event_detected,
    current_block_status: "paused_by_reality_override",
    original_block_paused: true,
    original_intervention_blocked: true,
    blocked_intervention: args.blockedIntervention || "original_planned_task / projective_drawing / draw_a_person",
    current_block_index: args.currentBlockIndex ?? null,
    current_block_text: args.currentBlockText ?? null,
    factual_frame: {
      source: args.verification.source_url ? "therapist + url_fetch" : "therapist_report_only",
      event_type: "real_world_current_event",
      verification_status: args.verification.factual_status,
      source_url: args.verification.source_url,
      source_title: args.verification.source_title,
      source_date: args.verification.source_date,
      event_summary: args.verification.event_summary,
      current_uncertainty: args.verification.current_uncertainty,
      clinically_relevant_facts: args.verification.clinically_relevant_facts,
      details_to_avoid_telling_child: args.verification.details_to_avoid_telling_child,
    },
    new_clinical_goal: "orient child/part to reality, emotion, safety, and need",
    new_micro_steps: ["Co o tom víš?", "Co se v tobě děje, když na to myslíš?", "Co bys teď potřeboval ty?", "Co by pomohlo, aby toho nebylo moc?", "Zapsat přesná slova, afekt, tělesnou reakci a míru zahlcení.", "Krátká stabilizace: kontakt s místností, haptika, orientace tady a teď.", "Pokračovat jen pokud je část stabilní; jinak ukončit tématem bezpečí."],
    what_to_avoid: ["nevracet se k projektivní kresbě", "neinterpretovat projekčně", "nepřidávat děsivé detaily", "nedělat diagnostický závěr", "netvrdit, že plán se nemění"],
    therapist_script: `${addr}, můžeš říct: „Je to skutečná událost a lidé se snaží pomoct. Co se v tobě děje, když na to myslíš?“`,
    child_facing_message_limit: "Factual verification summary je pro terapeutku/Karla; dítěti jen krátké, bezpečné minimum.",
    data_to_record: ["therapist_factual_correction", "verified_external_fact", "child_response_to_event", "vlastní slova části", "afekt", "tělesná reakce", "míra zahlcení", "potřeba / bezpečnostní krok"],
    evidence_discipline: "therapist_factual_correction a verified_external_fact nejsou klinický důkaz o části; klinicky použitelná je až child_response_to_event.",
    return_to_original_plan_allowed: false,
    condition_for_return_to_plan: "only after therapist confirms",
    created_at: new Date().toISOString(),
  };
}

export function correctiveRealityOverrideResponse(patch: any, therapistName = "Hanka") {
  const addr = therapistName === "Káťa" ? "Káťo" : "Hani";
  const status = patch?.factual_frame?.verification_status === "therapist_report_only"
    ? "Zdroj se mi nepodařilo přímo ověřit, takže nepředstírám ověření a pracuji s tvým faktickým rámcem."
    : "Faktický rámec jsem označil jako externí událost; souhrn je jen pro tebe, ne automaticky pro dítě.";
  return `${addr}, máš pravdu — tady jsem špatně přečetl realitu. Zastavuju původní bod; teď není vhodné pokračovat projektivní kresbou ani z toho dělat diagnostický závěr.

${status}

Program měním na mikro-plán: realita → emoce → potřeba → bezpečí.

1. Nezadávej kresbu „Nakresli člověka“.
2. Zeptej se krátce a klidně, co ${patch?.part_name ?? "část"} o události ví.
3. Pak se zeptej, co se v něm děje, když na ni myslí.
4. Zapisuj jeho vlastní slova, afekt, tělesnou reakci a míru zahlcení.
5. Neinterpretuj zatím projekčně a nepřidávej děsivé detaily.

Můžeš říct: „Je to skutečná událost a lidé se snaží pomoct. Co se v tobě děje, když na to myslíš?“

Původní plán odkládám; návrat k němu jen po tvém výslovném potvrzení.`;
}
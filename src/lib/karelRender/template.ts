/**
 * karelRender/template.ts — TEMPLATE / RENDER LAYER (pure-text)
 *
 * Composes humanized text fragments into final user-facing strings using
 * the selected voice style. Returns plain strings — never JSX, never DOM.
 *
 * Public renderers:
 *   - renderKarelBriefing()       — Karlův přehled (top of dashboard)
 *   - renderTherapistAsk()        — task-intro lead per therapist
 *   - renderCoordinationAlertText() — coordination alert prose
 *   - renderAnalysis()            — weekly/monthly retrospective intro
 *
 * Mirror: supabase/functions/_shared/karelRender/template.ts (1:1).
 */

import { resolveAddressee, type Audience } from "./identity";
import {
  humanizeText,
  describeUrgentLoad,
  addressTaskTo2ndPerson,
  auditHumanizedText,
} from "./humanize";
import {
  selectVoiceMode,
  getVoiceStyle,
  buildGreeting,
  type VoiceMode,
} from "./voice";

export interface BriefingInput {
  audience: Audience | string;
  /** Hint to pick intimate variant for Hanka, or analysis variant. */
  hint?: "intimate" | "analysis";
  /** Top urgent task in raw form (will be humanized). */
  topTaskRaw?: string | null;
  /** Total urgent task count (for the calm-load sentence). */
  urgentCount?: number;
  /** Free-form context Karel wants to mention (already humanized OR raw). */
  reason?: string | null;
  /** What Karel needs from Hanka (raw or humanized). */
  needFromHanka?: string | null;
  /** What Karel needs from Káťa (raw or humanized). */
  needFromKata?: string | null;
  /** Optional explicit "now" for testing. */
  now?: Date;
}

export interface BriefingResult {
  text: string;
  voiceMode: VoiceMode;
  audience: Audience;
  voiceViolations: string[];
}

/**
 * Render Karlův přehled (top-of-dashboard briefing).
 * Always emits at least a greeting + lead sentence; never raw counters.
 */
export function renderKarelBriefing(input: BriefingInput): BriefingResult {
  const { audience, displayName: _ } = resolveAddressee(
    typeof input.audience === "string" ? input.audience : null,
  );
  const finalAudience: Audience = (input.audience as Audience) ?? audience;
  const mode = selectVoiceMode(finalAudience, input.hint);
  const style = getVoiceStyle(mode);

  const greeting = buildGreeting(finalAudience, input.now);
  const topTask = humanizeText(input.topTaskRaw);
  const urgentSentence = describeUrgentLoad(input.urgentCount ?? 0, topTask);
  const reason = humanizeText(input.reason);

  const needHanka = humanizeText(input.needFromHanka);
  const needKata = humanizeText(input.needFromKata);

  const paragraphs: string[] = [greeting];

  if (urgentSentence) {
    paragraphs.push(urgentSentence);
  } else if (topTask) {
    paragraphs.push(`${style.leadPhrase} ${topTask}.`);
  }

  if (reason) {
    paragraphs.push(`Je to důležité proto, že ${reason}.`);
  }

  if (finalAudience === "team") {
    if (needHanka) paragraphs.push(`Haničko, ${style.needPhrase.toLocaleLowerCase("cs")} ${needHanka}.`);
    if (needKata)  paragraphs.push(`Káťo, ${style.needPhrase.toLocaleLowerCase("cs")} ${needKata}.`);
  } else if (finalAudience === "hanka" && needHanka) {
    paragraphs.push(`${style.needPhrase} ${needHanka}.`);
  } else if (finalAudience === "kata" && needKata) {
    paragraphs.push(`${style.needPhrase} ${needKata}.`);
  }

  if (style.closing) paragraphs.push(style.closing);

  const text = paragraphs.join("\n\n");
  return {
    text,
    voiceMode: mode,
    audience: finalAudience,
    voiceViolations: auditHumanizedText(text),
  };
}

export interface TherapistAskInput {
  audience: "hanka" | "kata" | "team";
  topTaskRaw: string;
}

/**
 * Render the lead sentence for a therapist's task section.
 *
 * For direct addressees (hanka/kata), strips the therapist's own name
 * from the task (so we never get "Káťo, hlavní věc na dnes je: zapojit
 * Káťu do porady").
 */
export function renderTherapistAsk(input: TherapistAskInput): string {
  const cleaned = humanizeText(input.topTaskRaw);
  if (!cleaned) return "";

  if (input.audience === "team") {
    return `Pro tým je dnes nejdůležitější: ${cleaned.charAt(0).toLocaleLowerCase("cs")}${cleaned.slice(1)}.`;
  }

  const second = addressTaskTo2ndPerson(cleaned, input.audience);
  const voc = input.audience === "hanka" ? "Haničko" : "Káťo";
  if (!second) return `${voc}, ${cleaned.charAt(0).toLocaleLowerCase("cs")}${cleaned.slice(1)}.`;
  return `${voc}, hlavní věc na dnes je ${second}.`;
}

export interface CoordinationAlertInput {
  ownerRaw: string | null | undefined;
  topicRaw: string | null | undefined;
  reasonRaw?: string | null;
}

/**
 * Render a single-line coordination alert in Karel's voice.
 * Resolves owner via identity layer; never echoes "system"/aliases.
 */
export function renderCoordinationAlertText(input: CoordinationAlertInput): string {
  const { audience, displayName, vocative } = resolveAddressee(input.ownerRaw);
  const topic = humanizeText(input.topicRaw);
  const reason = humanizeText(input.reasonRaw);

  if (!topic) return "";

  if (audience === "team") {
    const tail = reason ? ` — ${reason}` : "";
    return `Pro tým: ${topic}${tail}.`;
  }

  const addressee = vocative ?? displayName;
  const tail = reason ? `, protože ${reason}` : "";
  return `${addressee}, považuji za důležité dnes ověřit ${topic}${tail}.`;
}

export interface AnalysisInput {
  /** Period label, e.g. "uplynulým týdnem" / "uplynulým měsícem". */
  periodPhrase: string;
  /** Top observed pattern (raw or humanized). */
  topPatternRaw: string;
  /** Most sensitive area (raw or humanized). */
  sensitiveAreaRaw?: string | null;
  /** Strongest support point (raw or humanized). */
  strongestPointRaw?: string | null;
  /** Recommendation for the next period (raw or humanized). */
  recommendationRaw?: string | null;
  audience?: Audience;
}

/**
 * Render the intro paragraph for a weekly/monthly retrospective.
 * Uses the analysis voice style.
 */
export function renderAnalysis(input: AnalysisInput): BriefingResult {
  const audience: Audience = input.audience ?? "team";
  const mode = selectVoiceMode(audience, "analysis");

  const pattern = humanizeText(input.topPatternRaw);
  const sensitive = humanizeText(input.sensitiveAreaRaw);
  const strong = humanizeText(input.strongestPointRaw);
  const reco = humanizeText(input.recommendationRaw);

  const paragraphs: string[] = ["Dobrý den."];

  if (pattern) {
    paragraphs.push(`Když se ohlížím za ${input.periodPhrase}, vidím především ${pattern}.`);
  }
  if (sensitive) {
    paragraphs.push(`Za nejcitlivější místo považuji ${sensitive}.`);
  }
  if (strong) {
    paragraphs.push(`Za nejsilnější opěrný bod považuji ${strong}.`);
  }
  if (reco) {
    paragraphs.push(`Pro další období bych doporučil ${reco}.`);
  }

  const text = paragraphs.join("\n\n");
  return {
    text,
    voiceMode: mode,
    audience,
    voiceViolations: auditHumanizedText(text),
  };
}

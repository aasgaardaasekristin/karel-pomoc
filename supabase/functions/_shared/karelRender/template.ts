/**
 * karelRender/template.ts — TEMPLATE LAYER (edge mirror)
 * Mirror of src/lib/karelRender/template.ts. Keep 1:1.
 */

import { resolveAddressee, type Audience } from "./identity.ts";
import {
  humanizeText,
  describeUrgentLoad,
  addressTaskTo2ndPerson,
  auditHumanizedText,
} from "./humanize.ts";
import {
  selectVoiceMode,
  getVoiceStyle,
  buildGreeting,
  type VoiceMode,
} from "./voice.ts";

export interface BriefingInput {
  audience: Audience | string;
  hint?: "intimate" | "analysis";
  topTaskRaw?: string | null;
  urgentCount?: number;
  reason?: string | null;
  needFromHanka?: string | null;
  needFromKata?: string | null;
  now?: Date;
}

export interface BriefingResult {
  text: string;
  voiceMode: VoiceMode;
  audience: Audience;
  voiceViolations: string[];
}

export function renderKarelBriefing(input: BriefingInput): BriefingResult {
  const { audience } = resolveAddressee(
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
  periodPhrase: string;
  topPatternRaw: string;
  sensitiveAreaRaw?: string | null;
  strongestPointRaw?: string | null;
  recommendationRaw?: string | null;
  audience?: Audience;
}

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
  if (sensitive) paragraphs.push(`Za nejcitlivější místo považuji ${sensitive}.`);
  if (strong)    paragraphs.push(`Za nejsilnější opěrný bod považuji ${strong}.`);
  if (reco)      paragraphs.push(`Pro další období bych doporučil ${reco}.`);

  const text = paragraphs.join("\n\n");
  return {
    text,
    voiceMode: mode,
    audience,
    voiceViolations: auditHumanizedText(text),
  };
}

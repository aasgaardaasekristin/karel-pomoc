/**
 * karelRender/voice.ts — VOICE LAYER (edge mirror)
 * Mirror of src/lib/karelRender/voice.ts. Keep 1:1.
 */

import type { Audience } from "./identity.ts";

export type VoiceMode =
  | "team_lead"
  | "kata_direct"
  | "hanka_intimate"
  | "analysis";

export interface VoiceStyle {
  mode: VoiceMode;
  leadPhrase: string;
  needPhrase: string;
  askPhrase: string;
  closing: string;
}

const STYLES: Record<VoiceMode, VoiceStyle> = {
  team_lead: {
    mode: "team_lead",
    leadPhrase: "Dnes je nejdůležitější",
    needPhrase: "Potřebuji od vás",
    askPhrase: "Rád bych si od vás upřesnil",
    closing: "Jakmile to doplníte, navrhnu další krok.",
  },
  kata_direct: {
    mode: "kata_direct",
    leadPhrase: "Z dat za poslední dny vidím především",
    needPhrase: "Potřebuji od tebe",
    askPhrase: "Rád bych si od tebe upřesnil",
    closing: "Jakmile to bude jasné, navážeme.",
  },
  hanka_intimate: {
    mode: "hanka_intimate",
    leadPhrase: "Z toho, co dnes vidím, mě nejvíc drží",
    needPhrase: "Pro dnešek bych tě požádal především o",
    askPhrase: "Rád bych si od tebe upřesnil",
    closing: "Až budeš mít chvíli, dej mi vědět.",
  },
  analysis: {
    mode: "analysis",
    leadPhrase: "Když se ohlížím za uplynulým obdobím, vidím především",
    needPhrase: "Pro další období bych doporučil",
    askPhrase: "Zvlášť bych vás nyní požádal o",
    closing: "",
  },
};

export function selectVoiceMode(
  audience: Audience,
  hint?: "intimate" | "analysis",
): VoiceMode {
  if (hint === "analysis") return "analysis";
  if (audience === "team") return "team_lead";
  if (audience === "kata") return "kata_direct";
  if (audience === "hanka") return hint === "intimate" ? "hanka_intimate" : "kata_direct";
  return "team_lead";
}

export function getVoiceStyle(mode: VoiceMode): VoiceStyle {
  return STYLES[mode];
}

export function buildGreeting(audience: Audience, now: Date = new Date()): string {
  const h = now.getHours();
  let timeOfDay: string;
  if (h < 10) timeOfDay = "Dobré ráno";
  else if (h < 14) timeOfDay = "Dobrý den";
  else if (h < 18) timeOfDay = "Dobré odpoledne";
  else timeOfDay = "Dobrý večer";

  switch (audience) {
    case "team": return `${timeOfDay}, Haničko a Káťo.`;
    case "hanka": return `${timeOfDay}, Hani.`;
    case "kata":  return `${timeOfDay}, Káťo.`;
  }
}

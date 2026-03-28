import { callAiForJson } from "./aiCallWrapper.ts";

export interface SwitchingAnalysis {
  isSamePart: boolean;
  detectedPart: string | null;
  confidence: "low" | "medium" | "high";
  signals: string[];
  recommendation: string;
}

interface PartProfile {
  name: string;
  age: string;
  language_style: string;
  typical_topics: string[];
  emotional_baseline: string;
  vocabulary_markers: string[];
}

export async function detectSwitching(
  currentPartName: string,
  recentMessages: { role: string; content: string }[],
  lastUserMessage: string,
  knownParts: PartProfile[],
  apiKey: string,
): Promise<SwitchingAnalysis> {
  if (lastUserMessage.trim().length < 10) {
    return { isSamePart: true, detectedPart: null, confidence: "low", signals: [], recommendation: "Zpráva příliš krátká" };
  }

  const partsContext = knownParts.map(p =>
    `- ${p.name}: věk ${p.age}, styl "${p.language_style}", témata: ${p.typical_topics.join(", ")}, markery: ${p.vocabulary_markers.join(", ")}`
  ).join("\n");

  const conversationContext = recentMessages.slice(-6).map(m =>
    m.role === "user" ? `[UŽIVATEL]: ${m.content}` : `[KAREL]: ${m.content}`
  ).join("\n");

  const prompt = `Jsi analytický modul pro detekci switchingu v DID (disociativní porucha identity).

AKTUÁLNÍ ČÁST (s kým Karel mluví): ${currentPartName}

ZNÁMÉ ČÁSTI SYSTÉMU:
${partsContext || "(neznámé)"}

POSLEDNÍ KONVERZACE:
${conversationContext}

NOVÁ ZPRÁVA UŽIVATELE:
"${lastUserMessage}"

ANALYZUJ zda nová zpráva stále odpovídá profilu části "${currentPartName}" nebo zda se přepnula jiná část.

SIGNÁLY SWITCHINGU:
- Náhlá změna slovníku (dětský → dospělý, nebo naopak)
- Změna emočního tónu (klidný → agresivní)
- Změna témat (z her na trauma, z bezpečí na strach)
- Změna oslovení Karla
- Zmatenost ("kde jsem?", "kdo jsi?", "co se děje?")
- Změna jazyka/dialektu
- Regrese nebo progrese ve věku jazyka
- Část se představí jiným jménem
- Nová část řekne "to nejsem já" nebo "ten druhý"

ODPOVĚZ POUZE tímto JSON:
{
  "is_same_part": true/false,
  "detected_part": "jméno části nebo null",
  "confidence": "low/medium/high",
  "signals": ["seznam detekovaných signálů"],
  "recommendation": "co by měl Karel udělat"
}

Pokud si NEJSI JISTÝ, odpověz is_same_part: true s confidence: low. NIKDY neoznačuj switch pokud si nejsi alespoň medium jistý.`;

  const result = await callAiForJson({
    systemPrompt: "Jsi analytický modul. Odpovídej POUZE validním JSON.",
    userPrompt: prompt,
    model: "google/gemini-2.5-flash-lite",
    apiKey,
    requiredKeys: ["is_same_part", "confidence"],
    knownPartNames: knownParts.map(p => p.name),
    maxRetries: 0,
    fallback: {
      is_same_part: true,
      detected_part: null,
      confidence: "low",
      signals: [],
      recommendation: "Pokračuj normálně",
    },
    callerName: "switching-detector",
  });

  if (!result.success) {
    return { isSamePart: true, detectedPart: null, confidence: "low", signals: ["detection_failed"], recommendation: "Pokračuj normálně" };
  }

  const parsed = result.data;
  return {
    isSamePart: parsed.is_same_part !== false,
    detectedPart: parsed.detected_part || null,
    confidence: parsed.confidence || "low",
    signals: Array.isArray(parsed.signals) ? parsed.signals : [],
    recommendation: parsed.recommendation || "",
  };
}

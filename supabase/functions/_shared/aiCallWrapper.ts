/**
 * Wrapper kolem volání Gemini s automatickým JSON parsováním,
 * validací, anti-halucinací a retry logikou.
 */

import { safeJsonParse, validateJsonKeys, sanitizeAiOutput } from "./safeJsonParse.ts";
import { validateAgainstContext, applyCorrections } from "./antiHallucination.ts";

const AI_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";

interface AiJsonCallOptions {
  systemPrompt: string;
  userPrompt: string;
  model?: string;
  apiKey: string;
  requiredKeys?: string[];
  knownPartNames?: string[];
  maxRetries?: number;
  fallback?: any;
  callerName?: string;
}

interface AiJsonResult<T = any> {
  success: boolean;
  data: T | null;
  warnings: string[];
  parseMethod?: string;
  retries: number;
  error?: string;
}

export async function callAiForJson<T = any>(options: AiJsonCallOptions): Promise<AiJsonResult<T>> {
  const {
    systemPrompt, userPrompt,
    model = "google/gemini-2.5-flash",
    apiKey, requiredKeys = [], knownPartNames = [],
    maxRetries = 1, fallback = null, callerName = "unknown",
  } = options;

  let lastError = "";
  let totalRetries = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      let effectiveUserPrompt = userPrompt;
      if (attempt > 0) {
        effectiveUserPrompt += `\n\n⚠️ PŘEDCHOZÍ POKUS SELHAL: ${lastError}\nVrať POUZE validní JSON, žádný jiný text.`;
      }

      const res = await fetch(AI_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt + "\n\nVŽDY odpovídej POUZE validním JSON. Žádný markdown, žádný text před nebo za JSON." },
            { role: "user", content: effectiveUserPrompt },
          ],
        }),
      });

      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        totalRetries++;
        continue;
      }

      const aiData = await res.json();
      const rawContent = aiData.choices?.[0]?.message?.content || "";

      const parseResult = safeJsonParse<T>(rawContent, fallback);
      if (!parseResult.success) {
        lastError = parseResult.error || "json_parse_failed";
        totalRetries++;
        console.warn(`[${callerName}] JSON parse failed (attempt ${attempt + 1}): ${lastError}`);
        continue;
      }

      let data = parseResult.data!;
      data = sanitizeAiOutput(data) as T;

      // Validate required keys
      if (requiredKeys.length > 0) {
        const keyCheck = validateJsonKeys(data, requiredKeys);
        if (!keyCheck.valid) {
          console.warn(`[${callerName}] Missing keys: ${keyCheck.missing.join(", ")}`);
          for (const key of keyCheck.missing) {
            if (!(data as any)[key]) {
              (data as any)[key] = Array.isArray((fallback as any)?.[key]) ? [] : null;
            }
          }
        }
      }

      // Anti-hallucination
      const halluCheck = validateAgainstContext(data, { knownPartNames, maxArrayLength: 50, maxStringLength: 2000 });
      if (halluCheck.warnings.length > 0) {
        console.warn(`[${callerName}] Hallucination warnings:`, halluCheck.warnings);
        data = applyCorrections(data, halluCheck.corrections) as T;
      }

      return { success: true, data, warnings: halluCheck.warnings, parseMethod: parseResult.method, retries: totalRetries };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      totalRetries++;
      console.warn(`[${callerName}] Attempt ${attempt + 1} failed: ${lastError}`);
    }
  }

  console.error(`[${callerName}] All ${maxRetries + 1} attempts failed. Last error: ${lastError}`);
  return { success: false, data: fallback, warnings: [`All attempts failed: ${lastError}`], retries: totalRetries, error: lastError };
}

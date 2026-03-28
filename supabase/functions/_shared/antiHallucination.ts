/**
 * Validace AI výstupů proti halucinacím.
 * Ověřuje že AI neodkazuje na neexistující data.
 */

interface ValidationContext {
  knownPartNames?: string[];
  knownThreadIds?: string[];
  maxArrayLength?: number;
  maxStringLength?: number;
}

interface ValidationResult {
  valid: boolean;
  warnings: string[];
  corrections: Record<string, any>;
}

export function validateAgainstContext(data: any, context: ValidationContext): ValidationResult {
  const warnings: string[] = [];
  const corrections: Record<string, any> = {};

  if (!data || typeof data !== "object") return { valid: true, warnings: [], corrections: {} };

  // 1. Validate part_name references
  if (context.knownPartNames?.length) {
    const knownLower = context.knownPartNames.map(n => n.toLowerCase());

    if (data.part_name && typeof data.part_name === "string" && !knownLower.includes(data.part_name.toLowerCase())) {
      warnings.push(`Unknown part_name: "${data.part_name}". Known: ${context.knownPartNames.join(", ")}`);
    }

    if (data.detected_part && typeof data.detected_part === "string" && !knownLower.includes(data.detected_part.toLowerCase())) {
      warnings.push(`Unknown detected_part: "${data.detected_part}"`);
    }
  }

  // 2. Validate array lengths
  const maxArr = context.maxArrayLength || 50;
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value) && value.length > maxArr) {
      warnings.push(`Array "${key}" has ${value.length} items (max ${maxArr}). Truncating.`);
      corrections[key] = (value as any[]).slice(0, maxArr);
    }
  }

  // 3. Validate string lengths
  const maxStr = context.maxStringLength || 2000;
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "string" && value.length > maxStr) {
      warnings.push(`String "${key}" has ${value.length} chars (max ${maxStr}). Truncating.`);
      corrections[key] = (value as string).slice(0, maxStr) + "... (zkráceno)";
    }
  }

  // 4. Detect prompt leak
  const suspiciousPatterns = [/you are a/i, /system prompt/i, /\[INST\]/i, /\[SYSTEM\]/i, /as an ai/i, /language model/i];
  const jsonStr = JSON.stringify(data);
  for (const pattern of suspiciousPatterns) {
    if (pattern.test(jsonStr)) {
      warnings.push(`Suspicious pattern detected: ${pattern}`);
    }
  }

  return { valid: warnings.length === 0, warnings, corrections };
}

/** Aplikuj korekce na data. */
export function applyCorrections(data: any, corrections: Record<string, any>): any {
  if (!corrections || Object.keys(corrections).length === 0) return data;
  return { ...data, ...corrections };
}

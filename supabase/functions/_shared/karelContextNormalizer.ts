/**
 * karelContextNormalizer.ts
 * Maps runtime mode + didSubMode into a canonical KarelContext.
 * Single responsibility: context resolution. No side effects.
 */

export type KarelDomain =
  | "did_terapeut"
  | "did_deti"
  | "hana_osobni"
  | "hana_pracovni"
  | "porada";

export type KarelAudience =
  | "hanicka"
  | "kata"
  | "dite"
  | "general";

export interface KarelContext {
  domain: KarelDomain;
  audience: KarelAudience;
  subject?: string;
}

interface NormalizeParams {
  mode: string;
  didSubMode?: string | null;
  partName?: string | null;
  explicitDomain?: KarelDomain;
  explicitAudience?: KarelAudience;
}

function normalizeSubject(partName?: string | null): string | undefined {
  const raw = (partName ?? "").trim();
  if (!raw || raw.toLowerCase() === "null") return undefined;
  return raw;
}

const CHILDCARE_SUB_MODE_MAP: Record<string, { domain: KarelDomain; audience: KarelAudience }> = {
  mamka:    { domain: "did_terapeut",  audience: "hanicka" },
  kata:     { domain: "did_terapeut",  audience: "kata" },
  cast:     { domain: "did_deti",      audience: "dite" },
  general:  { domain: "hana_osobni",   audience: "hanicka" },
  form:     { domain: "did_terapeut",  audience: "general" },
  freetext: { domain: "did_terapeut",  audience: "general" },
  research: { domain: "did_terapeut",  audience: "general" },
};

const TOP_LEVEL_MODE_MAP: Record<string, { domain: KarelDomain; audience: KarelAudience }> = {
  debrief:        { domain: "hana_osobni",   audience: "hanicka" },
  supervision:    { domain: "hana_pracovni", audience: "hanicka" },
  safety:         { domain: "hana_pracovni", audience: "hanicka" },
  kartoteka:      { domain: "hana_pracovni", audience: "general" },
  research:       { domain: "hana_pracovni", audience: "general" },
  kata:           { domain: "did_terapeut",  audience: "kata" },
  "live-session": { domain: "hana_pracovni", audience: "hanicka" },
};

const SAFE_FALLBACK: { domain: KarelDomain; audience: KarelAudience } = {
  domain: "hana_pracovni",
  audience: "general",
};

export function normalizeKarelContext(params: NormalizeParams): KarelContext {
  const { mode, didSubMode, partName, explicitDomain, explicitAudience } = params;

  // Explicit overrides have absolute priority
  if (explicitDomain && explicitAudience) {
    return {
      domain: explicitDomain,
      audience: explicitAudience,
      subject: normalizeSubject(partName),
    };
  }

  // Childcare mode — resolve via sub-mode
  if (mode === "childcare") {
    const subKey = (didSubMode ?? "").trim().toLowerCase();
    const mapped = subKey ? CHILDCARE_SUB_MODE_MAP[subKey] : undefined;

    if (mapped) {
      return { ...mapped, subject: normalizeSubject(partName) };
    }

    // null / empty / unknown sub-mode → did_terapeut / general (NEVER porada)
    if (!subKey || subKey === "null") {
      return {
        domain: "did_terapeut",
        audience: "general",
        subject: normalizeSubject(partName),
      };
    }

    // Unknown childcare sub-mode
    console.warn(
      `[karelContextNormalizer] Unknown childcare sub-mode: "${didSubMode}". Falling back to did_terapeut/general.`
    );
    return {
      domain: "did_terapeut",
      audience: "general",
      subject: normalizeSubject(partName),
    };
  }

  // Top-level mode
  const topMapped = TOP_LEVEL_MODE_MAP[mode];
  if (topMapped) {
    return { ...topMapped, subject: normalizeSubject(partName) };
  }

  // Unknown mode — safe fallback + warning
  console.warn(
    `[karelContextNormalizer] Unknown mode: "${mode}". Falling back to ${SAFE_FALLBACK.domain}/${SAFE_FALLBACK.audience}.`
  );
  return {
    ...SAFE_FALLBACK,
    subject: normalizeSubject(partName),
  };
}

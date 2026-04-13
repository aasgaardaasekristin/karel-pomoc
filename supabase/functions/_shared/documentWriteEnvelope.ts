export interface GovernedWriteMetadata {
  source_type?: string;
  source_id?: string;
  content_type?: string;
  subject_type?: string;
  subject_id?: string;
  crisis_event_id?: string;
}

interface GovernedWriteEnvelope extends GovernedWriteMetadata {
  __governed_write__: true;
  payload: string;
}

function isGovernedWriteEnvelope(value: unknown): value is GovernedWriteEnvelope {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Partial<GovernedWriteEnvelope>;
  return candidate.__governed_write__ === true && typeof candidate.payload === "string";
}

export function encodeGovernedWrite(payload: string, metadata: GovernedWriteMetadata): string {
  return JSON.stringify({
    __governed_write__: true,
    payload,
    ...metadata,
  });
}

export function decodeGovernedWrite(raw: string): {
  payload: string;
  metadata: GovernedWriteMetadata | null;
} {
  try {
    const parsed = JSON.parse(raw);
    if (!isGovernedWriteEnvelope(parsed)) {
      return { payload: raw, metadata: null };
    }

    const { payload, __governed_write__, ...metadata } = parsed;
    void __governed_write__;

    return {
      payload,
      metadata,
    };
  } catch {
    return { payload: raw, metadata: null };
  }
}
import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

export interface ObservationParams {
  subject_type: 'part' | 'therapist' | 'system' | 'context' | 'crisis' | 'logistics';
  subject_id: string;
  source_type: 'thread' | 'task_feedback' | 'session' | 'switch' | 'pulse_check' | 'board_note' | 'meeting' | 'drive_doc' | 'web_research' | 'therapist_message' | 'part_direct';
  source_ref?: string;
  fact: string;
  evidence_level?: 'D1' | 'D2' | 'D3' | 'I1' | 'H1';
  confidence?: number;
  time_horizon?: 'hours' | '0_14d' | '15_60d' | 'long_term';
}

/**
 * Vloží nové pozorování do did_observations.
 * Vrací UUID nového záznamu.
 */
export async function createObservation(
  sb: SupabaseClient,
  params: ObservationParams
): Promise<string> {
  const { data, error } = await sb
    .from('did_observations')
    .insert({
      subject_type: params.subject_type,
      subject_id: params.subject_id,
      source_type: params.source_type,
      source_ref: params.source_ref ?? null,
      fact: params.fact,
      evidence_level: params.evidence_level ?? 'I1',
      confidence: params.confidence ?? 0.5,
      time_horizon: params.time_horizon ?? '0_14d',
    })
    .select('id')
    .single();

  if (error) throw new Error(`createObservation failed: ${error.message}`);
  return data.id;
}

/**
 * Aplikuje 4 filtry (A-D) na pozorování a automaticky
 * vytvoří odpovídající implikace s destinations[], review_at, expires_at.
 *
 * Routing tabulka:
 *  hours + immediate_plan     → 05A critical_72h, review 6h, expires 72h
 *  0_14d + immediate_plan     → 05A, review 24h, expires 14d
 *  0_14d + context_only       → 05A, review 48h, expires 14d
 *  15_60d + part_profile      → 05B + part_card, review 7d, expires 60d
 *  long_term + part_profile   → part_card only, review 30d
 *  H1 evidence                → pending_question, NIKDY 05A
 *  risk                       → 05A + part_card_C + crisis_alert, review 6h
 *  team_coordination          → memory_karel + 05A
 */
export async function routeObservation(
  sb: SupabaseClient,
  obsId: string,
  obs: {
    subject_type: string;
    subject_id: string;
    evidence_level: string;
    time_horizon: string;
    fact: string;
  },
  impactType: 'context_only' | 'immediate_plan' | 'part_profile' | 'risk' | 'team_coordination'
): Promise<string> {
  const { deriveImplication } = await import("./implications.ts");

  const destinations: string[] = [];
  let reviewHours = 24;
  let expiresHours: number | null = null;

  // ── Routing logic based on 4 filters ──

  if (obs.time_horizon === 'hours' && impactType === 'immediate_plan') {
    destinations.push('05A');
    reviewHours = 6;
    expiresHours = 72;
  }

  if (obs.time_horizon === '0_14d' && impactType === 'immediate_plan') {
    destinations.push('05A');
    reviewHours = 24;
    expiresHours = 14 * 24;
  }

  if (obs.time_horizon === '0_14d' && impactType === 'context_only') {
    destinations.push('05A');
    reviewHours = 48;
    expiresHours = 14 * 24;
  }

  if (obs.time_horizon === '15_60d') {
    destinations.push('05B');
    if (impactType === 'part_profile') {
      destinations.push(`part_card_${obs.subject_id}`);
    }
    reviewHours = 7 * 24;
    expiresHours = 60 * 24;
  }

  if (obs.time_horizon === 'long_term' && impactType === 'part_profile') {
    destinations.push(`part_card_${obs.subject_id}`);
    reviewHours = 30 * 24;
  }

  // H1 = hypotéza → NIKDY jako fakt do 05A
  if (obs.evidence_level === 'H1') {
    destinations.push('pending_question');
    const idx = destinations.indexOf('05A');
    if (idx > -1) destinations.splice(idx, 1);
  }

  // risk → vždy 05A + part_card_C + crisis_alert
  if (impactType === 'risk') {
    if (!destinations.includes('05A')) destinations.push('05A');
    destinations.push(`part_card_${obs.subject_id}_C`);
    destinations.push('crisis_alert');
    reviewHours = 6;
  }

  // team_coordination → memory_karel + 05A
  if (impactType === 'team_coordination') {
    destinations.push('memory_karel');
    if (!destinations.includes('05A')) destinations.push('05A');
  }

  // Fallback: pokud žádný filtr nematched
  if (destinations.length === 0) {
    destinations.push('05A');
  }

  const now = Date.now();

  const implId = await deriveImplication(sb, {
    observation_id: obsId,
    impact_type: impactType,
    destinations,
    implication_text: obs.fact,
    review_at: new Date(now + reviewHours * 60 * 60 * 1000).toISOString(),
    expires_at: expiresHours
      ? new Date(now + expiresHours * 60 * 60 * 1000).toISOString()
      : undefined,
  });

  return implId;
}

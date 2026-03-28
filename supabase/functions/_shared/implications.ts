import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

export interface ImplicationParams {
  observation_id: string;
  impact_type: 'context_only' | 'immediate_plan' | 'part_profile' | 'risk' | 'team_coordination';
  destinations: string[];
  implication_text: string;
  review_at?: string;
  expires_at?: string;
  owner?: string;
}

/**
 * Vloží novou implikaci do did_implications.
 * Pokud review_at není zadáno, nastaví default +24h.
 * Vrací UUID nového záznamu.
 */
export async function deriveImplication(
  sb: SupabaseClient,
  params: ImplicationParams
): Promise<string> {
  const defaultReview = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await sb
    .from('did_implications')
    .insert({
      observation_id: params.observation_id,
      impact_type: params.impact_type,
      destinations: params.destinations,
      implication_text: params.implication_text,
      review_at: params.review_at ?? defaultReview,
      expires_at: params.expires_at ?? null,
      owner: params.owner ?? 'karel',
    })
    .select('id')
    .single();

  if (error) throw new Error(`deriveImplication failed: ${error.message}`);
  return data.id;
}

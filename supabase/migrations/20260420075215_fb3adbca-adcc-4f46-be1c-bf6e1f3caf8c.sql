ALTER TABLE public.did_team_deliberations
  ADD COLUMN IF NOT EXISTS karel_synthesis jsonb,
  ADD COLUMN IF NOT EXISTS karel_synthesized_at timestamptz;

COMMENT ON COLUMN public.did_team_deliberations.karel_synthesis IS
  'Karlova explicitní syntéza odpovědí Haničky a Káti + discussion_logu. Povinná pro aktivaci Karlova podpisu u typu crisis. Schema: { verdict: "crisis_persists"|"crisis_easing"|"crisis_resolvable", next_step: string, needs_karel_interview: boolean, key_insights: string[], drive_writeback_md: string, recommended_session_focus: string|null, risk_signals: string[], protective_signals: string[] }';

COMMENT ON COLUMN public.did_team_deliberations.karel_synthesized_at IS
  'Kdy Karel naposledy provedl syntézu odpovědí. Aktualizuje se při každém běhu karel-team-deliberation-synthesize.';
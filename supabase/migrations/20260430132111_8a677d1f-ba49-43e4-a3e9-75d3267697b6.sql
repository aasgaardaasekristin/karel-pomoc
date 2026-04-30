-- Audit table for the morning SLA watchdog runs.
-- Every invocation of karel-did-briefing-sla-watchdog inserts one row here so we can
-- prove end-to-end that the morning pipeline ran non-manually and is idempotent.
create table if not exists public.did_briefing_sla_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  ran_at timestamptz not null default now(),
  action text not null,                  -- skipped_already_ok | invoked_briefing | wrote_limited | error | unauthorized
  reason text,
  briefing_id uuid,
  briefing_attempt_id uuid,
  cycle_status text,
  generation_method text,
  payload jsonb not null default '{}'::jsonb
);

create index if not exists did_briefing_sla_runs_user_ran_idx
  on public.did_briefing_sla_runs (user_id, ran_at desc);

alter table public.did_briefing_sla_runs enable row level security;

drop policy if exists "did_briefing_sla_runs_service_all" on public.did_briefing_sla_runs;
create policy "did_briefing_sla_runs_service_all"
  on public.did_briefing_sla_runs
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

drop policy if exists "did_briefing_sla_runs_owner_select" on public.did_briefing_sla_runs;
create policy "did_briefing_sla_runs_owner_select"
  on public.did_briefing_sla_runs
  for select
  using (auth.uid() = user_id);
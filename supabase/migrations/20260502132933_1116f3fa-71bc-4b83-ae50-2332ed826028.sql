-- =========================================================================
-- P2: did_canonical_scope (canonical DID user, fail-closed)
-- =========================================================================

create table if not exists public.did_canonical_scope (
  id uuid primary key default gen_random_uuid(),
  scope_name text not null,
  canonical_user_id uuid null,
  active boolean not null default true,
  seed_status text not null default 'ready',
  seed_email text null,
  reason text null,
  created_by text null,
  updated_by text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint did_canonical_scope_seed_status_check
    check (seed_status in ('ready', 'email_not_found', 'manual_required', 'disabled'))
);

create unique index if not exists did_canonical_scope_one_active_per_scope
  on public.did_canonical_scope(scope_name)
  where active = true;

create index if not exists did_canonical_scope_scope_name_idx
  on public.did_canonical_scope(scope_name);

alter table public.did_canonical_scope enable row level security;

-- Authenticated users can read (it is metadata, not secret)
drop policy if exists "did_canonical_scope readable to authenticated" on public.did_canonical_scope;
create policy "did_canonical_scope readable to authenticated"
  on public.did_canonical_scope
  for select
  to authenticated
  using (true);

-- No client-side writes; only via SECURITY DEFINER RPC
drop policy if exists "did_canonical_scope no client write" on public.did_canonical_scope;
create policy "did_canonical_scope no client write"
  on public.did_canonical_scope
  for all
  to authenticated
  using (false)
  with check (false);

create or replace function public.did_canonical_scope_set_updated_at()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_did_canonical_scope_updated_at on public.did_canonical_scope;
create trigger trg_did_canonical_scope_updated_at
before update on public.did_canonical_scope
for each row execute function public.did_canonical_scope_set_updated_at();

-- Fail-closed canonical user lookup
create or replace function public.get_canonical_did_user_id()
returns uuid
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_count int;
  v_user_id uuid;
begin
  select count(*), max(canonical_user_id)
    into v_count, v_user_id
  from public.did_canonical_scope
  where scope_name = 'primary_did'
    and active = true
    and canonical_user_id is not null
    and seed_status = 'ready';

  if v_count = 0 then
    raise exception 'CANONICAL_USER_SCOPE_UNRESOLVED'
      using errcode = 'P0001';
  end if;
  if v_count > 1 then
    raise exception 'CANONICAL_USER_SCOPE_AMBIGUOUS'
      using errcode = 'P0001';
  end if;

  return v_user_id;
end;
$$;

revoke all on function public.get_canonical_did_user_id() from public, anon, authenticated;
grant execute on function public.get_canonical_did_user_id() to service_role;

-- Service-role only repair RPC
create or replace function public.set_canonical_did_user(p_user_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_existing_id uuid;
  v_now timestamptz := now();
begin
  if p_user_id is null then
    raise exception 'set_canonical_did_user: p_user_id is required'
      using errcode = '22023';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'set_canonical_did_user: p_reason is required (audit)'
      using errcode = '22023';
  end if;

  update public.did_canonical_scope
     set active = false,
         updated_by = 'service_role',
         updated_at = v_now,
         reason = coalesce(reason, '') ||
                  case when reason is null or reason = '' then '' else ' | ' end ||
                  format('deactivated_at=%s replaced_by_repair_rpc', v_now)
   where scope_name = 'primary_did' and active = true;

  insert into public.did_canonical_scope (
    scope_name, canonical_user_id, active, seed_status, seed_email,
    reason, created_by, updated_by
  ) values (
    'primary_did', p_user_id, true, 'ready', null,
    p_reason, 'service_role', 'service_role'
  )
  returning id into v_existing_id;

  return jsonb_build_object(
    'ok', true,
    'canonical_scope_id', v_existing_id,
    'canonical_user_id', p_user_id,
    'set_at', v_now
  );
end;
$$;

revoke all on function public.set_canonical_did_user(uuid, text) from public, anon, authenticated;
grant execute on function public.set_canonical_did_user(uuid, text) to service_role;

-- Seed: NEVER hardcode UUID. Look up email; if not found insert inactive diagnostic row.
do $$
declare
  v_user_id uuid;
begin
  -- Skip if a row for primary_did already exists (idempotent)
  if exists (select 1 from public.did_canonical_scope where scope_name = 'primary_did') then
    return;
  end if;

  select id into v_user_id
  from auth.users
  where email = 'psychoterapie@hana-chlebcova.cz'
  limit 1;

  if v_user_id is not null then
    insert into public.did_canonical_scope (
      scope_name, canonical_user_id, active, seed_status, seed_email,
      reason, created_by
    ) values (
      'primary_did', v_user_id, true, 'ready', 'psychoterapie@hana-chlebcova.cz',
      'Seeded from known therapist email at migration time.', 'migration'
    );
  else
    insert into public.did_canonical_scope (
      scope_name, canonical_user_id, active, seed_status, seed_email,
      reason, created_by
    ) values (
      'primary_did', null, false, 'email_not_found', 'psychoterapie@hana-chlebcova.cz',
      'Canonical DID user email not found during migration; protected writes must fail closed until admin resolves via set_canonical_did_user.',
      'migration'
    );
  end if;
end $$;

-- =========================================================================
-- P3: did_mutation_snapshots (generic before-image, enforced for 2 tables)
-- =========================================================================

create table if not exists public.did_mutation_snapshots (
  id uuid primary key default gen_random_uuid(),
  table_name text not null,
  row_id uuid not null,
  snapshot jsonb not null,
  reason text not null,
  actor text not null,
  created_at timestamptz not null default now()
);

create index if not exists did_mutation_snapshots_table_row_idx
  on public.did_mutation_snapshots(table_name, row_id, created_at desc);

create index if not exists did_mutation_snapshots_created_at_idx
  on public.did_mutation_snapshots(created_at desc);

alter table public.did_mutation_snapshots enable row level security;

-- No direct client access; only SECURITY DEFINER helpers
drop policy if exists "did_mutation_snapshots no client access" on public.did_mutation_snapshots;
create policy "did_mutation_snapshots no client access"
  on public.did_mutation_snapshots
  for all
  to authenticated
  using (false)
  with check (false);

-- Generic snapshot helper. Allowlist enforced for 2 DID-critical tables in this pass.
create or replace function public.did_snapshot_protected_mutation(
  p_table_name text,
  p_row_id uuid,
  p_reason text,
  p_actor text
) returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_snapshot jsonb;
  v_snapshot_id uuid;
begin
  if p_table_name not in ('did_team_deliberations', 'did_daily_session_plans') then
    raise exception 'did_snapshot_protected_mutation: table % not in protected allowlist', p_table_name
      using errcode = 'P0001';
  end if;
  if p_row_id is null then
    raise exception 'did_snapshot_protected_mutation: p_row_id required'
      using errcode = '22023';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'did_snapshot_protected_mutation: p_reason required (audit)'
      using errcode = '22023';
  end if;
  if coalesce(btrim(p_actor), '') = '' then
    raise exception 'did_snapshot_protected_mutation: p_actor required (audit)'
      using errcode = '22023';
  end if;

  if p_table_name = 'did_team_deliberations' then
    select to_jsonb(t.*) into v_snapshot
    from public.did_team_deliberations t
    where t.id = p_row_id;
  elsif p_table_name = 'did_daily_session_plans' then
    select to_jsonb(t.*) into v_snapshot
    from public.did_daily_session_plans t
    where t.id = p_row_id;
  end if;

  if v_snapshot is null then
    raise exception 'did_snapshot_protected_mutation: row % in % not found (cannot snapshot)', p_row_id, p_table_name
      using errcode = 'P0002';
  end if;

  insert into public.did_mutation_snapshots (table_name, row_id, snapshot, reason, actor)
  values (p_table_name, p_row_id, v_snapshot, p_reason, p_actor)
  returning id into v_snapshot_id;

  return v_snapshot_id;
end;
$$;

revoke all on function public.did_snapshot_protected_mutation(text, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.did_snapshot_protected_mutation(text, uuid, text, text) to service_role;

-- Rollback helper: restores all columns from snapshot back into the table
create or replace function public.did_rollback_protected_mutation(p_snapshot_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_row record;
begin
  select * into v_row
  from public.did_mutation_snapshots
  where id = p_snapshot_id;

  if v_row.id is null then
    raise exception 'did_rollback_protected_mutation: snapshot % not found', p_snapshot_id
      using errcode = 'P0002';
  end if;

  if v_row.table_name = 'did_team_deliberations' then
    -- Replace mutable jsonb/text/timestamptz protected fields from snapshot
    update public.did_team_deliberations t
       set program_draft = (v_row.snapshot->'program_draft'),
           agenda_outline = (v_row.snapshot->'agenda_outline'),
           status = nullif(v_row.snapshot->>'status', ''),
           hanka_signed_at = nullif(v_row.snapshot->>'hanka_signed_at','')::timestamptz,
           kata_signed_at = nullif(v_row.snapshot->>'kata_signed_at','')::timestamptz,
           karel_signed_at = nullif(v_row.snapshot->>'karel_signed_at','')::timestamptz,
           approved_program_draft_hash = nullif(v_row.snapshot->>'approved_program_draft_hash',''),
           approved_session_params_hash = nullif(v_row.snapshot->>'approved_session_params_hash',''),
           approved_program_snapshot = (v_row.snapshot->'approved_program_snapshot'),
           session_params = (v_row.snapshot->'session_params'),
           linked_live_session_id = nullif(v_row.snapshot->>'linked_live_session_id','')::uuid,
           karel_synthesis = (v_row.snapshot->'karel_synthesis'),
           karel_synthesized_at = nullif(v_row.snapshot->>'karel_synthesized_at','')::timestamptz,
           final_summary = nullif(v_row.snapshot->>'final_summary',''),
           updated_at = now()
     where t.id = v_row.row_id;
  elsif v_row.table_name = 'did_daily_session_plans' then
    update public.did_daily_session_plans p
       set plan_markdown = nullif(v_row.snapshot->>'plan_markdown',''),
           urgency_breakdown = (v_row.snapshot->'urgency_breakdown'),
           status = nullif(v_row.snapshot->>'status',''),
           lifecycle_status = nullif(v_row.snapshot->>'lifecycle_status',''),
           program_status = nullif(v_row.snapshot->>'program_status',''),
           approved_at = nullif(v_row.snapshot->>'approved_at','')::timestamptz,
           ready_to_start_at = nullif(v_row.snapshot->>'ready_to_start_at','')::timestamptz,
           started_at = nullif(v_row.snapshot->>'started_at','')::timestamptz,
           started_by = nullif(v_row.snapshot->>'started_by','')::uuid,
           start_audit = (v_row.snapshot->'start_audit'),
           selected_part = nullif(v_row.snapshot->>'selected_part',''),
           therapist = nullif(v_row.snapshot->>'therapist',''),
           session_lead = nullif(v_row.snapshot->>'session_lead',''),
           session_format = nullif(v_row.snapshot->>'session_format',''),
           generated_by = nullif(v_row.snapshot->>'generated_by',''),
           updated_at = now()
     where p.id = v_row.row_id;
  else
    raise exception 'did_rollback_protected_mutation: table % not supported', v_row.table_name
      using errcode = 'P0001';
  end if;

  return jsonb_build_object('ok', true, 'restored_table', v_row.table_name, 'restored_row_id', v_row.row_id, 'snapshot_id', v_row.id);
end;
$$;

revoke all on function public.did_rollback_protected_mutation(uuid) from public, anon, authenticated;
grant execute on function public.did_rollback_protected_mutation(uuid) to service_role;

-- =========================================================================
-- P3 enforcement INSIDE SECURITY DEFINER SQL functions
-- =========================================================================

-- ---- sync_and_start_approved_daily_plan: snapshot before mutation ----
create or replace function public.sync_and_start_approved_daily_plan(p_deliberation_id uuid, p_user_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  delib public.did_team_deliberations%rowtype;
  plan_row public.did_daily_session_plans%rowtype;
  sp jsonb;
  existing_contract jsonb;
  approval_sync jsonb;
  merged_contract jsonb;
  now_ts timestamptz := now();
  plan_id uuid;
  current_program_hash text;
  approved_program_hash text;
  current_params_hash text;
  approved_params_hash text;
  plan_text text;
  markdown_hash text;
  existing_program_hash text;
  existing_markdown_hash text;
  is_playroom boolean;
  approved_for_child boolean;
  led_by text;
  therapist_value text;
  session_lead_value text;
  session_format_value text;
  selected_part_value text;
  was_missing_sync boolean := false;
  audit_hashes jsonb := '{}'::jsonb;
  v_canonical_user_id uuid;
  v_snapshot_id uuid;
begin
  -- P2 fail-closed canonical user scope guard
  begin
    v_canonical_user_id := public.get_canonical_did_user_id();
  exception when others then
    insert into public.did_daily_session_start_audit(user_id, deliberation_id, started_by, result, error_code, message)
    values (p_user_id, p_deliberation_id, p_user_id, 'blocked', 'canonical_user_scope_unresolved', sqlerrm);
    return jsonb_build_object('ok', false, 'error_code', 'canonical_user_scope_unresolved', 'message', sqlerrm);
  end;
  if p_user_id is distinct from v_canonical_user_id then
    insert into public.did_daily_session_start_audit(user_id, deliberation_id, started_by, result, error_code, message)
    values (p_user_id, p_deliberation_id, p_user_id, 'blocked', 'canonical_user_scope_mismatch', 'p_user_id does not match canonical DID user');
    return jsonb_build_object('ok', false, 'error_code', 'canonical_user_scope_mismatch', 'message', 'p_user_id does not match canonical DID user.');
  end if;

  select * into delib
  from public.did_team_deliberations
  where id = p_deliberation_id and user_id = p_user_id
  for update;

  if delib.id is null then
    insert into public.did_daily_session_start_audit(user_id, deliberation_id, started_by, result, error_code, message)
    values (p_user_id, p_deliberation_id, p_user_id, 'blocked', 'missing_canonical_deliberation', 'Kanonická porada nebyla nalezena.');
    return jsonb_build_object('ok', false, 'error_code', 'missing_canonical_deliberation', 'message', 'Kanonická porada nebyla nalezena.');
  end if;

  if delib.deliberation_type <> 'session_plan' then
    insert into public.did_daily_session_start_audit(user_id, deliberation_id, started_by, result, error_code, message)
    values (p_user_id, delib.id, p_user_id, 'blocked', 'missing_daily_plan', 'Porada není plán sezení.');
    return jsonb_build_object('ok', false, 'error_code', 'missing_daily_plan', 'message', 'Porada není plán sezení.');
  end if;

  if delib.hanka_signed_at is null then
    insert into public.did_daily_session_start_audit(user_id, deliberation_id, plan_id, started_by, result, error_code, message)
    values (p_user_id, delib.id, delib.linked_live_session_id, p_user_id, 'blocked', 'missing_hanka_signature', 'Chybí podpis Haničky.');
    return jsonb_build_object('ok', false, 'error_code', 'missing_hanka_signature', 'message', 'Chybí podpis Haničky.');
  end if;
  if delib.kata_signed_at is null then
    insert into public.did_daily_session_start_audit(user_id, deliberation_id, plan_id, started_by, result, error_code, message)
    values (p_user_id, delib.id, delib.linked_live_session_id, p_user_id, 'blocked', 'missing_kata_signature', 'Chybí podpis Káti.');
    return jsonb_build_object('ok', false, 'error_code', 'missing_kata_signature', 'message', 'Chybí podpis Káti.');
  end if;
  if delib.status <> 'approved' then
    insert into public.did_daily_session_start_audit(user_id, deliberation_id, plan_id, started_by, result, error_code, message)
    values (p_user_id, delib.id, delib.linked_live_session_id, p_user_id, 'blocked', 'deliberation_not_approved', 'Porada ještě není schválená.');
    return jsonb_build_object('ok', false, 'error_code', 'deliberation_not_approved', 'message', 'Porada ještě není schválená.');
  end if;

  plan_id := delib.linked_live_session_id;
  if plan_id is null then
    insert into public.did_daily_session_start_audit(user_id, deliberation_id, started_by, result, error_code, message)
    values (p_user_id, delib.id, p_user_id, 'blocked', 'missing_daily_plan', 'Chybí navázaný denní plán.');
    return jsonb_build_object('ok', false, 'error_code', 'missing_daily_plan', 'message', 'Chybí navázaný denní plán.');
  end if;

  select * into plan_row
  from public.did_daily_session_plans
  where id = plan_id and user_id = p_user_id
  for update;

  if plan_row.id is null then
    insert into public.did_daily_session_start_audit(user_id, deliberation_id, plan_id, started_by, result, error_code, message)
    values (p_user_id, delib.id, plan_id, p_user_id, 'blocked', 'missing_daily_plan', 'Navázaný denní plán nebyl nalezen.');
    return jsonb_build_object('ok', false, 'error_code', 'missing_daily_plan', 'message', 'Navázaný denní plán nebyl nalezen.');
  end if;

  current_program_hash := md5(coalesce(delib.program_draft::text, '[]'));
  approved_program_hash := coalesce(delib.approved_program_draft_hash, current_program_hash);
  current_params_hash := md5(coalesce(delib.session_params::text, '{}'));
  approved_params_hash := coalesce(delib.approved_session_params_hash, current_params_hash);
  audit_hashes := jsonb_build_object('program_draft_hash', current_program_hash, 'approved_program_draft_hash', approved_program_hash, 'session_params_hash', current_params_hash);

  if delib.approved_program_draft_hash is null or delib.approved_session_params_hash is null then
    -- snapshot before backfill
    begin
      v_snapshot_id := public.did_snapshot_protected_mutation(
        'did_team_deliberations', delib.id,
        'sync_and_start: backfill approved_program_draft_hash/snapshot',
        'sync_and_start_approved_daily_plan'
      );
    exception when others then
      return jsonb_build_object('ok', false, 'error_code', 'mutation_snapshot_failed', 'message', sqlerrm);
    end;

    update public.did_team_deliberations
    set approved_program_draft_hash = current_program_hash,
        approved_session_params_hash = current_params_hash,
        approved_program_snapshot = jsonb_build_object(
          'program_draft', coalesce(delib.program_draft, '[]'::jsonb),
          'session_params', coalesce(delib.session_params, '{}'::jsonb),
          'program_draft_hash', current_program_hash,
          'session_params_hash', current_params_hash,
          'signed_at', coalesce(delib.karel_signed_at, delib.updated_at, now_ts),
          'backfilled_at', now_ts
        ),
        updated_at = now_ts
    where id = delib.id;
    approved_program_hash := current_program_hash;
    approved_params_hash := current_params_hash;
    audit_hashes := jsonb_set(audit_hashes, '{approved_program_draft_hash}', to_jsonb(approved_program_hash));
  end if;

  if current_program_hash <> approved_program_hash or current_params_hash <> approved_params_hash then
    insert into public.did_daily_session_start_audit(user_id, deliberation_id, plan_id, started_by, approval_hashes, result, error_code, message)
    values (p_user_id, delib.id, plan_row.id, p_user_id, audit_hashes, 'blocked', 'program_hash_mismatch', 'Program se změnil po podpisu a vyžaduje nové schválení.');
    return jsonb_build_object('ok', false, 'error_code', 'program_hash_mismatch', 'message', 'Program se změnil po podpisu a vyžaduje nové schválení.');
  end if;

  sp := coalesce(delib.session_params, '{}'::jsonb);
  led_by := btrim(coalesce(sp->>'led_by', ''));
  is_playroom := coalesce(sp->>'session_actor', '') = 'karel_direct'
    or coalesce(sp->>'ui_surface', '') = 'did_kids_playroom'
    or coalesce(sp->>'session_format', '') = 'playroom'
    or lower(led_by) like 'kar%';

  existing_contract := coalesce(plan_row.urgency_breakdown, '{}'::jsonb);
  approval_sync := coalesce(existing_contract->'approval_sync', '{}'::jsonb);
  was_missing_sync := coalesce(approval_sync->>'status', '') = '';
  existing_program_hash := approval_sync->>'program_draft_hash';
  existing_markdown_hash := approval_sync->>'plan_markdown_hash';

  if approval_sync ? 'deliberation_id' and approval_sync->>'deliberation_id' <> delib.id::text then
    insert into public.did_daily_session_start_audit(user_id, deliberation_id, plan_id, started_by, approval_hashes, result, error_code, message)
    values (p_user_id, delib.id, plan_row.id, p_user_id, audit_hashes, 'blocked', 'plan_not_linked_to_deliberation', 'Approval metadata ukazují na jinou poradu.');
    return jsonb_build_object('ok', false, 'error_code', 'plan_not_linked_to_deliberation', 'message', 'Approval metadata ukazují na jinou poradu.');
  end if;
  if existing_program_hash is not null and existing_program_hash <> current_program_hash then
    insert into public.did_daily_session_start_audit(user_id, deliberation_id, plan_id, started_by, approval_hashes, result, error_code, message)
    values (p_user_id, delib.id, plan_row.id, p_user_id, audit_hashes || jsonb_build_object('existing_program_draft_hash', existing_program_hash), 'blocked', 'program_hash_mismatch', 'Hash schváleného programu nesedí.');
    return jsonb_build_object('ok', false, 'error_code', 'program_hash_mismatch', 'message', 'Hash schváleného programu nesedí.');
  end if;

  plan_text := public.build_approved_plan_markdown(delib);

  if plan_text is null or btrim(plan_text) = '' then
    insert into public.did_daily_session_start_audit(user_id, deliberation_id, plan_id, started_by, approval_hashes, result, error_code, message)
    values (p_user_id, delib.id, plan_row.id, p_user_id, audit_hashes, 'blocked', 'approved_plan_markdown_empty', 'Builder vrátil prázdný plán.');
    return jsonb_build_object('ok', false, 'error_code', 'approved_plan_markdown_empty', 'message', 'Builder vrátil prázdný plán.');
  end if;
  if plan_text not ilike '%## Program sezení%' then
    insert into public.did_daily_session_start_audit(user_id, deliberation_id, plan_id, started_by, approval_hashes, result, error_code, message)
    values (p_user_id, delib.id, plan_row.id, p_user_id, audit_hashes, 'blocked', 'approved_plan_markdown_missing_program_section', 'Schválený plán nemá sekci Program sezení.');
    return jsonb_build_object('ok', false, 'error_code', 'approved_plan_markdown_missing_program_section', 'message', 'Schválený plán nemá sekci Program sezení.');
  end if;
  if plan_text !~ E'\n1\\.\\s+\\*\\*' then
    insert into public.did_daily_session_start_audit(user_id, deliberation_id, plan_id, started_by, approval_hashes, result, error_code, message)
    values (p_user_id, delib.id, plan_row.id, p_user_id, audit_hashes, 'blocked', 'approved_plan_markdown_unparseable', 'Schválený plán neobsahuje očíslované body.');
    return jsonb_build_object('ok', false, 'error_code', 'approved_plan_markdown_unparseable', 'message', 'Schválený plán neobsahuje očíslované body.');
  end if;

  markdown_hash := md5(plan_text);
  audit_hashes := audit_hashes || jsonb_build_object('plan_markdown_hash', markdown_hash);

  approved_for_child := not is_playroom
    or coalesce((existing_contract->>'approved_for_child_session')::boolean, false)
    or coalesce((existing_contract #>> '{approval,approved_for_child_session}')::boolean, false)
    or coalesce((existing_contract #>> '{playroom_plan,approval,approved_for_child_session}')::boolean, false)
    or coalesce((existing_contract #>> '{playroom_plan,therapist_review,approved_for_child_session}')::boolean, false)
    or coalesce((sp->>'approved_for_child_session')::boolean, false)
    or coalesce((sp #>> '{approval,approved_for_child_session}')::boolean, false)
    or coalesce((sp #>> '{playroom_plan,approval,approved_for_child_session}')::boolean, false)
    or coalesce((sp #>> '{playroom_plan,therapist_review,approved_for_child_session}')::boolean, false);

  if is_playroom and approved_for_child = false then
    insert into public.did_daily_session_start_audit(user_id, deliberation_id, plan_id, started_by, approval_hashes, result, error_code, message)
    values (p_user_id, delib.id, plan_row.id, p_user_id, audit_hashes, 'blocked', 'approved_for_child_session_missing', 'Herna nemá schválení pro dětskou místnost.');
    return jsonb_build_object('ok', false, 'error_code', 'approved_for_child_session_missing', 'message', 'Herna nemá schválení pro dětskou místnost.');
  end if;

  therapist_value := case when is_playroom then 'karel' when lower(led_by) like 'ka%' or lower(led_by) like 'ká%' then 'kata' else 'hanka' end;
  session_lead_value := case when is_playroom then 'karel' when lower(led_by) like 'ka%' or lower(led_by) like 'ká%' then 'kata' when lower(led_by) like 'sp%' then 'obe' else 'hanka' end;
  session_format_value := case when is_playroom then 'playroom' when sp->>'session_format' = 'individual' then 'osobně' when sp->>'session_format' = 'joint' then 'kombinované' else coalesce(nullif(sp->>'session_format', ''), plan_row.session_format, 'osobně') end;
  selected_part_value := coalesce(nullif(sp->>'part_name', ''), case when array_length(delib.subject_parts, 1) > 0 then delib.subject_parts[1] else null end, plan_row.selected_part, '(neurčeno)');

  if lower(coalesce(plan_row.status, '')) = 'in_progress'
     or lower(coalesce(plan_row.lifecycle_status, '')) = 'in_progress'
     or plan_row.started_at is not null then
    insert into public.did_daily_session_start_audit(user_id, deliberation_id, plan_id, started_by, approval_hashes, result, message)
    values (p_user_id, delib.id, plan_row.id, p_user_id, audit_hashes, 'already_started', 'Plán už běží.');
    update public.did_daily_session_plans
    set start_audit = coalesce(start_audit, '{}'::jsonb) || jsonb_build_object('deliberation_id', delib.id::text, 'plan_id', plan_row.id::text, 'user_id', p_user_id::text, 'started_by', p_user_id::text, 'sync_source', 'sync_and_start_approved_daily_plan', 'approval_hashes', audit_hashes, 'result', 'already_started', 'checked_at', now_ts),
        updated_at = now_ts
    where id = plan_row.id;
    return jsonb_build_object('ok', true, 'plan_id', plan_row.id, 'already_started', true, 'started', false);
  end if;

  if coalesce(approval_sync->>'status', '') <> '' and coalesce(approval_sync->>'status', '') <> 'synced' then
    insert into public.did_daily_session_start_audit(user_id, deliberation_id, plan_id, started_by, approval_hashes, result, error_code, message)
    values (p_user_id, delib.id, plan_row.id, p_user_id, audit_hashes, 'blocked', 'sync_failed', 'Approval sync existuje, ale není ve stavu synced.');
    return jsonb_build_object('ok', false, 'error_code', 'sync_failed', 'message', 'Approval sync existuje, ale není ve stavu synced.');
  end if;

  merged_contract := existing_contract
    || jsonb_build_object('source', 'team_deliberation', 'deliberation_id', delib.id::text, 'program_source', 'program_draft', 'human_review_required', true, 'review_state', 'approved', 'approved_at', coalesce(plan_row.approved_at, now_ts), 'approval', coalesce(existing_contract->'approval', '{}'::jsonb) || jsonb_build_object('review_required', true, 'was_required', true, 'review_fulfilled', true, 'review_state', 'approved', 'approved_at', coalesce(plan_row.approved_at, now_ts), 'signed_by', jsonb_build_array('hanka', 'kata'), 'approved_for_child_session', is_playroom), 'approval_sync', jsonb_build_object('status', 'synced', 'source', 'sync_and_start_approved_daily_plan', 'synced_at', now_ts, 'deliberation_id', delib.id::text, 'program_draft_hash', current_program_hash, 'approved_program_draft_hash', approved_program_hash, 'session_params_hash', current_params_hash, 'plan_markdown_hash', markdown_hash, 'review_required', true, 'review_fulfilled', true))
    || case when is_playroom then jsonb_build_object('approved_for_child_session', true, 'mode', 'playroom', 'session_actor', 'karel_direct', 'lead_entity', 'karel', 'ui_surface', 'did_kids_playroom', 'playroom_plan', sp->'playroom_plan') else '{}'::jsonb end;

  -- ⭐ P3 SNAPSHOT before destructive sync UPDATE
  begin
    v_snapshot_id := public.did_snapshot_protected_mutation(
      'did_daily_session_plans', plan_row.id,
      'sync_and_start: pre-sync overwrite (plan_markdown, urgency_breakdown, status, etc.)',
      'sync_and_start_approved_daily_plan'
    );
  exception when others then
    return jsonb_build_object('ok', false, 'error_code', 'mutation_snapshot_failed', 'message', sqlerrm);
  end;

  update public.did_daily_session_plans
  set selected_part = selected_part_value, plan_markdown = plan_text, urgency_breakdown = merged_contract, therapist = therapist_value, session_lead = session_lead_value, session_format = session_format_value, generated_by = 'team_deliberation', program_status = 'ready_to_start', approved_at = coalesce(approved_at, now_ts), ready_to_start_at = coalesce(ready_to_start_at, now_ts), updated_at = now_ts
  where id = plan_row.id;

  select * into plan_row
  from public.did_daily_session_plans
  where id = plan_id and user_id = p_user_id
  for update;

  approval_sync := coalesce(plan_row.urgency_breakdown->'approval_sync', '{}'::jsonb);
  if plan_row.program_status not in ('approved', 'ready_to_start') or plan_row.approved_at is null then
    insert into public.did_daily_session_start_audit(user_id, deliberation_id, plan_id, started_by, approval_hashes, result, error_code, message)
    values (p_user_id, delib.id, plan_row.id, p_user_id, audit_hashes, 'blocked', 'program_status_not_approved', 'Program není ve schváleném stavu.');
    return jsonb_build_object('ok', false, 'error_code', 'program_status_not_approved', 'message', 'Program není ve schváleném stavu.');
  end if;
  if approval_sync->>'status' <> 'synced' then
    insert into public.did_daily_session_start_audit(user_id, deliberation_id, plan_id, started_by, approval_hashes, result, error_code, message)
    values (p_user_id, delib.id, plan_row.id, p_user_id, audit_hashes, 'blocked', 'approval_sync_missing', 'Approval sync chybí.');
    return jsonb_build_object('ok', false, 'error_code', 'approval_sync_missing', 'message', 'Approval sync chybí.');
  end if;
  if approval_sync->>'program_draft_hash' <> current_program_hash then
    insert into public.did_daily_session_start_audit(user_id, deliberation_id, plan_id, started_by, approval_hashes, result, error_code, message)
    values (p_user_id, delib.id, plan_row.id, p_user_id, audit_hashes, 'blocked', 'program_hash_mismatch', 'Hash programu po synchronizaci nesedí.');
    return jsonb_build_object('ok', false, 'error_code', 'program_hash_mismatch', 'message', 'Hash programu po synchronizaci nesedí.');
  end if;
  if approval_sync->>'plan_markdown_hash' <> md5(coalesce(plan_row.plan_markdown, '')) then
    insert into public.did_daily_session_start_audit(user_id, deliberation_id, plan_id, started_by, approval_hashes, result, error_code, message)
    values (p_user_id, delib.id, plan_row.id, p_user_id, audit_hashes, 'blocked', 'plan_markdown_hash_mismatch', 'Hash plánu po synchronizaci nesedí.');
    return jsonb_build_object('ok', false, 'error_code', 'plan_markdown_hash_mismatch', 'message', 'Hash plánu po synchronizaci nesedí.');
  end if;

  -- ⭐ P3 SNAPSHOT before destructive START UPDATE (status/lifecycle/started_at/start_audit)
  begin
    v_snapshot_id := public.did_snapshot_protected_mutation(
      'did_daily_session_plans', plan_row.id,
      'sync_and_start: pre-start overwrite (status, lifecycle_status, started_at, start_audit)',
      'sync_and_start_approved_daily_plan'
    );
  exception when others then
    return jsonb_build_object('ok', false, 'error_code', 'mutation_snapshot_failed', 'message', sqlerrm);
  end;

  update public.did_daily_session_plans
  set status = 'in_progress', lifecycle_status = 'in_progress', program_status = 'in_progress', started_at = coalesce(started_at, now_ts), started_by = p_user_id, start_source = 'sync_and_start_approved_daily_plan', start_audit = coalesce(start_audit, '{}'::jsonb) || jsonb_build_object('deliberation_id', delib.id::text, 'plan_id', plan_row.id::text, 'user_id', p_user_id::text, 'started_by', p_user_id::text, 'sync_source', 'sync_and_start_approved_daily_plan', 'approval_hashes', audit_hashes, 'result', 'started', 'was_missing_sync', was_missing_sync, 'started_at', now_ts), updated_at = now_ts
  where id = plan_row.id;

  insert into public.did_daily_session_start_audit(user_id, deliberation_id, plan_id, started_by, approval_hashes, result, message)
  values (p_user_id, delib.id, plan_row.id, p_user_id, audit_hashes, 'started', 'Plán byl bezpečně synchronizován a spuštěn.');

  return jsonb_build_object('ok', true, 'plan_id', plan_row.id, 'started', true, 'synced', true, 'was_missing_sync', was_missing_sync);
exception when others then
  insert into public.did_daily_session_start_audit(user_id, deliberation_id, plan_id, started_by, approval_hashes, result, error_code, message)
  values (p_user_id, p_deliberation_id, plan_id, p_user_id, audit_hashes, 'error', 'sync_failed', sqlerrm);
  return jsonb_build_object('ok', false, 'error_code', 'sync_failed', 'message', sqlerrm);
end;
$function$;

-- ---- team_deliberation_signoff_and_sync: snapshot before mutation ----
create or replace function public.team_deliberation_signoff_and_sync(p_deliberation_id uuid, p_user_id uuid, p_signer text, p_plan_markdown text default null::text, p_ready_to_start boolean default false, p_sync_source text default 'signoff_sync'::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  delib public.did_team_deliberations%rowtype;
  plan_row public.did_daily_session_plans%rowtype;
  sp jsonb;
  old_contract jsonb;
  merged_contract jsonb;
  now_ts timestamptz := now();
  is_playroom boolean;
  plan_id uuid;
  bridge_mode text := 'skipped';
  program_hash text;
  markdown_hash text;
  led_by text;
  therapist_value text;
  session_lead_value text;
  session_format_value text;
  selected_part_value text;
  plan_text text;
  candidate_text text;
  v_canonical_user_id uuid;
  v_snapshot_id uuid;
begin
  if p_signer not in ('hanka', 'kata') then
    raise exception 'bad signer' using errcode = '22023';
  end if;

  -- P2 fail-closed canonical user scope guard
  begin
    v_canonical_user_id := public.get_canonical_did_user_id();
  exception when others then
    raise exception 'canonical_user_scope_unresolved: %', sqlerrm using errcode = 'P0001';
  end;
  if p_user_id is distinct from v_canonical_user_id then
    raise exception 'canonical_user_scope_mismatch' using errcode = 'P0001';
  end if;

  select * into delib
  from public.did_team_deliberations
  where id = p_deliberation_id and user_id = p_user_id
  for update;

  if delib.id is null then
    raise exception 'deliberation not found' using errcode = 'P0002';
  end if;

  -- ⭐ P3 SNAPSHOT before signature mutation on did_team_deliberations
  begin
    v_snapshot_id := public.did_snapshot_protected_mutation(
      'did_team_deliberations', delib.id,
      format('signoff_and_sync: pre-signature update by %s', p_signer),
      'team_deliberation_signoff_and_sync'
    );
  exception when others then
    raise exception 'mutation_snapshot_failed: %', sqlerrm using errcode = 'P0001';
  end;

  if p_signer = 'hanka' and delib.hanka_signed_at is null then
    update public.did_team_deliberations set hanka_signed_at = now_ts where id = p_deliberation_id;
  elsif p_signer = 'kata' and delib.kata_signed_at is null then
    update public.did_team_deliberations set kata_signed_at = now_ts where id = p_deliberation_id;
  end if;

  select * into delib from public.did_team_deliberations where id = p_deliberation_id for update;

  plan_id := delib.linked_live_session_id;

  if delib.status = 'approved' and delib.deliberation_type = 'session_plan' then
    sp := coalesce(delib.session_params, '{}'::jsonb);
    led_by := btrim(coalesce(sp->>'led_by', ''));
    is_playroom := coalesce(sp->>'session_actor', '') = 'karel_direct'
      or coalesce(sp->>'ui_surface', '') = 'did_kids_playroom'
      or coalesce(sp->>'session_format', '') = 'playroom'
      or lower(led_by) like 'kar%';

    therapist_value := case when is_playroom then 'karel' when lower(led_by) like 'ka%' or lower(led_by) like 'ká%' then 'kata' else 'hanka' end;
    session_lead_value := case when is_playroom then 'karel' when lower(led_by) like 'ka%' or lower(led_by) like 'ká%' then 'kata' when lower(led_by) like 'sp%' then 'obe' else 'hanka' end;
    session_format_value := case when is_playroom then 'playroom' when sp->>'session_format' = 'individual' then 'osobně' when sp->>'session_format' = 'joint' then 'kombinované' else coalesce(nullif(sp->>'session_format', ''), 'osobně') end;
    selected_part_value := coalesce(nullif(sp->>'part_name', ''), case when array_length(delib.subject_parts, 1) > 0 then delib.subject_parts[1] else null end, '(neurčeno)');

    candidate_text := nullif(btrim(coalesce(p_plan_markdown, '')), '');
    if candidate_text is not null
       and candidate_text ilike '%## Program sezení%'
       and candidate_text ~ E'\n1\\.\\s+\\*\\*' then
      plan_text := candidate_text;
    else
      plan_text := public.build_approved_plan_markdown(delib);
    end if;

    program_hash := md5(coalesce(delib.program_draft::text, '[]'));
    markdown_hash := md5(plan_text);

    if plan_id is not null then
      select * into plan_row
      from public.did_daily_session_plans
      where id = plan_id and user_id = p_user_id
      for update;
    end if;

    if plan_id is not null and plan_row.id is not null then
      old_contract := coalesce(plan_row.urgency_breakdown, '{}'::jsonb);
      merged_contract := old_contract
        || jsonb_build_object(
          'source', 'team_deliberation',
          'deliberation_id', delib.id::text,
          'program_source', 'program_draft',
          'human_review_required', true,
          'review_state', 'approved',
          'approved_at', now_ts,
          'approval', coalesce(old_contract->'approval', '{}'::jsonb) || jsonb_build_object(
            'review_required', true, 'was_required', true, 'review_fulfilled', true,
            'review_state', 'approved', 'approved_at', now_ts,
            'signed_by', jsonb_build_array('hanka', 'kata'),
            'approved_for_child_session', is_playroom
          ),
          'approval_sync', jsonb_build_object(
            'status', 'synced', 'source', p_sync_source, 'synced_at', now_ts,
            'deliberation_id', delib.id::text,
            'program_draft_hash', program_hash,
            'plan_markdown_hash', markdown_hash,
            'review_required', true, 'review_fulfilled', true
          )
        )
        || case when is_playroom then jsonb_build_object('approved_for_child_session', true) else '{}'::jsonb end;

      -- ⭐ P3 SNAPSHOT before destructive plan UPDATE
      begin
        v_snapshot_id := public.did_snapshot_protected_mutation(
          'did_daily_session_plans', plan_row.id,
          'signoff_and_sync: pre-update overwrite (plan_markdown, urgency_breakdown, status fields)',
          'team_deliberation_signoff_and_sync'
        );
      exception when others then
        raise exception 'mutation_snapshot_failed: %', sqlerrm using errcode = 'P0001';
      end;

      update public.did_daily_session_plans
      set plan_markdown = plan_text,
          urgency_breakdown = merged_contract,
          therapist = therapist_value,
          session_lead = session_lead_value,
          session_format = session_format_value,
          generated_by = 'team_deliberation',
          program_status = case when p_ready_to_start then 'ready_to_start' else 'approved' end,
          approved_at = coalesce(approved_at, now_ts),
          ready_to_start_at = case when p_ready_to_start then coalesce(ready_to_start_at, now_ts) else ready_to_start_at end,
          updated_at = now_ts
      where id = plan_id;
      bridge_mode := 'update';
    else
      insert into public.did_daily_session_plans (
        user_id, plan_date, selected_part, therapist, session_format, status,
        urgency_score, urgency_breakdown, plan_markdown, generated_by,
        session_lead, program_status, approved_at, ready_to_start_at
      ) values (
        p_user_id, current_date, selected_part_value, therapist_value, session_format_value,
        'generated',
        case when delib.priority = 'crisis' then 100 else 70 end,
        jsonb_build_object(
          'source', 'team_deliberation', 'deliberation_id', delib.id::text,
          'program_source', 'program_draft', 'human_review_required', true,
          'review_state', 'approved', 'approved_at', now_ts,
          'approved_for_child_session', is_playroom,
          'approval', jsonb_build_object(
            'review_required', true, 'was_required', true, 'review_fulfilled', true,
            'review_state', 'approved', 'approved_at', now_ts,
            'signed_by', jsonb_build_array('hanka', 'kata'),
            'approved_for_child_session', is_playroom
          ),
          'approval_sync', jsonb_build_object(
            'status', 'synced', 'source', p_sync_source, 'synced_at', now_ts,
            'deliberation_id', delib.id::text,
            'program_draft_hash', program_hash,
            'plan_markdown_hash', markdown_hash,
            'review_required', true, 'review_fulfilled', true
          )
        ) || case when is_playroom then jsonb_build_object('mode', 'playroom', 'session_actor', 'karel_direct', 'lead_entity', 'karel', 'ui_surface', 'did_kids_playroom', 'playroom_plan', sp->'playroom_plan') else '{}'::jsonb end,
        plan_text, 'team_deliberation', session_lead_value,
        case when p_ready_to_start then 'ready_to_start' else 'approved' end,
        now_ts,
        case when p_ready_to_start then now_ts else null end
      )
      returning id into plan_id;

      -- ⭐ P3 SNAPSHOT before destructive linked_live_session_id update on deliberation
      begin
        v_snapshot_id := public.did_snapshot_protected_mutation(
          'did_team_deliberations', delib.id,
          'signoff_and_sync: pre-link update (linked_live_session_id)',
          'team_deliberation_signoff_and_sync'
        );
      exception when others then
        raise exception 'mutation_snapshot_failed: %', sqlerrm using errcode = 'P0001';
      end;

      update public.did_team_deliberations
      set linked_live_session_id = plan_id, updated_at = now_ts
      where id = delib.id;
      bridge_mode := 'insert';
    end if;
  end if;

  select * into delib from public.did_team_deliberations where id = p_deliberation_id;

  return jsonb_build_object(
    'deliberation_id', delib.id,
    'deliberation_status', delib.status,
    'bridged_plan_id', plan_id,
    'bridge_mode', bridge_mode
  );
end;
$function$;
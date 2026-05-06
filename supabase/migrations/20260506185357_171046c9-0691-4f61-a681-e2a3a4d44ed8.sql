-- P29B.3-H8.3 runtime proof helper: trigger a force-full background cycle.
-- This is a tiny one-shot helper that synchronously creates a cycle row and
-- schedules the background orchestrator (same path the launcher uses).
CREATE OR REPLACE FUNCTION public.did_h8_3_trigger_force_full_proof()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
declare
  v_user uuid;
  v_cycle uuid;
  v_sched jsonb;
begin
  select id into v_user from auth.users
    where email = 'psychoterapie@hana-chlebcova.cz' limit 1;
  if v_user is null then raise exception 'canonical user not found'; end if;
  insert into did_update_cycles (user_id, cycle_type, status, phase, phase_step, started_at, heartbeat_at, last_heartbeat_at, context_data)
  values (v_user, 'daily', 'running', 'p29b3_h8_3_force_full_launcher_accepted', 'cycle_row_created', now(), now(), now(),
          jsonb_build_object('source','p29b3_h8_3_phase8a5_dedupe_proof','p29b_force_full_path',true,'p29b_force_full_launcher',true,'quiet_day_bypass_only',true,'bypassDispatchCheck',true))
  returning id into v_cycle;
  v_sched := public.did_schedule_daily_cycle_background(v_cycle, jsonb_build_object('source','p29b3_h8_3_phase8a5_dedupe_proof','bypassDispatchCheck',true));
  return jsonb_build_object('cycle_id', v_cycle, 'schedule', v_sched);
end;
$$;
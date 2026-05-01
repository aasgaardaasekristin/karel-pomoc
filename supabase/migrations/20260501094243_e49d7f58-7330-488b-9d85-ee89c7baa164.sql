DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sandbox_exec') THEN
    GRANT EXECUTE ON FUNCTION public.invoke_briefing_watchdog_acceptance_rebuild(uuid, text) TO sandbox_exec;
  END IF;
END;
$$;
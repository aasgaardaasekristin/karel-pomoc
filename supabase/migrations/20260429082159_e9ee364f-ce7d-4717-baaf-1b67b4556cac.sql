CREATE OR REPLACE FUNCTION public.verify_karel_cron_secret(p_secret text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, vault
AS $$
  SELECT COALESCE(NULLIF(p_secret, ''), '') <> ''
     AND EXISTS (
       SELECT 1
       FROM vault.decrypted_secrets
       WHERE name = 'KAREL_CRON_SECRET'
         AND decrypted_secret = p_secret
     );
$$;

REVOKE ALL ON FUNCTION public.verify_karel_cron_secret(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_karel_cron_secret(text) TO service_role;
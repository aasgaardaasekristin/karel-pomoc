CREATE TABLE IF NOT EXISTS public.did_part_registry_fix_1_5b_rollback AS
SELECT * FROM public.did_part_registry
WHERE created_at BETWEEN '2026-05-16 16:56:00'::timestamptz
                     AND '2026-05-16 16:56:30'::timestamptz
  AND source IS NULL
  AND created_by IS NULL;

ALTER TABLE public.did_part_registry_fix_1_5b_rollback ENABLE ROW LEVEL SECURITY;

CREATE POLICY "deny_all_authenticated" ON public.did_part_registry_fix_1_5b_rollback
  FOR ALL TO authenticated USING (false) WITH CHECK (false);
CREATE POLICY "deny_all_anon" ON public.did_part_registry_fix_1_5b_rollback
  FOR ALL TO anon USING (false) WITH CHECK (false);
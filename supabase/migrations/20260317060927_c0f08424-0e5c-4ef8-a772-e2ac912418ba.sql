CREATE TABLE public.did_countertransference_bonds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  therapist text NOT NULL,
  part_name text NOT NULL,
  bond_type text NOT NULL DEFAULT 'neutrální',
  bond_description text,
  therapeutic_implication text,
  intensity smallint NOT NULL DEFAULT 3,
  last_observed_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  user_id uuid DEFAULT auth.uid(),
  UNIQUE(therapist, part_name)
);

ALTER TABLE public.did_countertransference_bonds ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own bonds"
ON public.did_countertransference_bonds
FOR ALL
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);
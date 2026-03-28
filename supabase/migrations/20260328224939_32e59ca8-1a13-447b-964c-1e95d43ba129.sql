CREATE TABLE therapist_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author text NOT NULL DEFAULT 'hanka',
  part_name text,
  note_type text NOT NULL DEFAULT 'observation',
  note_text text NOT NULL,
  priority text DEFAULT 'normal',
  tags text[] DEFAULT '{}',
  is_read_by_karel boolean DEFAULT false,
  read_at timestamptz,
  incorporated_into text,
  session_date date DEFAULT CURRENT_DATE,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_therapist_notes_part ON therapist_notes(part_name, created_at DESC);
CREATE INDEX idx_therapist_notes_unread ON therapist_notes(is_read_by_karel) WHERE is_read_by_karel = false;

ALTER TABLE therapist_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_all_therapist_notes" ON therapist_notes FOR ALL TO authenticated USING (true) WITH CHECK (true);
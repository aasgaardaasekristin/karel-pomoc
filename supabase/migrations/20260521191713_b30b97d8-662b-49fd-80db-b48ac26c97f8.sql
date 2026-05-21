
-- decision_traces (sekce 4 FIX 9.K.1)
CREATE TABLE IF NOT EXISTS public.decision_traces (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  triggered_by    TEXT NOT NULL,
  snapshot_ref    JSONB NULL,
  evidence_refs   JSONB NULL,
  reasoning       TEXT NULL,
  outcome         TEXT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.decision_traces ENABLE ROW LEVEL SECURITY;

-- did_child_thread
CREATE TABLE IF NOT EXISTS public.did_child_thread (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  child_part_id               UUID NOT NULL REFERENCES public.did_part_registry(id) ON DELETE CASCADE,
  thread_date                 DATE NOT NULL,
  opened_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_active_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at                   TIMESTAMPTZ NULL,
  status                      TEXT NOT NULL DEFAULT 'open'
                                CHECK (status IN ('open','closed_rollover','closed_manual')),
  identification_method       TEXT NOT NULL
                                CHECK (identification_method IN ('explicit_name','style_match','manual_confirm')),
  identification_confidence   NUMERIC(3,2) NOT NULL,
  context_loaded_at           TIMESTAMPTZ NULL,
  summary_short               TEXT NULL,
  decision_trace_id           UUID NULL REFERENCES public.decision_traces(id),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT did_child_thread_unique_open_day UNIQUE (child_part_id, thread_date)
);
CREATE INDEX IF NOT EXISTS idx_did_child_thread_open
  ON public.did_child_thread(child_part_id, status) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_did_child_thread_date
  ON public.did_child_thread(thread_date);
CREATE INDEX IF NOT EXISTS idx_did_child_thread_active
  ON public.did_child_thread(last_active_at);
ALTER TABLE public.did_child_thread ENABLE ROW LEVEL SECURITY;

-- did_child_thread_message
CREATE TABLE IF NOT EXISTS public.did_child_thread_message (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id           UUID NOT NULL REFERENCES public.did_child_thread(id) ON DELETE CASCADE,
  sender              TEXT NOT NULL CHECK (sender IN ('child','karel','system')),
  content             TEXT NOT NULL,
  sent_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  content_tags        TEXT[] NULL,
  confidence          NUMERIC(3,2) NULL,
  triggered_research  BOOLEAN NOT NULL DEFAULT false,
  research_log_id     UUID NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_did_child_thread_message_thread
  ON public.did_child_thread_message(thread_id, sent_at);
ALTER TABLE public.did_child_thread_message ENABLE ROW LEVEL SECURITY;

-- updated_at trigger pro did_child_thread
CREATE OR REPLACE FUNCTION public.tg_did_child_thread_touch()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_did_child_thread_touch ON public.did_child_thread;
CREATE TRIGGER trg_did_child_thread_touch
  BEFORE UPDATE ON public.did_child_thread
  FOR EACH ROW EXECUTE FUNCTION public.tg_did_child_thread_touch();

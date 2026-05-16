CREATE TABLE IF NOT EXISTS public.system_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  note TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.system_config ENABLE ROW LEVEL SECURITY;

-- Deny-all: pouze service role smí číst/zapisovat (žádné policies = no access pro authenticated/anon).

INSERT INTO public.system_config (key, value, note)
VALUES (
  'drive_index_sync_enabled',
  'false',
  'FIX 1.5 (2026-05-16): paused after registry cleanup, pending Drive Google Sheets conversion'
)
ON CONFLICT (key) DO UPDATE SET value = 'false', note = EXCLUDED.note, updated_at = now();
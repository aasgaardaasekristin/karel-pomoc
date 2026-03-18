ALTER TABLE public.user_theme_preferences 
  ADD COLUMN IF NOT EXISTS font_color text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS font_family text NOT NULL DEFAULT 'default';
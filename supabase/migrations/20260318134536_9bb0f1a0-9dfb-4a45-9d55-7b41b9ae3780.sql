ALTER TABLE user_theme_preferences 
  ADD COLUMN IF NOT EXISTS border_radius text NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS chat_bubble_style text NOT NULL DEFAULT 'rounded',
  ADD COLUMN IF NOT EXISTS compact_mode boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS animations_enabled boolean NOT NULL DEFAULT true;
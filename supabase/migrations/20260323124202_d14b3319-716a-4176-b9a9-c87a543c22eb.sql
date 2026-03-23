ALTER TABLE user_theme_preferences 
  ADD COLUMN IF NOT EXISTS context_key TEXT NOT NULL DEFAULT 'global';

UPDATE user_theme_preferences SET context_key = persona WHERE context_key = 'global' AND persona != 'default';

ALTER TABLE user_theme_preferences 
  DROP CONSTRAINT IF EXISTS user_theme_preferences_user_id_persona_key;

ALTER TABLE user_theme_preferences
  ADD CONSTRAINT user_theme_preferences_user_context_key UNIQUE (user_id, context_key);
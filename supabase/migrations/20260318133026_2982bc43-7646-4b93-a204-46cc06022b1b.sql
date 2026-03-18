CREATE TABLE public.user_theme_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  persona text NOT NULL DEFAULT 'default',
  primary_color text NOT NULL DEFAULT '262 80% 50%',
  accent_color text NOT NULL DEFAULT '240 60% 60%',
  background_image_url text DEFAULT '',
  theme_preset text NOT NULL DEFAULT 'default',
  dark_mode boolean NOT NULL DEFAULT true,
  font_scale numeric NOT NULL DEFAULT 1.0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, persona)
);

ALTER TABLE public.user_theme_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own theme prefs" ON public.user_theme_preferences
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own theme prefs" ON public.user_theme_preferences
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own theme prefs" ON public.user_theme_preferences
  FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own theme prefs" ON public.user_theme_preferences
  FOR DELETE TO authenticated USING (auth.uid() = user_id);
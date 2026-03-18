import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";

interface ThemePrefs {
  persona: string;
  primary_color: string;
  accent_color: string;
  background_image_url: string;
  theme_preset: string;
  dark_mode: boolean;
  font_scale: number;
}

const PRESETS: Record<string, Partial<ThemePrefs>> = {
  default: { primary_color: "262 80% 50%", accent_color: "240 60% 60%" },
  ocean: { primary_color: "200 80% 45%", accent_color: "180 60% 50%" },
  forest: { primary_color: "140 60% 40%", accent_color: "160 50% 45%" },
  sunset: { primary_color: "25 90% 55%", accent_color: "350 70% 55%" },
  lavender: { primary_color: "270 60% 60%", accent_color: "290 50% 55%" },
  midnight: { primary_color: "230 50% 45%", accent_color: "260 40% 50%" },
  rose: { primary_color: "340 70% 55%", accent_color: "320 50% 50%" },
  mint: { primary_color: "165 60% 45%", accent_color: "150 50% 50%" },
};

const DEFAULT_PREFS: ThemePrefs = {
  persona: "default",
  primary_color: "262 80% 50%",
  accent_color: "240 60% 60%",
  background_image_url: "",
  theme_preset: "default",
  dark_mode: true,
  font_scale: 1.0,
};

interface ThemeContextValue {
  prefs: ThemePrefs;
  presets: typeof PRESETS;
  updatePrefs: (partial: Partial<ThemePrefs>) => Promise<void>;
  applyPreset: (presetName: string) => Promise<void>;
  uploadBackground: (file: File) => Promise<string>;
  currentPersona: string;
  setCurrentPersona: (p: string) => void;
  loading: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export const useTheme = () => {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be inside ThemeProvider");
  return ctx;
};

export const ThemeProvider = ({ children }: { children: ReactNode }) => {
  const [prefs, setPrefs] = useState<ThemePrefs>(DEFAULT_PREFS);
  const [currentPersona, setCurrentPersona] = useState("default");
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);

  // Load prefs for current persona
  const loadPrefs = useCallback(async (persona: string) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); return; }
    setUserId(user.id);

    const { data } = await supabase
      .from("user_theme_preferences" as any)
      .select("*")
      .eq("persona", persona)
      .maybeSingle();

    if (data) {
      setPrefs({
        persona: (data as any).persona,
        primary_color: (data as any).primary_color,
        accent_color: (data as any).accent_color,
        background_image_url: (data as any).background_image_url || "",
        theme_preset: (data as any).theme_preset,
        dark_mode: (data as any).dark_mode,
        font_scale: Number((data as any).font_scale),
      });
    } else {
      setPrefs({ ...DEFAULT_PREFS, persona });
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadPrefs(currentPersona);
  }, [currentPersona, loadPrefs]);

  // Apply CSS vars whenever prefs change
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--primary", prefs.primary_color);
    root.style.setProperty("--accent", prefs.accent_color);
    root.style.setProperty("--font-scale", String(prefs.font_scale));

    if (prefs.background_image_url) {
      root.style.setProperty("--bg-image", `url(${prefs.background_image_url})`);
      document.body.classList.add("has-bg-image");
    } else {
      root.style.removeProperty("--bg-image");
      document.body.classList.remove("has-bg-image");
    }

    if (prefs.dark_mode) {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
  }, [prefs]);

  const updatePrefs = useCallback(async (partial: Partial<ThemePrefs>) => {
    const next = { ...prefs, ...partial };
    setPrefs(next);

    if (!userId) return;

    const row = {
      user_id: userId,
      persona: next.persona,
      primary_color: next.primary_color,
      accent_color: next.accent_color,
      background_image_url: next.background_image_url,
      theme_preset: next.theme_preset,
      dark_mode: next.dark_mode,
      font_scale: next.font_scale,
      updated_at: new Date().toISOString(),
    };

    await supabase
      .from("user_theme_preferences" as any)
      .upsert(row, { onConflict: "user_id,persona" });
  }, [prefs, userId]);

  const applyPreset = useCallback(async (presetName: string) => {
    const preset = PRESETS[presetName];
    if (!preset) return;
    await updatePrefs({ ...preset, theme_preset: presetName });
  }, [updatePrefs]);

  const uploadBackground = useCallback(async (file: File): Promise<string> => {
    if (!userId) throw new Error("Not authenticated");
    const ext = file.name.split(".").pop() || "jpg";
    const path = `${userId}/${currentPersona}_bg_${Date.now()}.${ext}`;

    const { error } = await supabase.storage.from("theme-backgrounds").upload(path, file, { upsert: true });
    if (error) throw error;

    const { data } = supabase.storage.from("theme-backgrounds").getPublicUrl(path);
    return data.publicUrl;
  }, [userId, currentPersona]);

  return (
    <ThemeContext.Provider value={{ prefs, presets: PRESETS, updatePrefs, applyPreset, uploadBackground, currentPersona, setCurrentPersona, loading }}>
      {children}
    </ThemeContext.Provider>
  );
};

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
  default: { primary_color: "150 25% 35%", accent_color: "18 45% 65%" },
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
  primary_color: "150 25% 35%",
  accent_color: "18 45% 65%",
  background_image_url: "",
  theme_preset: "default",
  dark_mode: false,
  font_scale: 1.0,
};

/** Parse "H S% L%" into {h, s, l} numbers */
function parseHSL(hsl: string): { h: number; s: number; l: number } {
  const parts = hsl.replace(/%/g, "").split(/\s+/).map(Number);
  return { h: parts[0] || 0, s: parts[1] || 0, l: parts[2] || 50 };
}

/** Derive full set of CSS vars from primary + accent + dark_mode */
function deriveCSSVars(primary: string, accent: string, dark: boolean) {
  const p = parseHSL(primary);
  const a = parseHSL(accent);

  if (dark) {
    return {
      "--primary": primary,
      "--primary-foreground": `${p.h} ${Math.max(p.s - 20, 5)}% 10%`,
      "--accent": accent,
      "--accent-foreground": `${a.h} ${Math.max(a.s - 15, 10)}% 92%`,
      "--ring": primary,
      "--sidebar-primary": primary,
      "--sidebar-primary-foreground": `${p.h} ${Math.max(p.s - 20, 5)}% 10%`,
      "--sidebar-ring": primary,
      "--mode-debrief": `${p.h} ${Math.min(p.s + 5, 100)}% ${Math.min(p.l + 5, 60)}%`,
      "--mode-supervision": `${(p.h + 50) % 360} ${Math.min(p.s + 5, 100)}% ${Math.min(p.l + 5, 60)}%`,
      "--mode-safety": `${a.h} ${Math.min(a.s + 5, 100)}% ${Math.min(a.l, 55)}%`,
      "--chat-assistant": `${p.h} 15% 16%`,
    };
  } else {
    return {
      "--primary": primary,
      "--primary-foreground": `${p.h} ${Math.max(p.s - 20, 5)}% 98%`,
      "--accent": accent,
      "--accent-foreground": `${a.h} ${Math.max(a.s - 15, 10)}% 98%`,
      "--ring": primary,
      "--sidebar-primary": primary,
      "--sidebar-primary-foreground": `${p.h} ${Math.max(p.s - 20, 5)}% 98%`,
      "--sidebar-ring": primary,
      "--mode-debrief": `${p.h} ${Math.min(p.s + 5, 100)}% ${Math.max(p.l, 35)}%`,
      "--mode-supervision": `${(p.h + 50) % 360} ${Math.min(p.s + 5, 100)}% ${Math.max(p.l, 40)}%`,
      "--mode-safety": `${a.h} ${Math.min(a.s + 5, 100)}% ${Math.max(a.l, 50)}%`,
      "--chat-assistant": `${p.h} 20% 94%`,
    };
  }
}

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

  const loadPrefs = useCallback(async (persona: string) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); return; }
    setUserId(user.id);

    const { data } = await supabase
      .from("user_theme_preferences")
      .select("*")
      .eq("persona", persona)
      .maybeSingle();

    if (data) {
      setPrefs({
        persona: data.persona,
        primary_color: data.primary_color,
        accent_color: data.accent_color,
        background_image_url: data.background_image_url || "",
        theme_preset: data.theme_preset,
        dark_mode: data.dark_mode,
        font_scale: Number(data.font_scale),
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
    const vars = deriveCSSVars(prefs.primary_color, prefs.accent_color, prefs.dark_mode);

    Object.entries(vars).forEach(([key, val]) => {
      root.style.setProperty(key, val);
    });

    root.style.setProperty("--font-scale", String(prefs.font_scale));
    document.documentElement.style.fontSize = `${14 * prefs.font_scale}px`;

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
      .from("user_theme_preferences")
      .upsert(row as any, { onConflict: "user_id,persona" });
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

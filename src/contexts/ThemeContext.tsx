import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface ThemePrefs {
  persona: string;
  primary_color: string;
  accent_color: string;
  background_image_url: string;
  theme_preset: string;
  dark_mode: boolean;
  font_scale: number;
  border_radius: string;
  chat_bubble_style: string;
  compact_mode: boolean;
  animations_enabled: boolean;
}

const PRESETS: Record<string, Partial<ThemePrefs>> = {
  default: { primary_color: "154 24% 38%", accent_color: "20 42% 70%" },
  ocean: { primary_color: "192 36% 42%", accent_color: "184 28% 72%" },
  forest: { primary_color: "146 22% 34%", accent_color: "34 28% 72%" },
  sunset: { primary_color: "24 48% 52%", accent_color: "18 44% 74%" },
  lavender: { primary_color: "258 24% 54%", accent_color: "282 22% 78%" },
  midnight: { primary_color: "214 24% 34%", accent_color: "206 18% 68%" },
  rose: { primary_color: "344 30% 50%", accent_color: "18 34% 78%" },
  mint: { primary_color: "164 28% 40%", accent_color: "148 22% 76%" },
};

const DEFAULT_PREFS: ThemePrefs = {
  persona: "default",
  primary_color: "150 25% 35%",
  accent_color: "18 45% 65%",
  background_image_url: "",
  theme_preset: "default",
  dark_mode: false,
  font_scale: 1.0,
  border_radius: "normal",
  chat_bubble_style: "rounded",
  compact_mode: false,
  animations_enabled: true,
};

function parseHSL(hsl: string): { h: number; s: number; l: number } {
  const parts = hsl.replace(/%/g, "").split(/\s+/).map(Number);
  return { h: parts[0] || 0, s: parts[1] || 0, l: parts[2] || 50 };
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const shift = (hsl: string, overrides: Partial<{ h: number; s: number; l: number }>) => {
  const current = parseHSL(hsl);
  return `${((overrides.h ?? current.h) + 360) % 360} ${clamp(overrides.s ?? current.s, 0, 100)}% ${clamp(overrides.l ?? current.l, 0, 100)}%`;
};

export function hexToHSL(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }

  return `${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

export function hslToHex(hsl: string): string {
  const { h, s, l } = parseHSL(hsl);
  const sn = s / 100;
  const ln = l / 100;
  const a = sn * Math.min(ln, 1 - ln);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = ln - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

const RADIUS_MAP: Record<string, string> = {
  sharp: "0.25rem",
  normal: "0.75rem",
  round: "1.25rem",
  pill: "9999px",
};

function deriveCSSVars(primary: string, accent: string, dark: boolean) {
  const p = parseHSL(primary);
  const a = parseHSL(accent);

  if (dark) {
    return {
      "--background": shift(primary, { s: 12, l: 10 }),
      "--foreground": shift(primary, { s: 18, l: 92 }),
      "--card": shift(primary, { s: 14, l: 13 }),
      "--card-foreground": shift(primary, { s: 18, l: 92 }),
      "--popover": shift(primary, { s: 14, l: 13 }),
      "--popover-foreground": shift(primary, { s: 18, l: 92 }),
      "--secondary": shift(primary, { s: 12, l: 18 }),
      "--secondary-foreground": shift(primary, { s: 18, l: 92 }),
      "--muted": shift(primary, { s: 10, l: 18 }),
      "--muted-foreground": shift(primary, { s: 12, l: 66 }),
      "--border": shift(primary, { s: 12, l: 24 }),
      "--input": shift(primary, { s: 12, l: 24 }),
      "--primary": primary,
      "--primary-foreground": `${p.h} ${clamp(p.s - 20, 5, 100)}% 10%`,
      "--accent": accent,
      "--accent-foreground": `${a.h} ${clamp(a.s - 15, 10, 100)}% 92%`,
      "--ring": primary,
      "--chat-user": shift(primary, { s: 10, l: 18 }),
      "--chat-assistant": shift(primary, { s: 18, l: 16 }),
      "--chat-border": shift(primary, { s: 12, l: 25 }),
      "--mode-debrief": shift(primary, { s: clamp(p.s + 5, 0, 100), l: clamp(p.l + 5, 0, 60) }),
      "--mode-supervision": `${(p.h + 50) % 360} ${clamp(p.s + 5, 0, 100)}% ${clamp(p.l + 5, 0, 60)}%`,
      "--mode-safety": `${a.h} ${clamp(a.s + 5, 0, 100)}% ${clamp(a.l, 0, 55)}%`,
      "--sidebar-background": shift(primary, { s: 14, l: 8 }),
      "--sidebar-foreground": shift(primary, { s: 16, l: 90 }),
      "--sidebar-primary": primary,
      "--sidebar-primary-foreground": `${p.h} ${clamp(p.s - 20, 5, 100)}% 10%`,
      "--sidebar-accent": shift(primary, { s: 12, l: 15 }),
      "--sidebar-accent-foreground": shift(primary, { s: 16, l: 90 }),
      "--sidebar-border": shift(primary, { s: 12, l: 20 }),
      "--sidebar-ring": primary,
    };
  }

  return {
    "--background": shift(primary, { s: 25, l: 98 }),
    "--foreground": shift(primary, { s: 12, l: 18 }),
    "--card": shift(primary, { s: 22, l: 96 }),
    "--card-foreground": shift(primary, { s: 12, l: 18 }),
    "--popover": shift(primary, { s: 22, l: 96 }),
    "--popover-foreground": shift(primary, { s: 12, l: 18 }),
    "--secondary": shift(accent, { s: Math.max(a.s - 18, 18), l: 92 }),
    "--secondary-foreground": shift(primary, { s: 12, l: 24 }),
    "--muted": shift(primary, { s: 18, l: 94 }),
    "--muted-foreground": shift(primary, { s: 10, l: 42 }),
    "--border": shift(primary, { s: 18, l: 86 }),
    "--input": shift(primary, { s: 18, l: 86 }),
    "--primary": primary,
    "--primary-foreground": `${p.h} ${clamp(p.s - 20, 5, 100)}% 98%`,
    "--accent": accent,
    "--accent-foreground": `${a.h} ${clamp(a.s - 15, 10, 100)}% 98%`,
    "--ring": primary,
    "--chat-user": shift(accent, { s: Math.max(a.s - 20, 18), l: 93 }),
    "--chat-assistant": shift(primary, { s: 20, l: 93 }),
    "--chat-border": shift(primary, { s: 14, l: 84 }),
    "--mode-debrief": `${p.h} ${clamp(p.s + 5, 0, 100)}% ${Math.max(p.l, 35)}%`,
    "--mode-supervision": `${(p.h + 50) % 360} ${clamp(p.s + 5, 0, 100)}% ${Math.max(p.l, 40)}%`,
    "--mode-safety": `${a.h} ${clamp(a.s + 5, 0, 100)}% ${Math.max(a.l, 50)}%`,
    "--sidebar-background": shift(primary, { s: 20, l: 95 }),
    "--sidebar-foreground": shift(primary, { s: 12, l: 24 }),
    "--sidebar-primary": primary,
    "--sidebar-primary-foreground": `${p.h} ${clamp(p.s - 20, 5, 100)}% 98%`,
    "--sidebar-accent": shift(accent, { s: Math.max(a.s - 18, 18), l: 90 }),
    "--sidebar-accent-foreground": shift(primary, { s: 12, l: 24 }),
    "--sidebar-border": shift(primary, { s: 18, l: 86 }),
    "--sidebar-ring": primary,
  };
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
    if (!user) {
      setLoading(false);
      return;
    }

    setUserId(user.id);

    const { data } = await supabase
      .from("user_theme_preferences")
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
        border_radius: (data as any).border_radius || "normal",
        chat_bubble_style: (data as any).chat_bubble_style || "rounded",
        compact_mode: (data as any).compact_mode ?? false,
        animations_enabled: (data as any).animations_enabled ?? true,
      });
    } else {
      setPrefs({ ...DEFAULT_PREFS, persona });
    }

    setLoading(false);
  }, []);

  useEffect(() => {
    void loadPrefs(currentPersona);
  }, [currentPersona, loadPrefs]);

  useEffect(() => {
    const root = document.documentElement;
    const vars = deriveCSSVars(prefs.primary_color, prefs.accent_color, prefs.dark_mode);

    Object.entries(vars).forEach(([key, value]) => {
      root.style.setProperty(key, value);
    });

    root.style.setProperty("--font-scale", String(prefs.font_scale));
    root.style.fontSize = `${14 * prefs.font_scale}px`;
    root.style.setProperty("--radius", RADIUS_MAP[prefs.border_radius] || "0.75rem");

    if (prefs.compact_mode) root.classList.add("compact");
    else root.classList.remove("compact");

    if (prefs.animations_enabled) root.classList.remove("no-animations");
    else root.classList.add("no-animations");

    document.body.classList.remove("chat-bubble-square", "chat-bubble-minimal");
    if (prefs.chat_bubble_style === "square") document.body.classList.add("chat-bubble-square");
    else if (prefs.chat_bubble_style === "minimal") document.body.classList.add("chat-bubble-minimal");

    if (prefs.background_image_url) {
      root.style.setProperty("--bg-image", `url(${prefs.background_image_url})`);
      document.body.classList.add("has-bg-image");
    } else {
      root.style.removeProperty("--bg-image");
      document.body.classList.remove("has-bg-image");
    }

    if (prefs.dark_mode) root.classList.add("dark");
    else root.classList.remove("dark");
  }, [prefs]);

  const updatePrefs = useCallback(async (partial: Partial<ThemePrefs>) => {
    const next = { ...prefs, ...partial };
    setPrefs(next);

    if (!userId) return;

    await supabase
      .from("user_theme_preferences")
      .upsert({
        user_id: userId,
        persona: next.persona,
        primary_color: next.primary_color,
        accent_color: next.accent_color,
        background_image_url: next.background_image_url,
        theme_preset: next.theme_preset,
        dark_mode: next.dark_mode,
        font_scale: next.font_scale,
        border_radius: next.border_radius,
        chat_bubble_style: next.chat_bubble_style,
        compact_mode: next.compact_mode,
        animations_enabled: next.animations_enabled,
        updated_at: new Date().toISOString(),
      } as any, { onConflict: "user_id,persona" });
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

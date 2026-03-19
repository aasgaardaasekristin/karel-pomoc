import { createContext, useContext, useEffect, useState, useCallback, useRef, type ReactNode } from "react";
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
  font_color: string;
  font_family: string;
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
  // Therapeutic presets
  sand: { primary_color: "32 22% 48%", accent_color: "38 26% 72%" },
  stone: { primary_color: "200 12% 42%", accent_color: "180 10% 68%" },
  dawn: { primary_color: "340 18% 52%", accent_color: "24 28% 74%" },
  moss: { primary_color: "136 18% 36%", accent_color: "88 14% 66%" },
  cloud: { primary_color: "210 18% 56%", accent_color: "220 14% 78%" },
  earth: { primary_color: "22 26% 42%", accent_color: "34 20% 68%" },
  // Kids presets (auto-applied per-thread)
  ocean_explorer: { primary_color: "200 38% 42%", accent_color: "190 30% 68%" },
  forest_ranger: { primary_color: "142 28% 36%", accent_color: "88 22% 62%" },
  space: { primary_color: "230 30% 32%", accent_color: "260 24% 58%" },
  dragon: { primary_color: "14 36% 42%", accent_color: "32 34% 64%" },
  ninja: { primary_color: "220 18% 28%", accent_color: "340 22% 52%" },
  minecraft: { primary_color: "120 32% 38%", accent_color: "36 30% 56%" },
  robot: { primary_color: "210 22% 46%", accent_color: "180 20% 62%" },
  pirate: { primary_color: "28 38% 38%", accent_color: "45 32% 64%" },
  dino: { primary_color: "160 28% 40%", accent_color: "130 22% 66%" },
  thunder: { primary_color: "48 40% 44%", accent_color: "210 28% 52%" },
  fairy: { primary_color: "300 24% 52%", accent_color: "330 28% 74%" },
  rainbow: { primary_color: "280 26% 48%", accent_color: "340 30% 70%" },
  butterfly: { primary_color: "270 22% 50%", accent_color: "200 26% 68%" },
  flower: { primary_color: "340 28% 54%", accent_color: "20 34% 74%" },
  sunset_beach: { primary_color: "24 42% 48%", accent_color: "40 36% 70%" },
  ice: { primary_color: "200 26% 52%", accent_color: "186 20% 74%" },
};

const DEFAULT_PREFS: ThemePrefs = {
  persona: "default",
  primary_color: "154 24% 38%",
  accent_color: "20 42% 70%",
  background_image_url: "",
  theme_preset: "default",
  dark_mode: false,
  font_scale: 1.0,
  border_radius: "normal",
  chat_bubble_style: "rounded",
  compact_mode: false,
  animations_enabled: true,
  font_color: "",
  font_family: "default",
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
      "--background": shift(primary, { s: Math.max(8, p.s * 0.35), l: 11 }),
      "--foreground": shift(primary, { s: 14, l: 92 }),
      "--card": shift(primary, { s: Math.max(8, p.s * 0.42), l: 13 }),
      "--card-foreground": shift(primary, { s: 14, l: 92 }),
      "--popover": shift(primary, { s: Math.max(8, p.s * 0.42), l: 13 }),
      "--popover-foreground": shift(primary, { s: 14, l: 92 }),
      "--secondary": shift(accent, { s: Math.max(8, a.s * 0.22), l: 18 }),
      "--secondary-foreground": shift(primary, { s: 12, l: 92 }),
      "--muted": shift(primary, { s: Math.max(7, p.s * 0.28), l: 18 }),
      "--muted-foreground": shift(primary, { s: 10, l: 66 }),
      "--border": shift(primary, { s: Math.max(8, p.s * 0.3), l: 24 }),
      "--input": shift(primary, { s: Math.max(8, p.s * 0.3), l: 24 }),
      "--primary": shift(primary, { s: clamp(p.s * 0.8, 16, 42), l: clamp(p.l + 12, 46, 60) }),
      "--primary-foreground": `${p.h} 16% 10%`,
      "--accent": shift(accent, { s: clamp(a.s * 0.62, 18, 44), l: clamp(a.l + 4, 54, 68) }),
      "--accent-foreground": `${a.h} 18% 94%`,
      "--ring": shift(primary, { s: clamp(p.s * 0.8, 16, 42), l: clamp(p.l + 12, 46, 60) }),
      "--chat-user": shift(accent, { s: Math.max(10, a.s * 0.18), l: 18 }),
      "--chat-assistant": shift(primary, { s: Math.max(10, p.s * 0.22), l: 16 }),
      "--chat-border": shift(primary, { s: Math.max(8, p.s * 0.28), l: 25 }),
      "--mode-debrief": shift(primary, { s: clamp(p.s * 0.82, 18, 44), l: clamp(p.l + 8, 44, 58) }),
      "--mode-supervision": `${(p.h + 34) % 360} ${clamp(p.s * 0.58, 16, 40)}% ${clamp(p.l + 10, 46, 60)}%`,
      "--mode-safety": `${a.h} ${clamp(a.s * 0.62, 18, 46)}% ${clamp(a.l + 2, 50, 62)}%`,
      "--sidebar-background": shift(primary, { s: Math.max(8, p.s * 0.3), l: 9 }),
      "--sidebar-foreground": shift(primary, { s: 12, l: 90 }),
      "--sidebar-primary": shift(primary, { s: clamp(p.s * 0.8, 16, 42), l: clamp(p.l + 12, 46, 60) }),
      "--sidebar-primary-foreground": `${p.h} 16% 10%`,
      "--sidebar-accent": shift(accent, { s: Math.max(8, a.s * 0.16), l: 16 }),
      "--sidebar-accent-foreground": shift(primary, { s: 12, l: 90 }),
      "--sidebar-border": shift(primary, { s: Math.max(8, p.s * 0.28), l: 20 }),
      "--sidebar-ring": shift(primary, { s: clamp(p.s * 0.8, 16, 42), l: clamp(p.l + 12, 46, 60) }),
      "--theme-surface": shift(primary, { s: Math.max(8, p.s * 0.22), l: 12 }),
      "--theme-soft": shift(primary, { s: Math.max(8, p.s * 0.2), l: 16 }),
      "--theme-glow": shift(primary, { s: clamp(p.s * 0.5, 12, 32), l: 24 }),
      "--theme-glow-strong": shift(accent, { s: clamp(a.s * 0.36, 12, 30), l: 22 }),
      "--theme-noise-opacity": "0.04",
    };
  }

  return {
    "--background": shift(primary, { s: Math.max(10, p.s * 0.24), l: 92 }),
    "--foreground": shift(primary, { s: 10, l: 20 }),
    "--card": shift(primary, { s: Math.max(10, p.s * 0.2), l: 89 }),
    "--card-foreground": shift(primary, { s: 10, l: 20 }),
    "--popover": shift(primary, { s: Math.max(10, p.s * 0.2), l: 90 }),
    "--popover-foreground": shift(primary, { s: 10, l: 20 }),
    "--secondary": shift(accent, { s: Math.max(12, a.s * 0.24), l: 85 }),
    "--secondary-foreground": shift(primary, { s: 10, l: 24 }),
    "--muted": shift(primary, { s: Math.max(10, p.s * 0.18), l: 87 }),
    "--muted-foreground": shift(primary, { s: 8, l: 40 }),
    "--border": shift(primary, { s: Math.max(10, p.s * 0.18), l: 78 }),
    "--input": shift(primary, { s: Math.max(10, p.s * 0.18), l: 78 }),
    "--primary": shift(primary, { s: clamp(p.s * 0.78, 16, 40), l: clamp(p.l, 34, 46) }),
    "--primary-foreground": `${p.h} 18% 98%`,
    "--accent": shift(accent, { s: clamp(a.s * 0.55, 18, 42), l: clamp(a.l + 4, 60, 74) }),
    "--accent-foreground": `${a.h} 18% 22%`,
    "--ring": shift(primary, { s: clamp(p.s * 0.78, 16, 40), l: clamp(p.l, 34, 46) }),
    "--chat-user": shift(accent, { s: Math.max(12, a.s * 0.2), l: 84 }),
    "--chat-assistant": shift(primary, { s: Math.max(12, p.s * 0.24), l: 86 }),
    "--chat-border": shift(primary, { s: Math.max(10, p.s * 0.18), l: 76 }),
    "--mode-debrief": shift(primary, { s: clamp(p.s * 0.82, 18, 44), l: clamp(p.l + 2, 36, 48) }),
    "--mode-supervision": `${(p.h + 34) % 360} ${clamp(p.s * 0.52, 16, 36)}% ${clamp(p.l + 8, 42, 56)}%`,
    "--mode-safety": `${a.h} ${clamp(a.s * 0.5, 18, 38)}% ${clamp(a.l, 56, 70)}%`,
    "--sidebar-background": shift(primary, { s: Math.max(10, p.s * 0.18), l: 88 }),
    "--sidebar-foreground": shift(primary, { s: 10, l: 24 }),
    "--sidebar-primary": shift(primary, { s: clamp(p.s * 0.78, 16, 40), l: clamp(p.l, 34, 46) }),
    "--sidebar-primary-foreground": `${p.h} 18% 98%`,
    "--sidebar-accent": shift(accent, { s: Math.max(12, a.s * 0.2), l: 83 }),
    "--sidebar-accent-foreground": shift(primary, { s: 10, l: 24 }),
    "--sidebar-border": shift(primary, { s: Math.max(10, p.s * 0.18), l: 78 }),
    "--sidebar-ring": shift(primary, { s: clamp(p.s * 0.78, 16, 40), l: clamp(p.l, 34, 46) }),
    "--theme-surface": shift(primary, { s: Math.max(10, p.s * 0.18), l: 90 }),
    "--theme-soft": shift(primary, { s: Math.max(10, p.s * 0.2), l: 84 }),
    "--theme-glow": shift(primary, { s: clamp(p.s * 0.42, 14, 34), l: 76 }),
    "--theme-glow-strong": shift(accent, { s: clamp(a.s * 0.36, 14, 32), l: 80 }),
    "--theme-noise-opacity": "0.05",
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
  applyTemporaryTheme: (config: Partial<ThemePrefs>) => void;
  restoreGlobalTheme: () => void;
  getPersonaPrefs: (persona: string) => Promise<ThemePrefs>;
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
  const savedPrefsRef = useRef<ThemePrefs | null>(null);

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
        font_color: (data as any).font_color || "",
        font_family: (data as any).font_family || "default",
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

    // Custom font color
    if (prefs.font_color) {
      root.style.setProperty("--foreground", prefs.font_color);
      root.style.setProperty("--card-foreground", prefs.font_color);
    }

    // Font family
    const FONT_MAP: Record<string, string> = {
      default: "'DM Sans', system-ui, sans-serif",
      comic: "'Comic Neue', 'Comic Sans MS', cursive",
      rounded: "'Nunito', 'Varela Round', sans-serif",
      mono: "'JetBrains Mono', 'Fira Code', monospace",
    };
    const fontFamily = FONT_MAP[prefs.font_family] || FONT_MAP.default;
    root.style.setProperty("--font-body", fontFamily);
    root.style.fontFamily = fontFamily;

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
        font_color: next.font_color,
        font_family: next.font_family,
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

  const applyTemporaryTheme = useCallback((config: Partial<ThemePrefs>) => {
    // Only save the global prefs if we're not already in temporary mode
    if (!savedPrefsRef.current) {
      savedPrefsRef.current = prefs;
    }
    setPrefs((prev) => ({ ...prev, ...config }));
  }, [prefs]);

  const restoreGlobalTheme = useCallback(() => {
    if (savedPrefsRef.current) {
      setPrefs(savedPrefsRef.current);
      savedPrefsRef.current = null;
    }
  }, []);

  return (
    <ThemeContext.Provider value={{ prefs, presets: PRESETS, updatePrefs, applyPreset, uploadBackground, currentPersona, setCurrentPersona, loading, applyTemporaryTheme, restoreGlobalTheme }}>
      {children}
    </ThemeContext.Provider>
  );
};

import type { Config } from "tailwindcss";

export default {
  darkMode: ["class"],
  content: ["./pages/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./app/**/*.{ts,tsx}", "./src/**/*.{ts,tsx}"],
  prefix: "",
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        chat: {
          user: "hsl(var(--chat-user))",
          assistant: "hsl(var(--chat-assistant))",
          border: "hsl(var(--chat-border))",
        },
        mode: {
          debrief: "hsl(var(--mode-debrief))",
          supervision: "hsl(var(--mode-supervision))",
          safety: "hsl(var(--mode-safety))",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar-background))",
          foreground: "hsl(var(--sidebar-foreground))",
          primary: "hsl(var(--sidebar-primary))",
          "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
          ring: "hsl(var(--sidebar-ring))",
        },
      },
      fontFamily: {
        sans: ['"Inter Variable"', 'Inter', 'system-ui', 'sans-serif'],
        serif: ['Crimson Pro', 'Georgia', 'serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      fontSize: {
        xs: ['0.694rem', { lineHeight: '1.4' }],
        sm: ['0.833rem', { lineHeight: '1.5' }],
        base: ['1rem', { lineHeight: '1.6' }],
        lg: ['1.2rem', { lineHeight: '1.5' }],
        xl: ['1.44rem', { lineHeight: '1.4' }],
        '2xl': ['1.728rem', { lineHeight: '1.3' }],
        '3xl': ['2.074rem', { lineHeight: '1.2' }],
        '4xl': ['2.488rem', { lineHeight: '1.1' }],
      },
      borderRadius: {
        sm: "0.375rem",
        md: "0.625rem",
        lg: "0.875rem",
        xl: "1.25rem",
        "2xl": "1.5rem",
      },
      boxShadow: {
        subtle: "0 1px 2px 0 hsl(0 0% 0% / 0.04)",
        soft: "0 2px 8px -2px hsl(0 0% 0% / 0.08)",
        medium: "0 4px 16px -4px hsl(0 0% 0% / 0.12)",
        lifted: "0 8px 30px -8px hsl(0 0% 0% / 0.16)",
        overlay: "0 16px 48px -12px hsl(0 0% 0% / 0.24)",
        "glow-sm": "0 0 8px 0 hsl(var(--primary) / 0.2)",
        "glow-md": "0 0 20px 0 hsl(var(--primary) / 0.3)",
        "inner-soft": "inset 0 1px 4px 0 hsl(0 0% 0% / 0.06)",
      },
      zIndex: {
        dropdown: "50",
        sticky: "100",
        overlay: "200",
        modal: "300",
        popover: "400",
        toast: "500",
        tooltip: "600",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "fade-in": {
          from: { opacity: "0", transform: "translateY(6px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "fade-out": {
          from: { opacity: "1", transform: "translateY(0)" },
          to: { opacity: "0", transform: "translateY(6px)" },
        },
        "slide-in-right": {
          from: { opacity: "0", transform: "translateX(12px)" },
          to: { opacity: "1", transform: "translateX(0)" },
        },
        "slide-in-left": {
          from: { opacity: "0", transform: "translateX(-12px)" },
          to: { opacity: "1", transform: "translateX(0)" },
        },
        "scale-in": {
          from: { opacity: "0", transform: "scale(0.95)" },
          to: { opacity: "1", transform: "scale(1)" },
        },
        "pulse-soft": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.7" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        breathe: {
          "0%, 100%": { transform: "scale(1)" },
          "50%": { transform: "scale(1.03)" },
        },
        shake: {
          "0%, 100%": { transform: "translateX(0)" },
          "20%, 60%": { transform: "translateX(-4px)" },
          "40%, 80%": { transform: "translateX(4px)" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "fade-in": "fade-in 0.3s ease-out",
        "fade-out": "fade-out 0.3s ease-out",
        "slide-in-right": "slide-in-right 0.3s ease-out",
        "slide-in-left": "slide-in-left 0.3s ease-out",
        "scale-in": "scale-in 0.2s ease-out",
        "pulse-soft": "pulse-soft 2s ease-in-out infinite",
        shimmer: "shimmer 2s linear infinite",
        breathe: "breathe 3s ease-in-out infinite",
        shake: "shake 0.4s ease-in-out",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
} satisfies Config;



# Oprava: Audio analýza v živé asistenci — přehledný, bold výstup

## Problém

Když terapeut pošle audio nahrávku v režimu Asistence, `karel-audio-analysis` nemá prompt pro mode `"live-session"` — spadne na fallback `debrief`, který generuje dlouhý akademický text bez zvýraznění. Terapeut potřebuje okamžitě vidět **co říct klientovi** (bold), ne číst 3 odstavce analýzy.

## Řešení

### 1. `karel-audio-analysis/index.ts` — nový `live-session` prompt

Přidat do `MODE_PROMPTS` klíč `"live-session"` s kompaktním promptem:
- Formát: **Co říct klientovi** (bold, 1-2 věty) → Stručný postřeh z hlasu (2-3 body) → Další krok
- Max 150 slov, žádné akademické rozbory
- Terapeuta oslovovat "Hani"
- Vše bold co je akční instrukce

### 2. Žádné změny v LiveSessionPanel

Klient už posílá `mode: "live-session"` (řádek 324) — stačí přidat odpovídající prompt na straně edge funkce.

## Soubory
- `supabase/functions/karel-audio-analysis/index.ts` — přidat `"live-session"` prompt do `MODE_PROMPTS`


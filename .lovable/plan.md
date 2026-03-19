

# Plán: Interaktivní personalizace vláken v DID-Kluci + Psychologická profilace částí

## Přehled

Tři propojené oblasti:
1. **Vylepšený editor vzhledu** s dětskými/hravými prvky a per-thread pamětí
2. **Zjednodušení „Nové vlákno"** – pouze textový vstup jména + inteligentní detekce části z Excel registru
3. **Psychologická profilace částí** – nová DB tabulka, tiché mapování preferencí, denní aktualizace, aktivní využití v komunikaci

---

## 1. Vylepšený editor vzhledu pro Kluci

### Co se změní v `DidKidsThemeEditor.tsx`:
- Přidání **vizuálně hravých prvků**: animovaný preview (live ukázka chatové bubliny v zvolených barvách), emoji reakce při výběru motivu, „tajný" motiv odemknutelný po X návštěvách
- Rozšíření motivů o **interaktivní varianty**: každý motiv bude mít krátkou animaci/efekt při výběru (třes, záblesk, pulsace)
- Přidání sekce **„Vyzkoušej si to"**: malý sandbox s fiktivní chatovou bublinou kde část vidí jak vypadá její text v reálném čase
- **Emoji picker pro vlákno**: část si může vybrat vlastní emoji jako „avatar" vlákna (ukládá se do `did_threads`)
- Rozšíření barev: přidání **gradient editoru** (dva color pickery = lineární gradient pozadí chatu)

### Per-thread paměť vzhledu:
- Sloupec `theme_preset` na `did_threads` již existuje – rozšířit o nový sloupec `theme_config` (jsonb) pro kompletní nastavení (barvy, font, dark mode, emoji, gradient)
- Při otevření vlákna: načíst `theme_config` z DB a dočasně aplikovat na CSS root (přepsat globální téma)
- Při zavření/přepnutí vlákna: obnovit globální téma z `user_theme_preferences`
- **Explicitní upozornění** v editoru: „Tento vzhled platí jen pro toto vlákno"
- Nová migrace: `ALTER TABLE did_threads ADD COLUMN theme_config jsonb DEFAULT '{}'::jsonb, ADD COLUMN thread_emoji text DEFAULT '';`

### Soubory k úpravě:
- `src/components/did/DidKidsThemeEditor.tsx` – kompletní redesign s hravými prvky
- `src/pages/Chat.tsx` – při `handleSelectThread` aplikovat thread theme, při odchodu obnovit
- `src/hooks/useDidThreads.ts` – rozšířit `DidThread` interface o `themeConfig`, `threadEmoji`
- `src/contexts/ThemeContext.tsx` – přidat `applyTemporaryTheme(config)` a `restoreGlobalTheme()`

---

## 2. Zjednodušení „Nové vlákno" + inteligentní detekce části

### Co se změní v `DidPartIdentifier.tsx`:
- **Odstranit** seznam předvoleb aktivních částí (tlačítka se jmény)
- Nechat **pouze vstupní pole**: „Napiš jméno: Jak ti říkají?"
- Po odeslání jména spustit **fuzzy detekci** proti Excel registru na Drive

### Detekční flow:
1. Uživatel napíše jméno (např. „Artík")
2. Frontend zavolá novou edge funkci `karel-did-part-detect`
3. Funkce:
   - Načte Excel registr z Drive (kartoteka_DID/00_CENTRUM)
   - Projde sloupec se jmény + aliasy
   - Fuzzy matching: strip diacritics, lowercase, substring match (arthur = artur = artík)
   - Vrátí: `{ matched: true, partName: "003_ARTHUR", displayName: "Arthur", cardContent?: string }`
4. Pokud shoda nalezena → automaticky načte kartu části + osobnostní profil do context cache
5. Pokud shoda nenalezena → nabídne vytvořit novou část v registru

### Tiché mapování preferencí vzhledu:
- Při každé změně theme v threadu: uložit záznam do nové tabulky `did_part_theme_preferences`:
  ```
  part_name, theme_preset, theme_config, chosen_at, thread_id
  ```
- Karel v denním cyklu analyzuje preference (jaké barvy, motivy, fonty si část volí) a zapíše do psychologického profilu

### Soubory k vytvoření/úpravě:
- `supabase/functions/karel-did-part-detect/index.ts` – nová edge funkce
- `src/components/did/DidPartIdentifier.tsx` – zjednodušení na pouhý input
- Nová migrace: `CREATE TABLE did_part_theme_preferences (...)`

---

## 3. Psychologická profilace částí

### Nová tabulka `did_part_profiles`:
```sql
CREATE TABLE did_part_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  part_name text NOT NULL,
  -- Jádro profilu
  personality_traits jsonb DEFAULT '[]',      -- Big Five, temperament
  cognitive_profile jsonb DEFAULT '{}',       -- inteligence, učební styl
  emotional_profile jsonb DEFAULT '{}',       -- emoční inteligence, regulace
  needs jsonb DEFAULT '[]',                   -- potřeby (bezpečí, uznání...)
  motivations jsonb DEFAULT '[]',             -- motivační faktory
  strengths jsonb DEFAULT '[]',               -- silné stránky
  challenges jsonb DEFAULT '[]',              -- výzvy, slabiny
  interests jsonb DEFAULT '[]',               -- zájmy, preference
  communication_style jsonb DEFAULT '{}',     -- jak komunikuje, jak reaguje
  therapeutic_approach jsonb DEFAULT '{}',     -- doporučený přístup
  theme_preferences jsonb DEFAULT '{}',       -- analýza vizuálních preferencí
  -- Meta
  confidence_score numeric DEFAULT 0.3,       -- jak moc je profil spolehlivý
  evidence_sources jsonb DEFAULT '[]',        -- odkud informace pochází
  last_enriched_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(user_id, part_name)
);
```

### Denní aktualizace profilu (`karel-did-daily-cycle`):
- Nová sekce v denním cyklu: **„Profilační analýza"**
- Karel projde:
  - Nové konverzace s částí (did_threads, did_conversations)
  - Konverzace terapeutů O části (sub_mode mamka/kata kde se část zmiňuje)
  - Theme preference záznamy
  - Existující kartu části na Drive
- AI (Gemini Flash) extrahuje nové psychologické poznatky a merguje s existujícím profilem
- Výsledek zapíše do `did_part_profiles` (upsert) a do sekce karty části na Drive

### Aktivní využití profilu:
- **`karel-did-context-prime`**: při priming cache načíst i `did_part_profiles` → Karel má okamžitě k dispozici osobnostní profil
- **`karel-chat` (DID režim)**: systémový prompt obohacen o profil části → Karel přizpůsobí komunikační styl, nabízí aktivity na míru, motivuje adekvátně
- **`karel-did-session-prep`**: příprava sezení zohledňuje osobnostní profil → doporučené metody, témata, přístup
- **`karel-did-system-overview`**: úkoly generované s ohledem na profil části

### Soubory k úpravě:
- Nová migrace pro `did_part_profiles` + `did_part_theme_preferences`
- `supabase/functions/karel-did-daily-cycle/index.ts` – přidat profilační sekci
- `supabase/functions/karel-did-context-prime/index.ts` – načítat profil
- `supabase/functions/karel-chat/systemPrompts.ts` – vkládat profil do system promptu
- `supabase/functions/karel-did-session-prep/index.ts` – využít profil
- `supabase/functions/karel-did-part-detect/index.ts` – nová funkce

---

## 4. Návrhy na vylepšení oproti zadání

1. **Gamifikace editoru**: místo pouhého výběru barev přidat „achievement" systém – část odemyká nové motivy podle počtu konverzací (motivace k používání)
2. **Profilace jako živý dokument**: namísto statického zápisu do karty na Drive vytvořit dedikovaný dokument `XX_OSOBNOSTNI_PROFIL` v kartě části, který se denně přepisuje kompletně (vždy aktuální snapshot)
3. **Detekce části přes DB místo jen Excel**: Primárně hledat v `did_part_registry` (DB), teprve pokud nenajde → fallback na Excel. DB je rychlejší a spolehlivější. Excel slouží jako sekundární zdroj pro aliasy.
4. **Vizuální „nálada" vlákna**: Karel automaticky navrhne motiv na základě emočního stavu části (detekovaného z konverzace) – např. klidný = ocean, energický = thunder

---

## Technický souhrn

| Oblast | Nové soubory | Upravené soubory | Migrace |
|--------|-------------|------------------|---------|
| Theme editor | — | DidKidsThemeEditor, Chat.tsx, ThemeContext, useDidThreads | did_threads + theme_config |
| Nové vlákno | karel-did-part-detect | DidPartIdentifier | did_part_theme_preferences |
| Profilace | — | daily-cycle, context-prime, systemPrompts, session-prep | did_part_profiles |

Celkem: 1 nová edge funkce, 2 nové tabulky, ~8 upravených souborů.


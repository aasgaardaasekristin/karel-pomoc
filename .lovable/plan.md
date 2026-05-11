# P33.6 — Visible Daily Briefing Semantic Integrity Lock

Cílem je opravit **viditelný výstup** Karlova denního přehledu, ne další backend proof. Backend může projít zelené SQL kontroly, ale UI pořád ukazuje dormantní části, staré návrhy, technické/debug texty a vágní externí kontext.

## Část A — Audit viditelného výstupu (read-only)

Projdu všechny zdroje viditelného textu v Karlově přehledu (`Karlův přehled`, `Externí kontext`, `Možné vnější zatížení`, `Společná porada týmu`, `Plán dnešní herny/sezení`, `Technické podklady`, `AI polish náhled`, `today_part_proposal`).

Výstup: `docs/P33_6_VISIBLE_OUTPUT_AUDIT.md` s tabulkou (komponenta, řádky, datový zdroj, payload path, source_cycle_id, briefing_date, expirace, admin-only, problém, potřebná změna).

## Část B — Profesionální požadavky na briefing

Vytvořím `docs/P33_6_PROFESSIONAL_DAILY_BRIEFING_REQUIREMENTS.md` pokrývající: aktuálnost, relevanci, transparentnost internetu, klinickou bezpečnost, jazykovou kvalitu, integritu plánu.

## Část C — Oprava `today_part_proposal` (dormantní části)

Nový helper `isPartTodayRelevantForPrimarySuggestion` — dormantní část (002_Anička apod.) nesmí být primární návrh dne bez čerstvé evidence (thread 24–72h, dnešní sezení/herna, live progress, explicitní zmínka terapeutkou). Technické prefixy (001_, 002_) normalizovat nebo skrýt. Při nízké opoře vyrenderovat: *"Dnes nemám dost opory vybrat konkrétní část před prvním kontaktem."*

Soubory: `supabase/functions/_shared/karelBriefingVoiceRenderer.ts`, nový `_shared/partTodayRelevance.ts`, `karel-did-daily-briefing/index.ts`.

## Část D — Externí realita: viditelné vysvětlení internetové kontroly

Renderer musí pro každou tier kategorii vyrobit konkrétní vysvětlení (kdo, co, zdroj, kdy ověřeno):
- **Tier 1 (fresh today)**: "čerstvě zachycený okruh… zdroj ověřen dnes"
- **Tier 2 (checked today, unknown pub date)**: "internetový přehled dnes znovu ověřil citlivý okruh… datum publikace není jasné… neberu jako dnešní událost"
- **Tier 3 (historical)**: "dříve evidovaný citlivý okruh bez čerstvého podkladu pro dnešek"

Zakázané fráze pro tier 2/3: "může dnes zatížit", "dnes se objevilo", "dnešní událost".

UI panel `ExternalLoadWarning.tsx` už zobrazuje doménu/data/tier — doplním textovou vrstvu v `karelBriefingVoiceRenderer.ts` a v `karel-did-daily-briefing/index.ts`.

## Část E — Skrytí technického/debug obsahu

`AiPolishCanaryPreviewPanel` a `Technické podklady` se nesmí zobrazit v normální Pracovně. Gate přes `isAdmin && debugMode`. Renderer musí odfiltrovat fráze: "AI polish", "audit", "payload", "truth gate", "job graph", "provider_status", "query_plan_version", "source_cycle_id", "unsupported_claims", "robotic_phrase".

## Část F — Čerstvost týmových porad / návrhů sezení

Audit zdrojů "Společná porada týmu", "Plán dnešní herny", "Plán sezení". Pravidlo: zobrazit jako dnešní plán pouze pokud `valid_for_date = today` nebo `session_date = today` nebo navázáno na aktuální `source_cycle_id` a není expirováno. Staré otevřené návrhy (Timmi/Timmy z předchozích dnů) přesunout pod sbalené "Starší návrhy k revizi", nikdy ne jako primární dnešní plán.

## Část G — Czech jazyková gate

Nový `supabase/functions/_shared/karelVisibleTextQuality.ts` s `auditVisibleKarelText(text)` vracející `{ ok, errors, warnings }`. Detekuje:
- dvojité interpunkce (`..`)
- chybnou gramatiku ("doložený praktickou", "Opora v podkladech je nízká")
- interní termíny (AI polish, audit, payload, source_cycle_id…)
- technické prefixy částí (`001_`, `002_`)
- false today-event fráze pro tier 2/3

## Část H — Testy

`src/test/p33_6VisibleDailyBriefingSemanticIntegrity.test.tsx` — 20 testů:
1. Low-support 002_Anička → žádný primární návrh
2. Dormantní část bez čerstvé evidence není primární
3. Technický prefix `002_` nikdy není ve viditelném textu
4. Tier 2 → "dnes ověřil" + "datum publikace není jasné"
5. Tier 2 neobsahuje "může dnes zatížit"
6. Tier 3 obsahuje "dříve evidovaný" / "bez čerstvého"
7. Externí panel není prázdný když existuje tier 2 zdroj
8. Externí panel zobrazuje doménu + datum ověření
9. Žádné interní termíny v normálním UI
10. AI polish skryt mimo admin debug
11. Technické podklady skryté mimo admin debug
12. Starý návrh z předchozího dne není primární
13. Starý Timmi návrh bez čerstvého tieru není primární
14. Same-day návrh se správným source_cycle_id se zobrazí
15-19. Quality gate chytá: dvojité interpunkce, "doložený praktickou", "Opora v podkladech je nízká", "002_Anička", interní termíny
20. Latest Karel briefing sections projdou quality gate

Plus full vitest run.

## Část I — Runtime proof

SQL na latest briefing → ověřit absenci 002_, AI polish, Technické podklady, audit, "může dnes zatížit" tier2/3, stale Timmi, dormant primární část. Internet check viditelný když je přítomen.

## Verdikt

P33.6 = ACCEPTED jen pokud projdou všechny acceptance flagy z Částí A–I. Jinak NOT_ACCEPTED. Stop po verdiktu, nezačínat P34.

---

**Rozsah:** ~15+ souborů, 2 docs, 1 nový shared helper (text quality), 1 nový shared helper (part relevance), patche v rendereru / external panel / briefing index / AI polish gating / team consultation komponentách, 20 nových testů.

**Riziko:** velké — dotýká se viditelné vrstvy několika panelů. Snažím se neměnit business logiku pipeline, jen prezentační vrstvu a freshness gating.

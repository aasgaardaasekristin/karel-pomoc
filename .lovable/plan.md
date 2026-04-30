## Problém

Věta „Včera Herna neproběhla." se objevuje jako **první řádek Karlova ranního monologu** (úplně nahoře v Karlově přehledu). Vzniká v `buildOpeningMonologue` v `supabase/functions/karel-did-daily-briefing/index.ts` (řádky ~923–932): proměnná `playroomTruth` se vsadí přímo do `frame`, a `frame` je hned druhý odstavec po pozdravu „Dobré ráno, Haničko a Káťo." → tedy první klinická věta, kterou Karel vysloví.

To je **špatné umístění** ze dvou důvodů:

1. Karlův úvodní monolog má začínat klinickým rámcem dne (co je dnes priorita, jak na tom kluci jsou) — ne administrativní stížností „včera nebyla herna".
2. Ta samá informace už **patří** a **už tam je** ve vyhrazené sekci „Včerejší / Poslední herna" (řádek 1452 panelu zobrazuje `playRecency.not_yesterday_notice`). Takže ji Karel říká dvakrát — jednou v monologu nahoře a podruhé v sekci Herny.

Stejný problém je u Sezení (řádek 1524).

## Cíl

Z **opening monologue** kompletně odstranit větu „Včera Herna neproběhla / Včera Sezení neproběhlo". Tato informace patří **výhradně** do vyhrazených sekcí „Včerejší/Poslední herna" a „Včerejší/Poslední sezení", kde už korektně zobrazena je.

Karlův úvodní odstavec musí začínat klinickým rámcem (priorita dne, postoj k materiálu), ne administrativním oznámením o tom, co se nestalo.

## Změny

### 1. `supabase/functions/karel-did-daily-briefing/index.ts` — `buildOpeningMonologue` (~ř. 897–996)

- Odstranit konstrukci `playroomTruth` (ř. 924–926) z monologu úplně.
- Přepracovat `realityOpening` (ř. 927–929) tak, aby **nezačínalo** zprávou o (ne)proběhlé herně. Místo toho začne přímo klinickým rámcem dne — co dnes držet, na čem pracovat opatrně, jaký je postoj k materiálu.
- Pokud je relevantní událost (Timmi/keporkak), zůstane jako klinický kontext, ale ne navázaný na „včera herna neproběhla".
- V `evidenceKnown` (ř. 914–921) ponechat větu „Včera Herna neproběhla." jen pro vnitřní seznam evidencí — ten se renderuje v sekci `evidence_limits` (Co víme jistě / pracovní hypotéza / čeká na ověření), ne v hlavním monologu. Tam patří.

### 2. `supabase/functions/karel-did-daily-briefing/index.ts` — `ensureKarelFirstPersonOpening` (~ř. 836)

Přidat sanitizaci: pokud LLM nebo legacy generátor vloží do prvního odstavce vzorec „Včera (Herna|Sezení) neproběhl[ao]" / „Včerejší (Herna|Sezení) neproběhl[ao]", odstranit tuto větu z otevíracího odstavce a tichá zůstane jen v dedikované sekci. Toto je guard, aby se to nikdy neopakovalo, ani když se prompt změní.

### 3. `src/components/did/DidDailyBriefingPanel.tsx` — `openingMonologueText` (~ř. 1334)

Po `ensureKarelOpeningVoice` aplikovat lokální helper `stripNotHeldNoticeFromOpening`, který z prvního odstavce monologu odstraní věty typu „Včera Herna neproběhla.", „Včerejší Herna neproběhla.", „Včera Sezení neproběhlo." atd. Tím získáme defense-in-depth proti starým cache záznamům — uživatel uvidí čistý monolog i bez čekání na regeneraci.

### 4. Sekce „Včerejší/Poslední herna" a „Včerejší/Poslední sezení" — beze změny

Tady věta `playRecency.not_yesterday_notice || "Včera Herna neproběhla."` zůstává (ř. 1452, 1524). Tady **patří** — je to dedikovaná sekce o herně/sezení, plus vedlejší recency badge a datum poslední doložené herny.

### 5. Tests

- `supabase/functions/karel-did-daily-briefing/index_test.ts`: přidat regresní test — `opening_monologue_text` (a `frame`) **nikdy neobsahuje** vzorec /Včera\s+(Herna|Sezení)\s+neproběhl[ao]/ ani /Včerejší\s+(Herna|Sezení)\s+neproběhl[ao]/.
- `src/components/did/DidDailyBriefingPanel.visibleText.test.ts`: přidat test, který sestaví fixture s `recent_playroom_review.is_yesterday=false` a ověří, že v textu monologu (první `<p>` v karte „Karlův ranní terapeutický monolog") není věta o tom, že herna neproběhla; a zároveň že **v** sekci „Poslední herna" tato věta **je**.

### 6. Regenerace aktuálního briefingu

Po nasazení označit dnešní `did_daily_briefings` řádek jako `is_stale=true` (nebo vymazat `opening_monologue_text` cache), aby se v UI okamžitě po reloadu vygeneroval nový čistý monolog. Frontend stripper (#3) zajistí korektní zobrazení i okamžitě, bez nutnosti čekat na backend.

## Akceptační kritéria

- V Karlově přehledu, v prvním odstavci „Karlův ranní terapeutický monolog", **NENÍ** věta „Včera Herna neproběhla" ani její varianta. Ověřeno screenshotem nebo DOM excerptem.
- V sekci „Poslední herna" / „Včerejší herna" **JE** korektní recency notice (např. „Poslední doložená Herna je z 27. 4. 2026 (před 3 dny)").
- Sekce `evidence_limits` („Jistě víme: …") smí obsahovat „Včera Herna neproběhla." jako jednu položku — to je její role (auditovatelný seznam).
- Regresní testy backendu i UI panelu projdou.

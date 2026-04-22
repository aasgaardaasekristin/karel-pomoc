

# THERAPIST-LED SESSION TRUTH PASS — kompletní implementační plán

## Pochopení toho, co chceš (1 věta)

Chci jeden jediný pravdivý tok therapist-led sezení: **Karel navrhne program → terapeutky ho v zanořené poradě iterativně diskutují s Karlem → po dvou skutečných podpisech se program propíše do `Dnes` jako schválený → odtud se otevírá živá asistenční místnost → po sezení Karel vyhodnotí, doptá se, a uloží do Spižírny k nočnímu propisu na Drive.**

## Část 1 — Audit současného stavu (co je špatně, soubor po souboru)

### Bug A: Falešné podpisy v DB
Aktivní `did_team_deliberations` `c6732a13-…` má `hanka_signed_at`, `kata_signed_at`, `karel_signed_at` nastavené z mé G1 demo migrace. To proto „Zahájit sezení" vypadá odemčené, ač terapeutky nepodepsaly.

### Bug B: Karel sám sebe podepisuje + zbytečné Karlovo tlačítko
- `did_team_delib_autoderive_status` trigger dnes vyžaduje **3 podpisy** (Hanička+Káťa+Karel) pro `approved`.
- `karel-team-deliberation-signoff` umožňuje volání s `signer='karel'`.
- `DeliberationRoom.tsx` zobrazuje 3. tlačítko za Karla.
- Tvoje pravda: **Karel není podepisující strana.** Schválení = 2 podpisy (Hanička+Káťa). Karel je facilitátor, ne signatář.

### Bug C: Tři různé „dnešní plány"
Forenzně potvrzené z předchozího auditu:
1. `did_daily_briefings.payload.proposed_session.first_draft` (briefing AI, ranní zamrazený)
2. `did_daily_session_plans.plan_markdown` (po podpisech, kanonický)
3. `karel-part-session-prepare` opener (dynamicky při kliknutí, child-facing)

Tři zdroje, tři verze, žádný jediný zdroj pravdy.

### Bug D: Karel v poradě není iterativní
Dnešní `DeliberationRoom`:
- Karel reaguje až na kliknutí „Spustit syntézu" (manuální).
- Když terapeutka napíše podnět, **program se neaktualizuje**.
- Karel jen kompiluje finální shrnutí, nepřepisuje program po každém vstupu.

Tvoje pravda: každý vstup terapeutky musí Karel okamžitě započíst a **upravit program bod po bodu**. Program je živý dokument iterovaný v reálném čase, ne statický návrh + závěrečná syntéza.

### Bug E: Karel-led „Vstup do herny" leakuje therapist-led plán
`karel-part-session-prepare` dostává `plan.plan_markdown` jako hint → child-facing opener někdy reprodukuje therapist-facing program. C0 pass to měl řešit, ale ponechal `first_draft` v payloadu.

### Bug F: Live room neodpovídá tvé specifikaci
`DidLiveSessionPanel` dnes:
- ✅ Existuje vlákno
- ✅ Karel může reagovat
- ❌ Chybí upload audio/video/foto/screenshot/grafologie inline v panelu
- ❌ Chybí live audio/video nahrávání v reálném čase
- ❌ Chybí strukturované zobrazení programu „bod po bodu" s živým checklist
- ❌ Chybí Karlovy proaktivní in-session „pozoruj X" karty s polem pro odpověď
- ❌ Chybí tlačítko `Ukončit sezení` → post-session interrogation flow

### Bug G: Post-session interrogation + Spižírna
`DidPostSessionInterrogation` existuje, ale:
- Není napojený jako jediný vstup pro „Odeslat k analýze".
- Spižírna (cache pro noční Drive propis) — neexistuje jako explicitní vrstva. Drive zápis dnes jde přes `did_pending_drive_writes` (queue), ale není to „balík přesýpacích hodin", co popisuješ.

## Část 2 — Co opravím (5 atomických kroků)

### Krok 1 — DB & Trigger pravda (2 podpisy stačí)

**Migrace:**
1. Přepsat `did_team_delib_autoderive_status` trigger:
   ```sql
   IF hanka_signed_at IS NOT NULL AND kata_signed_at IS NOT NULL
      AND status NOT IN ('approved','closed','archived') THEN
     status := 'approved';
     karel_signed_at := COALESCE(karel_signed_at, now());  -- jen audit timestamp
   ELSIF (hanka_signed_at IS NOT NULL OR kata_signed_at IS NOT NULL)
         AND (hanka_signed_at IS NULL OR kata_signed_at IS NULL)
         AND status IN ('draft','active') THEN
     status := 'awaiting_signoff';
   END IF;
   ```
   → Karel se autopodepíše jako audit log, ale nebude blokovat schválení.

2. **Insert (data repair)** — vrátit falešné podpisy aktuální porady na NULL:
   ```sql
   UPDATE did_team_deliberations
   SET hanka_signed_at=NULL, kata_signed_at=NULL, karel_signed_at=NULL, status='active'
   WHERE id='c6732a13-1862-43c7-9151-e7cf6200f2fa';
   ```

### Krok 2 — `DeliberationRoom.tsx` — iterativní program + 2 tlačítka

**Změny:**
- Odstranit Karlovo podpisové tlačítko úplně.
- Přejmenovat zbývající 2 na: **„Stvrzuji podpisem souhlas (Hanička)"** a **„Stvrzuji podpisem souhlas (Káťa)"**.
- Pro každou terapeutku po jejím podpisu: její sekce read-only (textarea disabled, podpis disabled), ale ostatní sekce zůstávají editovatelné, dokud nepodepíše druhá.
- V hlavičce dynamický badge: `Schválily: Hanička ✓` / `Schválily: Hanička ✓, Káťa ✓`.
- Přidat **živý program bod po bodu** v horní části místnosti — viditelný editovatelný `program_draft` (jsonb pole agendy s body).
- Po každém novém vstupu terapeutky (odpověď na otázku NEBO vlastní podnět) trigger volání **nové edge fn `karel-team-deliberation-iterate`**, která:
  - vezme aktuální `program_draft`
  - vezme nový vstup terapeutky + kontext (briefing, část, předchozí diskuse)
  - vrátí **upravený `program_draft` + komentář Karla** („Podle podnětu Hany jsem do bodu 2 přidal X, bod 4 zkrátil…")
  - uloží do `did_team_deliberations.program_draft` + appenduje do `discussion_log`
- Když oba podpisy → trigger bridge → `did_daily_session_plans.plan_markdown` se přepíše z finálního `program_draft` (ne z původního first_draft).

**Nová edge fn `karel-team-deliberation-iterate`:**
- Model: `google/gemini-2.5-flash` (rychlost + kvalita).
- Input: `deliberation_id`, `latest_input` (kdo, co napsal), `current_program_draft`.
- Output: `{ updated_program_draft, karel_inline_comment, suggested_questions_for_other_therapist }`.
- Idempotence guard: pokud `latest_input` už zpracován (hash), no-op.

### Krok 3 — Single Source of Truth (skrýt duplicity)

**`DidDailyBriefingPanel.tsx`:**
- Sekce „Dnešní navržené sezení" se schová, pokud existuje approved `did_daily_session_plans` pro dnešek a danou část.
- Jinak ukáže `proposed_session` jako návrh + CTA „Otevřít poradu" (ne jako finální plán).

**`DidDailySessionPlan.tsx`:**
- `plan_markdown` zůstává **jediný kanonický** zdroj pro:
  - zobrazení v `Dnes`
  - tlačítko „Spustit sezení"
  - obsah live roomu

**`karel-part-session-prepare` payload:**
- Odstranit `briefing_proposed_session` z hint payloadu.
- Posílat jen: `{ part_name, why_today, therapist_addendum }`.
- **POZN:** Karel-led `Vstup do herny` zůstává nedotčený jinak — jen vyčistíme leak.

### Krok 4 — `Dnes` přejmenování + nový live entry

**`DidDailySessionPlan.tsx`:**
- Když plan je approved: text karty **„Sezení na dnes připraveno a schváleno"** + badge „Schválily: Hanička, Káťa".
- Tlačítko **„Spustit sezení"** (přejmenování ze „Zahájit sezení") → otevře `DID/Terapeut/Live DID sezení` se vytvořeným nebo nalezeným therapist-led vláknem.
- Bez schválení: zachovaný blocker z G1 (CTA „Otevřít přípravu (N/2)").

### Krok 5 — Live therapist-led room (rozšíření `DidLiveSessionPanel`)

**Rozšíření UI:**
1. **Levý panel**: schválený program bod-po-bodu jako interaktivní checklist. Klik na bod → expanduje Karlovy poznámky k bodu + pole pro Hanky odpověď („co pozorovala") + checkbox „bod hotov".
2. **Hlavní panel**: chat s Karlem (existuje) + **inline upload bar** (univerzální komponent `UniversalAttachmentBar` už existuje):
   - foto, screenshot, audio, video, dokument (grafologie/kresba)
3. **Pravý panel**: Karlovy proaktivní karty („pozoruj X" / „zeptej se Y") s rychlým input polem pro odpověď, kterou Karel ihned započítá.
4. **Live recording**: tlačítka **„Spustit live audio"** a **„Spustit live video+audio"** — chunked upload do `session-media` bucketu po 10s, server-side transkripce v reálném čase přes existující pipeline.
5. **Spodní lišta**:
   - Tlačítko **„Ukončit sezení"** → spustí post-session interrogation.

**Backend:**
- Nová edge fn `karel-live-session-feedback` (Gemini 2.5 Flash) — fire-and-forget po každém uploadu/zprávě, vrací krátkou Karlovu poznámku zpět do chatu.
- Karel-led „Vstup do herny" zůstává Karel-led (oddělené flow, neslučovat).

### Krok 6 — Post-session interrogation + Spižírna

**Po stisknutí „Ukončit sezení":**
1. Karel ihned napíše do chatu: „Děkuju, Hani. Mám pár otázek, abych zápis udělal pořádně:" + 3-5 cílených doptávacích otázek (jak vypadal v X, co jsi vnímala u Y).
2. Hanka odpovídá ve stejném vlákně, Karel iteruje, dokud má slepá místa.
3. Když má dost (vlastní self-check), Karel napíše: „Tohle stačí. Stiskni prosím **Odeslat analýzu k zápisu**."
4. Tlačítko se odemkne (gated podle `interrogation_complete=true`).
5. Po stisknutí:
   - Karel vygeneruje finální analýzu (jak proběhlo, co o části zjistil, další postup, co povedlo, co příště, soulad s plánem).
   - Uloží jako **balík do Spižírny** = nová tabulka `did_pantry_packages` s payloadem `{ session_id, type:'session_analysis', content_md, drive_target_path, status:'pending_drive' }`.
   - Vlákno se uzamkne (`is_locked=true`).

**Spižírna → Drive (noční propis):**
- Cron `karel-pantry-flush-to-drive` v 04:00 ráno (pg_cron + pg_net).
- Vezme všechny `did_pantry_packages` se `status='pending_drive'` za posledních 24h.
- Routuje přes existující `documentGovernance.ts` do správných cílů (`05A`, `05B`, `05C`, `KARTOTEKA_DID/<part>`, `PAMET_KAREL/Hana`…).
- Po úspěšném zápisu: `status='flushed'`.
- Pak (~05:00) běží existující `karel-did-daily-cycle`, který si z Drive natáhne base info pro nový den a v 06:00 je dashboard připravený.

## Část 3 — Soubory, které se změní

| Soubor | Typ změny |
|---|---|
| Migrace: trigger `did_team_delib_autoderive_status` | přepsat na 2-podpis logiku |
| Insert: data repair falešných podpisů | UPDATE NULL |
| `supabase/functions/karel-team-deliberation-signoff/index.ts` | odstranit `signer='karel'` cestu |
| `supabase/functions/karel-team-deliberation-iterate/index.ts` | **NOVÁ** — iterativní program update |
| `supabase/functions/karel-live-session-feedback/index.ts` | **NOVÁ** — in-session Karel reakce |
| `supabase/functions/karel-pantry-flush-to-drive/index.ts` | **NOVÁ** — noční propis |
| `supabase/functions/karel-part-session-prepare/index.ts` | odstranit `first_draft` z hint payloadu |
| Migrace: tabulka `did_pantry_packages` | **NOVÁ** |
| Migrace: sloupec `did_team_deliberations.program_draft jsonb` | **NOVÝ** |
| Migrace: sloupec `did_team_deliberations.interrogation_complete bool` | **NOVÝ** (pro post-session) |
| Migrace: cron pro `karel-pantry-flush-to-drive` v 04:00 (přes insert tool) | **NOVÝ** |
| `src/components/did/DeliberationRoom.tsx` | iterativní program + 2 tlačítka + read-only po podpisu |
| `src/components/did/DidDailyBriefingPanel.tsx` | skrýt proposed když existuje approved plan |
| `src/components/did/DidDailySessionPlan.tsx` | text + tlačítko „Spustit sezení" + odstranit first_draft hint |
| `src/components/did/DidLiveSessionPanel.tsx` | program checklist + uploady + live record + Karlovy karty + Ukončit sezení |
| `src/components/did/DidPostSessionInterrogation.tsx` | napojit jako jediný vstup pro Odeslat k zápisu |

## Část 4 — Co se NEZMĚNÍ (mimo scope)

- **Sezení s Karlem** (Karel-led `karel_part_session`) — explicitně až v dalším passu.
- `KarelPartSessionBanner` — nesahám.
- Briefing AI generace (`karel-did-daily-briefing`) — produkuje proposed_session, to je správně, jen ho UI přestane ukazovat duplicitně.
- Existující Drive queue (`did_pending_drive_writes`) — Spižírna je nová vrstva NAD ní (Spížírna vyrobí balík → flush ho zařadí do queue → queue ho fyzicky pošle).

## Část 5 — Pořadí implementace + důkaz

1. Migrace trigger + repair podpisů + nové sloupce/tabulka.
2. Backend: 3 nové edge fn + úprava signoff + úprava part-session-prepare.
3. Frontend: DeliberationRoom (iterativní + 2 tlačítka) → DailyBriefingPanel (skrýt duplicitu) → DailySessionPlan (Spustit sezení) → LiveSessionPanel (uploady + checklist + Karel karty + Ukončit) → PostSessionInterrogation (Spižírna handoff).
4. Cron 04:00 pro pantry flush.
5. **Real-app proof přes browser tool**:
   - (a) Porada bez podpisů → blocker, 2 tlačítka přejmenovaná, žádné Karlovo tlačítko.
   - (b) Hanka napíše podnět → program se přepíše + Karlův komentář.
   - (c) Hanka podepíše → její sekce read-only, hlavička „Schválily: Hanička", Káťa stále edituje.
   - (d) Káťa podepíše → status approved, plan_markdown přepsán, `Dnes` ukazuje „Spustit sezení", briefing duplicita zmizí.
   - (e) Live room: program checklist, upload bar, Karlova karta s polem na odpověď.
   - (f) Ukončit sezení → Karel se ptá → Odeslat k zápisu → balík v `did_pantry_packages`.


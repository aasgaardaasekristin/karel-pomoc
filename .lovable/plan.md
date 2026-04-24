## Diagnóza: proč nedošlo k vyhodnocení včerejšího sezení

### Co existuje a co ne

| Komponenta | Existuje? | Poznámka |
|---|---|---|
| `karel-session-finalize` (edge funkce) | ✅ ANO | Ale píše do `client_sessions` / `client_tasks` — **to je tabulka pro Pracovní/klientský režim, NE pro DID kluky.** Nikde v DID workflow se nevolá. |
| Volání finalize z `BlockDiagnosticChat` / `LiveProgramChecklist` | ❌ NE | LIVE program v Pracovně neví, jak skončit. Když Hana dojede poslední blok, nic se nestane. |
| Funkce, která analyzuje DID sezení a píše do `did_part_sessions` (ai_analysis, methods_used, karel_therapist_feedback…) | ❌ NE | Jediný zápis do `did_part_sessions` je z `karel-did-auto-session-plan` při schválení porady — vloží řádek s `notes = plán` a prázdným `ai_analysis`. To je přesně řádek `5ae5932d…` z 23.4. |
| Funkce, která pošle hodnocení sezení do Drive (KARTA_<part>) | ❌ NE | Žádná funkce nevytváří `did_pantry_packages` typu `session_summary`. |
| Funkce, která ráno načte hodnocení sezení a zařadí ho do Karlův přehled | ⚠️ ČÁSTEČNĚ | `karel-did-daily-briefing` čte `karel_pantry_b_entries` (Spižírnu B) a inlinuje ji do promptu pod hlavičkou `SPIŽÍRNA B — VČEREJŠÍ IMPLIKACE PRO DNEŠEK`. Ale nikdo do Spižírny B z DID sezení nezapíše → briefing nemá co načíst. Briefing navíc **nemá vyhrazenou sekci** „vyhodnocení včerejšího sezení". Schéma má jen: `greeting / last_3_days / lingering / decisions / proposed_session / ask_hanka / ask_kata / closing`. |

### Konkrétní řetěz selhání pro 23.4. sezení s Tundrupkem
1. Hana otevřela LIVE program → `BlockDiagnosticChat` → odpracovala (částečně) bloky → zavřela okno.
2. Žádný hook „session ended" → `did_part_sessions.5ae5932d…` zůstal s `ai_analysis=""`, `karel_therapist_feedback=""`, `methods_used=NULL`.
3. `did_daily_session_plans.565e8da3…` zůstal `status='in_progress'`, `completed_at=NULL`.
4. `karel_pantry_b_entries` → 0 nových entries z průběhu sezení.
5. Ráno 24.4. `karel-did-daily-briefing` načetl Spižírnu B → našel jen jediný záznam (podpis porady z 23.4. ráno) → vyrobil `last_3_days` z thread vlákna `7d095a81…` (volná konverzace TUNDRUPEK), nikoli ze sezení.
6. Briefing fyzicky nemá kam vyhodnocení napsat — schéma neobsahuje pole pro retrospektivu sezení.

---

## Plán opravy

### A. Nová edge funkce `karel-did-session-evaluate`

Souhrnný evaluátor pro DID sezení. Volaná dvěma cestami:
- **automaticky** z UI při ukončení sezení (i částečném),
- **automaticky** noční funkcí jako safety net (pokud uživatel zapomene zavřít).

**Vstup:** `{ planId, partName, threadId, completedBlocks, totalBlocks, leadTherapist, durationMinutes, endedReason: 'completed' | 'partial' | 'auto_safety_net' }`

**Co dělá (Gemini 2.5 Pro):**
1. Načte plán (`did_daily_session_plans` + bloky), reálnou konverzaci z `did_threads.messages` v okně sezení, kontext části (`did_parts` karta z DB) a profil terapeutky (`therapist_crisis_profile`).
2. Vygeneruje strukturovaný JSON:
   - `session_arc` — co se dělo blok po bloku
   - `child_perspective` — **hlavní důraz**: jak na tom byla část (Tundrupek), co prožívala, co fungovalo / nefungovalo z pohledu dítěte, regrese / progrese, riziko retraumatizace
   - `therapist_motivation` — čeho si u Hany / Káti všiml (odhodlání, empatie, kde zaváhala, co ji posílilo) — sekundární vrstva
   - `methods_used` + `methods_effectiveness` (per metoda: ✅ / ⚠️ / ❌ + 1 věta proč)
   - `key_insights` — 2-4 klinické závěry
   - `implications_for_tomorrow` — co z toho plyne pro další postup
   - `tasks` — `[{owner: hanka|kata|karel, urgency, text}]`
   - `recommended_next_step` — návrh dalšího sezení / pauzy
   - `completion_status` — `completed | partial(X/Y blocks) | abandoned`
   - `incomplete_note` — pokud částečné: 1-2 věty o tom, co nestihli a co s tím
3. **Zápis výsledku do tří míst** (vše idempotentně podle `planId`):
   - `did_part_sessions` (update existujícího řádku): `ai_analysis`, `methods_used`, `methods_effectiveness`, `karel_notes`, `karel_therapist_feedback`, `tasks_assigned`
   - `did_daily_session_plans`: `status='completed'`, `completed_at=now()`
   - `karel_pantry_b_entries`: 1 hlavní `entry_kind='conclusion'` se `summary=child_perspective[:200]` + N entries `entry_kind='followup_need'` z `tasks[]` + případně `entry_kind='hypothesis_change'` z `key_insights`. Všechny mají `source_kind='therapy_session'`, `source_ref=planId`, `intended_destinations=['briefing_input','did_therapist_tasks','did_implications']`.
   - `did_pantry_packages`: 1 balík `package_type='session_summary'` s plnou markdown verzí, `drive_target_path='KARTA_<PART_NAME>'`. Druhý balík `package_type='session_log'` s `drive_target_path='KARTOTEKA_DID/00_CENTRUM/05C_SEZENI_LOG'`.
4. Vrací JSON evaluaci (UI ji rovnou zobrazí Hance).

### B. Napojení na UI (auto-trigger)
1. `LiveProgramChecklist.tsx` — přidat tlačítko **„Ukončit sezení a vyhodnotit"** (vždy viditelné, i když nejsou všechny bloky `done`). Po kliku zavolá `karel-did-session-evaluate` a zobrazí spinner → výsledek.
2. `BlockDiagnosticChat.tsx` — když se poslední blok přepne na `done`, automaticky nabídnout finalizaci (toast s tlačítkem, NE silent autocall — terapeutka má kontrolu).
3. Po finalizaci: lock plánu (UI prokliká do read-only zobrazení vyhodnocení), zápis odznaku „Vyhodnoceno" do `LiveProgramChecklist`.

### C. Noční safety-net v `karel-did-daily-cycle`
Před Phase 8B (Pantry B Flush) přidat krok **Phase 8A.5 — Stale session evaluation**:
- Najdi `did_daily_session_plans` se `status='in_progress'` + `plan_date < today` + bez navazujícího `did_part_sessions.ai_analysis`.
- Pro každý zavolej `karel-did-session-evaluate` se `endedReason='auto_safety_net'`.
- Výsledek se rovnou propíše do Spižírny B → ranní briefing ho ten samý běh načte.

### D. Rozšíření `karel-did-daily-briefing` o sekci „Vyhodnocení včerejška"
1. **Změna schématu** v `karel-did-daily-briefing/index.ts` (kolem řádku 290–397):
   - Přidat nové pole `yesterday_session_review` (object, optional) s podpoli:
     - `held` (bool) — proběhlo včera nějaké sezení?
     - `part_name` (string)
     - `lead` (`hanka|kata|both`)
     - `completion` (`completed|partial|abandoned`)
     - `child_focus` (string, 2-3 věty) — **primární obsah**
     - `therapist_note` (string, 1-2 věty) — sekundární obsah o motivaci/práci terapeutky
     - `what_to_carry_forward` (string, 1-2 věty)
   - Přidat do `required` array? **Ne** — pokud včera žádné sezení nebylo, pole je `null` a UI sekci skryje. Tím obejdeme situaci „nemáme co říct".
2. **Změna promptu**: před odesláním do AI načíst:
   - `did_part_sessions` se včerejším `session_date` + neprázdným `ai_analysis` + případně `did_daily_session_plans` se včerejším `plan_date`
   - Vložit do promptu blok `═══ VČERA PROBĚHLO SEZENÍ ═══` s plnou evaluací z `ai_analysis` + statusem dokončení
   - Pokyn: „Vyhodnoť pro Hanu/Káťu jak to šlo. **Důraz vždy na zážitek dítěte / části**, sekundárně na práci terapeutky. Pokud sezení nebylo dokončeno, explicitně to napiš a vyhodnoť jen to, co proběhlo."
3. **Změna pořadí v UI render** (`DidDailyBriefingPanel.tsx`):
   ```
   1. greeting
   2. last_3_days  (= "Z dřívějška zůstává podstatné")
   3. yesterday_session_review  ← NOVÉ, mezi #2 a #4
   4. proposed_session  (= "Návrh sezení k poradě")
   5. decisions
   6. lingering
   7. ask_hanka / ask_kata
   8. closing
   ```

### E. Jednorázový reprocess pro 23.4.
Po deploymentu výše uvedeného: zavolat `karel-did-session-evaluate` ručně (přes admin tlačítko v `AdminSpravaLauncher.tsx` nebo přes `supabase--curl_edge_functions`) s `planId='565e8da3-9f30-46d0-87c1-048672712b3b'` a `endedReason='auto_safety_net'`. Pak přegenerovat dnešní briefing s `force: true` → Karelův přehled bude obsahovat sekci `yesterday_session_review` s vyhodnocením.

---

## Co se po implementaci stane denně

**Dnes ráno (jednorázově):** zpětně vyhodnotí 23.4. sezení s Tundrupkem (i když bylo nedokončené) a doplní do dnešního Karlův přehled novou sekci „Vyhodnocení včerejška".

**Každé další sezení:**
- Hana dojede poslední blok → toast „Ukončit a vyhodnotit?" → klik → AI vyhodnocení → uloží se do DB + Spižírny B + odešle se balík na Drive (`KARTA_TUNDRUPEK` + `05C_SEZENI_LOG`).
- Pokud zapomene → noční safety-net to udělá za ni s `endedReason='auto_safety_net'`.

**Každé ráno:**
- 04:00 UTC `karel-did-context-prime` načte z Drive čerstvě zapsanou kartu Tundrupka (už obsahuje včerejší vyhodnocení).
- 05:00 UTC `karel-did-daily-cycle` projede Phase 8A.5 (stale eval) + Pantry B flush.
- 05:30 UTC `karel-did-daily-briefing` najde v DB včerejší `did_part_sessions.ai_analysis` + Spižírnu B → vygeneruje sekci `yesterday_session_review` s důrazem na dítě → Karel ji renderuje mezi „Z dřívějška" a „Návrh sezení".

---

## Soubory a funkce

**Nové:**
- `supabase/functions/karel-did-session-evaluate/index.ts`

**Upravené (edge):**
- `supabase/functions/karel-did-daily-briefing/index.ts` — schema + prompt + load yesterday session
- `supabase/functions/karel-did-daily-cycle/index.ts` — Phase 8A.5 safety net

**Upravené (UI):**
- `src/components/did/LiveProgramChecklist.tsx` — tlačítko Ukončit & vyhodnotit
- `src/components/did/BlockDiagnosticChat.tsx` — auto-toast po posledním bloku
- `src/components/did/DidDailyBriefingPanel.tsx` — render nové sekce `yesterday_session_review`
- `src/components/did/AdminSpravaLauncher.tsx` — diagnostické tlačítko reprocess pro libovolné `planId`

**Beze změny zůstává:** `karel-session-finalize` (ten patří klientskému Pracovnímu režimu, neplést s DID).</parameter>
<parameter name="summary">Diagnóza ukázala, že DID sezení nemá vyhodnocovací funkci ani auto-finalize — `karel-session-finalize` existuje, ale slouží jen Pracovnímu režimu. Navrhuji novou funkci `karel-did-session-evaluate` (s důrazem na dítě, sekundárně motivace terapeutek), auto-trigger z UI při ukončení (i částečném), noční safety-net pro zapomenutá sezení, a novou sekci `yesterday_session_review` v Karlův přehled mezi „Z dřívějška" a „Návrh sezení". Plus jednorázový reprocess pro 23.4.
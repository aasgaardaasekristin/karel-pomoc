Máte pravdu: sekce v UI je sice v kódu podmíněně napsaná, ale reálně se nezobrazuje, protože v databázi není žádný `did_session_reviews` záznam s `mode='playroom'`. Poslední herny existují jako vlákna, např. `Herna TUNDRUPEK · 26. dubna` s 23 zprávami, ale nebyly promítnuté do samostatného review Herny. Proto Karlův přehled nemá co zobrazit.

Plán opravy:

1. Opravit vyhodnocení Herny
   - Upravit `karel-did-session-evaluate`, aby pro Karel-led / Herna režim vždy zapisovalo `mode='playroom'`, nejen když plán obsahuje `ui_surface='did_kids_playroom'`.
   - Doplnit totéž i do evidence-limited větví, kde se dnes `mode` vůbec nenastavuje a záznam pak spadne do běžného sezení.
   - Při vyhodnocení načítat správné vlákno Herny přes `workspace_type='session' + workspace_id=planId` a `sub_mode='karel_part_session'`.

2. Opravit Karlův přehled, aby Herna nezmizela ani bez hotového review
   - `DidDailyBriefingPanel` nebude spoléhat jen na `did_session_reviews.mode='playroom'`.
   - Pokud review Herny chybí, načte včerejší `did_threads.sub_mode='karel_part_session'` a zobrazí fallback sekci „Včerejší herna“ s poctivým stavem: proběhla / počet zpráv / čeká na vyhodnocení.
   - Tím bude sekce viditelná hned, ne až po úspěšné noční finalizaci.

3. Doplnit opravný backfill pro existující data
   - Pro již existující včerejší herny vytvořit nebo opravit `did_session_reviews` záznam jako `mode='playroom'`.
   - Konkrétně zachytit vlákna typu `karel_part_session`, která mají navázaný `workspace_id=plan_id`, a doplnit jim playroom review / sync stav.

4. Odstranit mrtvou nebo nebezpečnou cestu z Karlova přehledu
   - V `DidDailyBriefingPanel` je stále stará funkce `openKarelPartSessionRoom`, která umí otevřít Herna vlákno z návrhu sezení bez `plan_id`. To je přesně typ cesty, která míchá sezení a hernu.
   - Odstranit nebo zneškodnit tuto cestu, aby Herna šla otevírat jen přes schválený `playroom_plan` v `DidDailySessionPlan` / `DidKidsPlayroom`.

5. Opravit aktuální React warning
   - Console hlásí ref warning na `NarrativeDivider`, ne na `SectionHead`.
   - Upravit `NarrativeDivider` na `forwardRef`, aby dashboard dál neházel warning při renderu briefing sekcí.

6. Ověření
   - Ověřit dotazem, že existuje alespoň jeden aktuální `did_session_reviews.mode='playroom'` pro včerejší Herna vlákno.
   - Ověřit, že Karlův přehled renderuje samostatné sekce:
     - „Včerejší herna“
     - „Vyhodnocení včerejšího sezení“
   - Ověřit, že program sezení se už nepoužívá jako program Herny.
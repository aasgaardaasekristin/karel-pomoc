Níže je věcný stav po kontrole kódu. Netvrdím, že rozsáhlá oprava je hotová. Hotový je jen stabilizační základ a část workflow. Zbývá dodělat hlavně propojení reportů, Drive/kartoteka synchronizaci, Karlův přehled a safety/weekly/monthly vrstvy.

## Co už je reálně založené / částečně hotové

1. Stabilizace `karel-chat`
- Jung importy jsou doplněné.
- Existuje normalizace multimodálního obsahu pro prompt.
- Existuje Herna fallback odpověď.
- `karel-chat` zapisuje audit do `karel_runtime_audit_logs` s modelem, tierem, podrežimem, kontraktem a multimodálním příznakem.
- Pro Hernu je nastavený `PLAYROOM_SYSTEM_CONTRACT_v2` jako kontraktní verze.

2. Herna UI
- Herna načítá jen kandidáty se schválením (`approved` / `ready_to_start` / `in_progress` + `approved_for_child_session`).
- UI má dětsky bezpečný fallback.
- `Ukončit hernu` existuje a volá `karel-did-session-evaluate`.
- Přílohy se předávají do zprávy přes univerzální attachment systém.

3. Databázový základ
- Přibyla pole pro `program_status`, Drive sync statusy, reportová pole a audit.
- Existuje tabulka `did_daily_consolidation_runs`.
- Existuje `mode` v `did_session_reviews` s hodnotami `playroom | session`.

4. Denní cyklus / safety-net
- `karel-did-daily-cycle` zapisuje audit konsolidačního běhu s cílem 03:00.
- `karel-did-session-evaluate` umí řešit částečné / evidence-limited situace.

## Co zbývá jako prioritní dluh

### 1. Schvalovací workflow není dotažené do jednoho autoritativního stavu
Problém:
- V UI schválení Herny zatím aktualizuje hlavně `urgency_breakdown`, ale ne vždy autoritativní `program_status`.
- `DidDailyBriefingPanel` pořád někde kontroluje staré `status = approved`, ne nový `program_status`.

Dodělat:
- Při schválení/odložení/odmítnutí aktualizovat i `program_status`.
- Sjednotit všechny startovací guardy na `program_status`.
- Při úpravě programu vracet plán do `in_revision`.

### 2. Herna a Sezení reporty nejsou ještě plnohodnotně rozdělené na (1) a (2)
Problém:
- `karel-did-session-evaluate` dnes stále používá původní evaluační schéma zaměřené hlavně na sezení.
- Nová DB pole pro detailní analýzu, praktický report, `team_closing`, `recommendations_for_next_playroom` existují, ale nejsou plně generována jako povinné dvě samostatné výstupní vrstvy.

Dodělat:
- Rozšířit evaluační prompt/tool schema na:
  - detailní analýza `(1)`,
  - praktický report `(2)`,
  - specifické větvení `mode = playroom | session`,
  - týmové uzavření u Sezení,
  - doporučení pro další Hernu.
- Zapsat tato pole do `did_session_reviews` konzistentně.

### 3. Drive/kartoteka_DID synchronizace je zatím převážně metadata, ne garantovaný výstup
Problém:
- Sloupce pro Drive ID/URL a sync statusy existují.
- Fronta `did_pending_drive_writes` se používá v systému obecně.
- Ale Herna/Sezení review zatím negarantuje vytvoření dvou Drive dokumentů/linků + zápis do karty části jako povinný dokončovací krok.

Dodělat:
- Při evaluaci založit/zafrontovat samostatné výstupy:
  - detailní analýza `(1)`,
  - praktický report `(2)`,
  - zápis do karty části v `kartoteka_DID`.
- Po úspěchu aktualizovat:
  - `detail_analysis_drive_id/url`,
  - `practical_report_drive_id/url`,
  - `kartoteka_card_target`,
  - `synced_to_drive`,
  - `drive_sync_status`,
  - `source_of_truth_status`,
  - `last_sync_error`.
- Zajistit retry při selhání.

### 4. Karlův přehled ještě neumí požadovanou sekci `Včerejší herna`
Problém:
- `DidDailyBriefingPanel` načítá `did_session_reviews`, ale zobrazuje pouze obecnou sekci `Vyhodnocení včerejšího sezení`.
- Není tam samostatná sekce `Včerejší herna`.
- Není tam rozbalovací detailní analýza pro Hernu/Sezení.
- Nečte nová pole typu praktický report, detailní analýza, Drive sync status.

Dodělat:
- Načítat zvlášť včerejší `mode='playroom'` a `mode='session'`.
- Přidat sekci `Včerejší herna`:
  - úvodní Karlovy věty,
  - praktický report `(2)`,
  - význam pro část / kluky / terapeutky,
  - rozbalení detailní analýzy `(1)`.
- Upravit sekci `Vyhodnocení včerejšího sezení`, aby nezobrazovala celou detailní analýzu na ploše a obsahovala týmové uzavření.
- Zobrazovat stav synchronizace: hotovo / čeká / chyba.

### 5. Noční safety-net není ještě úplně funkčně propojený s Herna/Sezení finalizací
Problém:
- Audit běhu existuje.
- `karel-did-session-evaluate` umí evidence-limited výstupy.
- Je potřeba ověřit a případně doplnit, že denní cyklus skutečně vyhledá všechny neukončené Herny/Sezení a zavolá evaluaci pro každé relevantní `in_progress` / částečné sezení.

Dodělat:
- V `karel-did-daily-cycle` doplnit jasný krok:
  - najít včerejší Herny bez evaluace,
  - najít včerejší Sezení bez evaluace,
  - najít `in_progress` / částečná data,
  - zavolat `karel-did-session-evaluate` s `endedReason='auto_safety_net'`.
- Aktualizovat `processed_playrooms`, `processed_sessions`, `partial_sessions`, `drive_sync_status`, `error_message`.

### 6. Safety router pro Hernu/Sezení je zatím jen obecná krizová vrstva, ne tvrdý runtime router
Problém:
- V projektu existují safety funkce a krizové alerty.
- Ale v Herna/Sezení runtime není ještě explicitní předvolací detekce rizikového vstupu s přepnutím mimo běžnou Herna/Sezení repliku.

Dodělat:
- Přidat deterministický + AI safety precheck pro dětský vstup a terapeutické poznámky.
- Při riziku:
  - nepokračovat v běžném programu,
  - vrátit stabilizační odpověď,
  - založit krizový záznam / alert,
  - zalogovat audit.

### 7. Terapeutem vedené Sezení není ještě oddělené UI/kontraktově stejně tvrdě jako Herna
Problém:
- Kontraktová verze `THERAPIST_SESSION_ASSISTANT_CONTRACT_v1` v `karel-chat` existuje, ale je potřeba ověřit a dotáhnout UI cestu, která Karla používá jako live asistenta terapeutky, ne jako běžný chat.

Dodělat:
- U live Sezení posílat správné `didSubMode='therapist_session'` nebo ekvivalent konzistentně.
- V promptu vynutit výstup po každém zápisu terapeutky:
  - další mikro-krok,
  - formulace pro terapeutku,
  - 1–2 otázky,
  - co sledovat,
  - co zaznamenat,
  - kdy zpomalit / ukončit / safety.

### 8. Týdenní a měsíční směry nejsou napojené na Herna/Sezení reporty podle nové logiky
Problém:
- Funkce pro weekly/monthly cykly existují.
- Není potvrzené, že berou nové `did_session_reviews` pro `mode='playroom'` a `mode='session'`, nové praktické reporty a evidence-limited stavy.

Dodělat:
- Doplnit weekly/monthly agregaci o Herna/Sezení review.
- Zahrnout `completion_status`, `evidence_limitations`, `recommendations_for_next_playroom/session`.
- Výstupy používat v plánování další Herny/Sezení.

### 9. Odborné zdroje / anti-halucinační evidence nejsou součástí nové Herna/Sezení pipeline
Problém:
- Výzkumné funkce v projektu existují, ale nový workflow ještě nemá povinné pole pro zdroje, datum přístupu, relevanci a jistotu.

Dodělat:
- U návrhu programu, týdenního a měsíčního směru přidat `sources[]`.
- Oddělit obecnou inspiraci od závazného klinického podkladu.
- Zakázat generování chráněných diagnostických položek.

## Nejkratší pořadí pokračování

1. Opravit autoritativní `program_status` ve schvalování a start guardech.
2. Rozšířit `karel-did-session-evaluate` na povinnou dvojici reportů `(1)` a `(2)` pro Herna/Sezení.
3. Přidat Drive/kartoteka enqueue pro oba reporty a zápis do karty části.
4. Upravit Karlův přehled: `Včerejší herna`, upravené `Vyhodnocení včerejšího sezení`, rozbalovací detail.
5. Dotáhnout noční safety-net, aby vyhodnocoval neukončené Herny/Sezení.
6. Přidat explicitní safety router do runtime.
7. Napojit weekly/monthly směry a zdrojovou evidenci.

## Shrnutí verdiktu

Hotovo není. Je hotový stabilizační patch a část kostry. Zbývá implementovat produkční workflow: schválení jako source of truth, dva typy reportů, povinná Drive/kartoteka synchronizace, zobrazení v Karlově přehledu, noční finalizace, safety router a weekly/monthly návaznost.
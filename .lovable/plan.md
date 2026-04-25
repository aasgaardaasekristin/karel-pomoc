Schválený cíl: pouze dotáhnout dvě zjištěné nedokončenosti po Arthur 24. 4. backfillu:

1. 05A write nesmí padat na `target not in governance whitelist`.
2. `yesterday_session_review` musí nést explicitní strojový i textový partial/evidence-limited stav.

Bez finalizeru, bez daily-cycle, bez DOK3 refaktoru, bez nového backfillu.

## Zjištění z read-only kontroly

- Existující 05A canonical target v governance je:
  `KARTOTEKA_DID/00_CENTRUM/05A_OPERATIVNI_PLAN`
- Skipped write pro Arthur review má ale target:
  `05A_OPERATIVNI_PLAN`
- Konkrétní řádek fronty:
  `7ec60cb4-6ec6-425e-89a6-be8ab659eafc`
- Marker v contentu:
  `did_session_review:a86b7399-aef4-48cf-97c0-58b2c3121e9f`
- Aktuální stav:
  `status = skipped`, `last_error_message = target not in governance whitelist`, `priority = high`, `write_type = append`
- Zdroj chyby je v `karel-did-session-evaluate`: projekce používá zkratku `05A_OPERATIVNI_PLAN`, zatímco `isGovernedTarget()` povoluje jen canonical cestu.
- Drive queue processor nyní neumí vybrat jeden konkrétní write podle id/markeru; zpracovává lane fronty (`fast`/`bulk`) a vybírá pending položky podle priority.

## Plán implementace

### A. Minimální oprava 05A routingu

- V `karel-did-session-evaluate` změnit generátor 05A projekce tak, aby nově zapisoval přímo canonical target:
  `KARTOTEKA_DID/00_CENTRUM/05A_OPERATIVNI_PLAN`
- Zachovat `write_type = append`, `priority = high` a marker `did_session_review:<review_id>`.
- Nepřidávat široký wildcard allowlist.
- Nepovolovat obecně `05*` ani libovolné `CENTRUM` targety.

Důvod: bezpečnější než rozšiřovat whitelist o alias; nové projekce budou rovnou odpovídat existující governance single source of truth.

### B. Jednorázové narovnání existujícího skipped write

Protože už existuje konkrétní skipped řádek `7ec60cb4-6ec6-425e-89a6-be8ab659eafc`, bude potřeba úzká databázová oprava přes migraci nebo kontrolovaný update v backendovém režimu:

- pouze pro řádek s markerem `did_session_review:a86b7399-aef4-48cf-97c0-58b2c3121e9f`
- nastavit:
  - `target_document = 'KARTOTEKA_DID/00_CENTRUM/05A_OPERATIVNI_PLAN'`
  - `status = 'pending'`
  - `last_error_message = null`
  - `processed_at = null`
  - `next_retry_at = null`
- Neměnit žádné jiné položky fronty.

Poté zkusit zpracovat jen `fast` lane. Pokud by processor neuměl bezpečně izolovat tento jeden write kvůli dalším high/urgent pending položkám, zastavit se a nespouštět hromadné zpracování. V takovém případě doporučený doplněk bude přidat do processoru úzký volitelný filtr `write_id`/marker, ale nepoužít ho bez dalšího schválení.

### C. Zpřesnění `yesterday_session_review` payloadu

V `karel-did-daily-briefing` upravit jen cílenou část pro enrich `yesterday_session_review`:

- načíst k včerejším plánům i odpovídající `did_session_reviews` pro Arthur plán / nejnovější review,
- do payloadu doplnit strojová pole:
  - `review_status: 'partially_analyzed'`
  - `completion: 'partial'`
  - `completed_checklist_count: 1`
  - `total_checklist_count: 5`
  - `evidence_label: '1/5 checklist položek'`
  - `evidence_limited: true`
  - `evidence_limitations: ...`
  - `review_id: 'a86b7399-aef4-48cf-97c0-58b2c3121e9f'`
  - `plan_id: 'e7875027-b101-4690-9224-df0a6ad66770'`
- do textů přidat krátkou explicitní formulaci:
  - `partially_analyzed`
  - `1/5`
  - chybí turn-by-turn data, transcript, observations a part card
  - závěry jsou pracovní / evidence-limited
  - Karel nepředstírá plnou analýzu

Změna bude omezena na briefing payload; žádný redesign výstupu ani nový FACT/INFERENCE model.

### D. Cílená regenerace briefingu 25. 4.

Po úpravách zavolat pouze:

- funkce: `karel-did-daily-briefing`
- `force: true`
- důvod/metoda: `refresh_after_yesterday_session_review_payload_hardening`

Nespouštět:
- `karel-did-session-finalize`
- `karel-did-daily-cycle`
- žádný nový backfill

### E. Ověření výsledku

Ověřit databázově/payloadově:

1. Nejnovější briefing pro `2026-04-25` má `is_stale = false` a nejnovější `generated_at`.
2. Starší briefingy pro `2026-04-25` jsou `is_stale = true` nebo nejsou vybrané jako aktuální.
3. Payload obsahuje `yesterday_session_review`.
4. `review_status = partially_analyzed`.
5. `completed_checklist_count = 1`.
6. `total_checklist_count = 5`.
7. Text obsahuje `1/5`.
8. Text obsahuje evidence-limited / limit validity formulaci.
9. Pro `plan_id = e7875027-b101-4690-9224-df0a6ad66770` existuje stále přesně jedno review.
10. 05A write s markerem `did_session_review:a86b7399-aef4-48cf-97c0-58b2c3121e9f` už není skipped kvůli whitelistu.
11. Pokud se podaří zpracovat 05A write, vypsat jeho nový stav.
12. Pokud se nepodaří, zastavit bez dalších zásahů a uvést přesný důvod.

## Deploy / migrace

- Bude potřeba deploy změněných backendových funkcí, protože se mění `karel-did-session-evaluate` a `karel-did-daily-briefing`.
- Databázová migrace není potřeba pro schéma.
- Pro existující skipped write je potřeba jednorázová úzká oprava konkrétního řádku fronty; bez ní by starý řádek zůstal se špatným targetem a stavem `skipped`.

## Výstup po provedení

Vrátím pouze:

1. co přesně bylo změněno
2. zda byla potřeba úprava whitelistu nebo mappingu
3. jaký canonical target se používá pro 05A
4. stav 05A write po opravě
5. id / generated_at nového briefingu
6. preview `yesterday_session_review`
7. hodnoty `review_status`, `completion`, `completed_checklist_count`, `total_checklist_count`, `evidence_limited`
8. zda nevzniklo duplicitní review
9. co zůstává mimo scope
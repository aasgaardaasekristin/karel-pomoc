
Příčina: předchozí zásah byl opravdu polovičatý — opravil část UI, ale nedotáhl celý řetězec zdroj dat → uložení odpovědi → reaktivní zpracování → propsání do dalšího přehledu.

Co je teď konkrétně nedotažené
1. `KarelDailyPlan.tsx` má stále `deficitQuestions: string[]`; renderuje jen otázku a prázdné pole. Chybí Karlovo uvítání, co ví naposledy, lehký tlak/údiv, vlastní návrh i pomoc pro „nevím“.
2. `saveInlineAnswer()` zapisuje jen do `did_threads` a ještě natvrdo jako `sub_mode: "mamka"`. `karel-reactive-loop` ale `did_threads` nečte; čte `did_pending_questions.status='answered'`, `did_meetings`, `did_conversations`. Inline odpovědi se tedy teď fakticky nepropisují do operativní paměti ani do Drive.
3. `karel-did-meeting/index.ts` při `create` neposílá `user_id`; log potvrzuje chybu `23502 null value in column "user_id"`. Proto porady padají.
4. `karel-crisis-daily-assessment/index.ts` dál ukládá agregované krizové tasky a schovává zakázané Karlovy úkoly do `description`. Role guard je v promptu, ale ne v post-processingu.
5. Deep-linky pro task/question/session v `Chat.tsx` existují. Rozbitá je hlavně větev „Otevřít poradu“ kvůli pádu create flow.

Co opravím
1. Přepíšu informační deficit v `KarelDailyPlan.tsx` na strukturované karty:
   - Karlovo oslovení
   - co ví naposledy + kolik dní uplynulo
   - lehký tlak / motivace / údiv podle prodlevy
   - Karlův konkrétní návrh, co zkontrolovat
   - přesná otázka
   - pomocná věta pro situaci „nevím / nevím jak zjistit“
2. Inline odpovědi napojím na kanonický model `did_pending_questions`, ne na slepé `did_threads`:
   - každá karta bude mít skutečné `questionId`, nebo se otázka nejdřív založí do `did_pending_questions`
   - po odeslání se uloží `answer`, `answered_at`, `answered_by`, `status='answered'`, `processed_by_reactive=false`
   - hned po uložení se spustí reaktivní zpracování, aby se odpověď dostala do operativní paměti a do fronty pro další propsání
3. Doplním okamžitou Karlovu reakci:
   - běžná odpověď: jemné pozitivní potvrzení + „zapracovávám“
   - odpověď typu „nevím / nevím jak“: okamžitá rada od Karla + otevření vhodného workspace s předvyplněným kontextem
4. Opravím `karel-did-meeting/index.ts`:
   - `create` insert dostane `user_id: authResult.user.id`
   - zkontroluji i návazný flow, aby `meeting_topic` skutečně otevřel/ vytvořil poradní prostor bez pádu
5. Zavedu tvrdý role/content guard:
   - v `karel-crisis-daily-assessment` už se Karlova práce nebude ukládat jako terapeutský task ani schovávat do `description`
   - zakázané texty typu „Připrav scénář / Připrav 3 věty / Projdi kartu / Vymysli techniku“ se převedou buď na Karlův interní výstup, nebo na legitimní observační otázku pro terapeutku
   - v `KarelDailyPlan.tsx` přidám druhou vrstvu filtru, aby se podobný text nezobrazil ani když znovu proteče z backendu
6. Zpevním temporální guard v hlavním denním toku:
   - v plánovací části `karel-did-daily-cycle` doplním explicitní „dnešní datum / 5 dní = historické / bez nových dat přepni do režimu naposledy vím…“
   - přidám i post-AI validaci, aby Karel nemohl vydávat staré události za aktuální

Technické detaily
- `src/components/did/KarelDailyPlan.tsx`
  - nahradit `deficitQuestions: string[]` za strukturované objekty
  - rozšířit `InlineQuestionField` o Karlův návrh a pomoc
  - přepsat `saveInlineAnswer()` z insertu do `did_threads` na práci s `did_pending_questions` + okamžité reaktivní zpracování
  - přidat filtr zakázaných tasků před renderem
- `supabase/functions/karel-did-meeting/index.ts`
  - doplnit `user_id`
- `supabase/functions/karel-crisis-daily-assessment/index.ts`
  - oddělit terapeutské otázky/akce od Karlových interních příprav
  - nepřevádět Karlovu práci do `did_therapist_tasks.description`
- `supabase/functions/karel-did-daily-cycle/index.ts`
  - doplnit explicitní temporal/role guard do plánovací větve
  - přidat validaci výstupu před uložením tasků/briefingu

Pořadí
1. Meeting crash (`user_id`)
2. Kanonické ukládání inline odpovědí + okamžité zpracování
3. Přepis informačního deficitu na skutečný Karlův monolog s návrhy
4. Tvrdý role guard v krizovém assessmentu + UI filtr
5. Explicitní temporal guard v denním cyklu

Akceptace
- v Karlově přehledu už nejsou prázdná okna; každá otázka má Karlovo oslovení, poslední známý stav, tlak/motivaci, konkrétní návrh a pomoc pro „nevím“
- inline odpověď nevpadne do slepé větve; vznikne/aktualizuje se `did_pending_questions.status='answered'` a okamžitě se spustí další zpracování
- příští briefing už pracuje s novými odpověďmi
- „Otevřít poradu“ přestane padat na `user_id`
- texty delegující Karlovu práci se neobjeví ani v DB jako terapeutské tasky, ani v dashboardu
- historické události se už nevydávají za aktuální

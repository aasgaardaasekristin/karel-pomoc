Potvrzuji: nalezená hrana je reálná v aktuální podobě triggeru. `canonical_sync_fulfilled=true` dnes může obejít blokaci `program_status='draft'`, protože draft větev je podmíněná `canonical_sync_fulfilled=false`. Oprava má být úzká: hash sync zůstane nutný, ale nebude stačit bez schváleného statusu a `approved_at`.

## Plán opravy

1. Zpřísnit trigger `guard_unsigned_daily_session_plan_start`
   - Přidat samostatnou pozitivní podmínku pro plány s `deliberation_id`, např. `canonical_approval_fulfilled`:

```text
canonical_sync_fulfilled = true
AND effective_program_status IN ('approved', 'ready_to_start', 'in_progress', 'completed')
AND NEW.approved_at IS NOT NULL
```

   - `review_fulfilled` pak bude:

```text
direct_approval_fulfilled OR canonical_approval_fulfilled
```

   - Pro navázané plány bude start povolen jen přes `canonical_approval_fulfilled`, ne přes samotný hash sync.

2. Blokovat draft/revision stavy vždy
   - Upravit negativní větev tak, aby tyto statusy blokovaly start bez ohledu na hash:

```text
effective_program_status IN (
  'draft',
  'in_revision',
  'awaiting_signatures',
  'awaiting_signature',
  'pending_review'
)
```

   - Tím bude platit: hash sync sám o sobě neodemkne draft.

3. Zachovat úzkou kanonickou vazbu
   - Ponechat současné kontroly:
     - porada existuje,
     - `linked_live_session_id` odpovídá `did_daily_session_plans.id`,
     - podpis Hanka existuje,
     - podpis Káťa existuje,
     - `deliberation.status='approved'`,
     - `approval_sync.status='synced'`,
     - `program_draft_hash` sedí,
     - `plan_markdown_hash` sedí.
   - Direct approval cesta zůstane dostupná jen pro plány bez `deliberation_id`.

4. Přidat migrační opravu
   - Vytvořit novou databázovou migraci s `CREATE OR REPLACE FUNCTION public.guard_unsigned_daily_session_plan_start()`.
   - Neměnit široce signoff sync, protože ten už status nastavuje správně; pouze trigger vynutí, že pokud sync někdy selže částečně nebo metadata zůstanou v rozporu, start bude blokován.

5. Ověření / testovací matice
   - Ověřit tyto scénáře:

| Scénář | Očekávání |
|---|---|
| Podepsaná porada + hash sync sedí + `program_status='approved'` + `approved_at` vyplněno | start projde |
| Podepsaná porada + hash sync sedí + `program_status='draft'` | start se zablokuje |
| Podepsaná porada + hash nesedí + `program_status='approved'` | start se zablokuje |
| Cizí/nekanonická porada | start se zablokuje |
| Nepodepsaná porada | start se zablokuje |
| Safety-net / `evidence_limited` / `planned_not_started` evaluace | zůstává funkční |

## Akceptační pravidlo po opravě

Kanonicky navázaný plán smí startovat jen pokud současně platí:

```text
podepsaný 2/2
AND status porady = approved
AND hash synchronizace sedí
AND program_status IN ('approved', 'ready_to_start', 'in_progress', 'completed')
AND approved_at IS NOT NULL
```

Krátce: `canonical_sync_fulfilled=true` bude nutná, ale ne postačující podmínka. Draft zůstane blokovaný i při shodných hashech.
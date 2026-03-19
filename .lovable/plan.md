

## Plán: Samooopravný mechanismus pro denní maily

### Problém
Když denní mail selže ve 14:00 (AI timeout, Resend chyba, Drive token expiry, atd.), nikdo se o tom nedozví a mail se neodešle.

### Řešení: Vícevrstvý auto-retry s diagnostikou

#### 1. Nová edge funkce `karel-did-daily-email-watchdog`
Samostatný "hlídací pes", spouštěný cronem ve 14:30, 15:00 a 15:30 SEČ. Logika:

```text
┌─ Zkontroluj did_daily_report_dispatches pro dnešek
│
├─ Oba "sent"? → hotovo, nic nedělej
│
├─ Někdo "failed" nebo chybí?
│   ├─ Načti error_message z posledního pokusu
│   ├─ Klasifikuj chybu:
│   │   ├─ "Token error" → obnov Google OAuth token, retry
│   │   ├─ "rate_limit" → počkej, retry
│   │   ├─ "AI timeout" → retry s menším kontextem
│   │   ├─ "BOOT_ERROR" → zavolej daily-email (standalone, bez Drive)
│   │   └─ neznámá → zavolej daily-email jako fallback
│   ├─ Zapiš diagnostiku do did_daily_report_dispatches.error_message
│   └─ Proveď retry (max 3 pokusy za den)
│
└─ Zapiš výsledek watchdog běhu do logu
```

#### 2. Strategie oprav podle typu chyby

| Chyba | Automatická oprava |
|-------|-------------------|
| Google OAuth token expired | Refresh token, retry daily-cycle |
| AI generation timeout | Retry s zkráceným kontextem (half data) |
| Resend API error / rate limit | Retry po 30 min (catchup cron) |
| BOOT_ERROR (funkce spadla) | Přepnout na standalone daily-email (bez Drive) |
| Neznámá chyba | Fallback: odeslat raw data jako plain-text email |

#### 3. Fallback řetězec
1. **Pokus 1** (14:00): Plný daily-cycle s AI generováním
2. **Pokus 2** (14:30): Watchdog detekuje selhání → retry daily-cycle
3. **Pokus 3** (15:00): Watchdog → zavolá standalone daily-email (jen DB data, bez Drive)
4. **Pokus 4** (15:30): Watchdog → odešle nouzový plain-text email s raw daty

#### 4. Sledování pokusů
Rozšíření tabulky `did_daily_report_dispatches`:
- `retry_count` (integer, default 0) — počet pokusů
- `last_retry_strategy` (text) — jaká strategie byla použita
- `watchdog_log` (text) — diagnostický zápis watchdogu

#### 5. Cron joby
- `did-email-watchdog-1430` → 12:30 UTC (14:30 SEČ)
- `did-email-watchdog-1500` → 13:00 UTC (15:00 SEČ)  
- `did-email-watchdog-1530` → 13:30 UTC (15:30 SEČ)

#### 6. Diagnostický panel (součást předchozího plánu)
Tab "📧 Reporty" v DidSprava zobrazí:
- Stav dispatche za posledních 14 dní
- Počet retry pokusů a strategie
- Chybové zprávy a watchdog logy
- Cílové adresy

### Soubory k vytvoření/úpravě
- **Nový**: `supabase/functions/karel-did-daily-email-watchdog/index.ts`
- **Migrace**: přidat sloupce `retry_count`, `last_retry_strategy`, `watchdog_log` do `did_daily_report_dispatches`
- **Nový**: `src/components/did/DidReportDiagnostics.tsx`
- **Upravit**: `src/components/did/DidSprava.tsx` — přidat tab "Reporty"
- **Cron**: 3 nové pg_cron joby pro watchdog

### Výsledek
Karel se pokusí odeslat mail ve 14:00. Pokud selže, watchdog automaticky diagnostikuje problém, zvolí opravu a zkusí znovu. Maximálně 4 pokusy do 15:30. Každý pokus je zalogován s důvodem selhání a zvolenou strategií. Uživatel vidí kompletní historii v diagnostickém panelu.


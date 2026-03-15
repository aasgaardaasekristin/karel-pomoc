

# Oprava cron jobu `karel-daily-consolidation`

## Problém
Cron job používá neexistující funkci `extensions.http_post()` místo správné `net.http_post()`. Proto ranní konsolidace + zrcadlení do Drive nikdy neproběhly.

## Oprava

Jediný krok — SQL příkaz přes insert tool:

1. **Smazat starý cron job** a vytvořit nový se správnou syntaxí `net.http_post()`:

```sql
SELECT cron.unschedule('karel-daily-consolidation');

SELECT cron.schedule(
  'karel-daily-consolidation',
  '0 5 * * *',
  $$
  SELECT net.http_post(
    url := 'https://wpscavufytwucqemawwv.supabase.co/functions/v1/karel-daily-consolidation',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indwc2NhdnVmeXR3dWNxZW1hd3d2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAxMzM3MTIsImV4cCI6MjA4NTcwOTcxMn0.ILGYK4GRfoMwE7TBTx9_6syIyUZ-OA2q1Km-sc6JMxY"}'::jsonb,
    body := '{"source":"cron"}'::jsonb
  ) AS request_id;
  $$
);
```

Žádné změny v kódu edge function ani v UI. Pouze oprava SQL definice cron jobu.

## Vedlejší problém v logu

`karel-did-drive-read` hlásí chybu 400 při čtení Excel souboru `01_Index_Vsech_Casti` — to je samostatný problém s Google Drive API (možná expirovaný token nebo špatné file ID), ale nesouvisí s cron jobem.


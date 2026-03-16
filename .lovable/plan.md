

## Aktualizace Google Refresh Tokenu

Máš nový platný refresh token:
`1//04MJ6C2ijiuovCgYIARAAGAQSNwF-L9IreGFL40jrI-CnUUePgvuTMIS40JT9niMoHy84rU2UeAfxWOsMic6GgkriEX7ttP2cQuE`

### Co udělám
1. Aktualizuji secret `GOOGLE_REFRESH_TOKEN` na novou hodnotu
2. Otestuji, že Drive funkce fungují (přístup ke složkám kartoteka_DID, PAMET_KAREL, ZALOHA)

### Co se tím opraví
- Denní reporty (14:00 CET) – blokované od 14. března
- Všechny Drive operace (čtení karet, zápisy, zálohy)
- Automatické cykly (denní, týdenní, měsíční)

### Bezpečnostní poznámka
Tvůj Client Secret (`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`) je viditelný v tom HTTP výpisu. Není to kritické (je uložený v backend secretech), ale příště ho raději nesdílej v chatu – stačí jen ten refresh token.


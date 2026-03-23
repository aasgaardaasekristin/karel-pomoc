

# Oprava: Uložená analýza se nezobrazí v záložce Karta

## Příčina
`CardAnalysisPanel` uloží analýzu do DB, ale `clientAnalyses` state v `Kartoteka.tsx` se neaktualizuje — načte se jen při `selectClient()`. Po uložení se stav v paměti nezmění, takže v záložce Karta nic nepřibude, dokud uživatel znovu nevybere klienta.

## Řešení

### 1. `CardAnalysisPanel.tsx` — přidat callback `onAnalysisSaved`
- Přidat nový prop `onAnalysisSaved?: (analysis: any) => void`
- Po úspěšném insertu zavolat `onAnalysisSaved` s uloženým objektem (včetně `id`, `created_at`, `version`, `content`, `sessions_count`)

### 2. `Kartoteka.tsx` — propojit callback a refreshnout state
- Předat `CardAnalysisPanel` nový prop `onAnalysisSaved`
- V handleru přidat novou analýzu do `clientAnalyses` state na začátek pole

## Soubory
- `src/components/report/CardAnalysisPanel.tsx` — nový prop + volání callbacku
- `src/pages/Kartoteka.tsx` — předání callbacku a update stavu


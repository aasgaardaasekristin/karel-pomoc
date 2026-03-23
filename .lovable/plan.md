

# Tlačítko „Uložit do karty" + mazání analýz

## Problém
1. Analýza se ukládá automaticky na pozadí — uživatel neví, že se uložila, a nemá kontrolu
2. V záložce Karta chybí možnost smazat uloženou analýzu

## Řešení

### 1. `CardAnalysisPanel.tsx` — explicitní tlačítko „Uložit do karty"
- Odstranit fire-and-forget auto-save z `handleAnalyze` (řádky 99-118)
- Po vygenerování výsledku zobrazit pod taby tlačítko **„💾 Uložit do karty"**
- Po kliknutí: insert do `client_analyses`, toast „Analýza uložena do karty", tlačítko se změní na **„✅ Uloženo"** (disabled)
- Nový state: `savedToCard: boolean` — resetuje se při nové analýze

### 2. `Kartoteka.tsx` — tlačítko smazat u každé analýzy
- V každém accordion itemu (řádek 690-769) přidat do headeru ikonu 🗑 (Trash2)
- Klik → confirm dialog → `supabase.from("client_analyses").delete().eq("id", a.id)`
- Po smazání: odebrat z `clientAnalyses` state

## Soubory
- `src/components/report/CardAnalysisPanel.tsx` — save button místo auto-save
- `src/pages/Kartoteka.tsx` — delete button u analýz


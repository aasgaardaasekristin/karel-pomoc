

# Přidání ThemeQuickButton na všechna chybějící místa

## Problém
ThemeQuickButton chybí na mnoha obrazovkách – Hub, DID vstupní obrazovka, DID terapeut dashboard, PIN obrazovky, seznamy vláken (terapeut i Kluci), porady týmu, a celý Research režim.

## Plán úprav

### 1. `src/pages/Hub.tsx`
Přidat ThemeQuickButton do headeru vedle "Odejít" tlačítka.

### 2. `src/components/did/DidEntryScreen.tsx`
Přidat ThemeQuickButton vedle "Zpět na výběr režimu" tlačítka.

### 3. `src/components/did/DidContentRouter.tsx` (terapeut view, ~ř. 200-258)
Přidat ThemeQuickButton do terapeut dashboard view, vedle "← Zpět" nebo do hlavičky sekce.

### 4. `src/components/did/DidPinEntry.tsx`
Přidat ThemeQuickButton vedle "Zpět" tlačítka nahoře.

### 5. `src/components/did/DidTherapistThreads.tsx`
Přidat ThemeQuickButton do hlavičky vedle "Příprava na sezení" a "Nové téma".

### 6. `src/components/did/DidThreadList.tsx`
Přidat ThemeQuickButton do hlavičky vedle "+ Nové vlákno".

### 7. `src/components/did/DidMeetingPanel.tsx`
Přidat ThemeQuickButton do hlavičky panelu porad.

### 8. `src/pages/Chat.tsx` – Research thread list (~ř. 1448-1461)
Přidat ThemeQuickButton nad ResearchThreadList.

### 9. `src/pages/Chat.tsx` – Research chat view (~ř. 1480-1518)
Přidat ThemeQuickButton do toolbaru vedle "Příručka (PDF)" a "← Vlákna".

## Soubory k úpravě (7)
1. `src/pages/Hub.tsx`
2. `src/components/did/DidEntryScreen.tsx`
3. `src/components/did/DidContentRouter.tsx`
4. `src/components/did/DidPinEntry.tsx`
5. `src/components/did/DidTherapistThreads.tsx`
6. `src/components/did/DidThreadList.tsx`
7. `src/components/did/DidMeetingPanel.tsx`
8. `src/pages/Chat.tsx`

## Co se NEMĚNÍ
- ThemeEditorDialog, ThemeQuickButton komponenta, ThemeContext
- Stávající umístění (HanaChat, Kartoteka, LiveSessionPanel, DID chat view)


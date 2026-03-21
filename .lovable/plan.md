

# Propojení "Zahájit sezení" s živou asistencí Karla

## Co se změní

Klik na "Zahájit sezení" v plánu dne otevře plnohodnotný živý chat s Karlem (`DidLiveSessionPanel`), který:
- Zná plán sezení a kontext části
- V reálném čase radí terapeutce jak reagovat
- Umožní nahrát audio segment k okamžité analýze (tón, emoce, switching)
- **Nově**: umožní vyfotit/nahrát obrázek (kresbu, výraz, situaci) k okamžité analýze
- Po ukončení vygeneruje kompletní klinický zápis a automaticky ho uloží na Drive

## Plán implementace

### 1. Přidat stav `liveSessionActive` do DidDailySessionPlan
- Když `true`, místo plánu se zobrazí `DidLiveSessionPanel`
- Tlačítko "Zahájit sezení" provede stávající DB logiku (záznam + registry update) a pak přepne na live panel
- Props: `partName` = `plan.selected_part`, `therapistName` = `plan.therapist`, `contextBrief` = `plan.plan_markdown`
- `onEnd(summary)` → provede stávající `endSession` logiku (Drive write + status update) + uloží `ai_analysis` do session záznamu
- `onBack` → vrátí se zpět do plánu bez ukončení

### 2. Přidat podporu obrázků do DidLiveSessionPanel
- Integrace `useImageUpload` hooku (už existuje)
- Tlačítko 📷 vedle nahrávání audia
- Po výběru obrázku: náhled + tlačítko "Analyzovat"
- Odeslání přes `karel-analyze-file` edge funkci (už existuje) s DID kontextem
- Analýza se zobrazí jako zpráva v chatu (stejný pattern jako audio segmenty)

### 3. Rozšířit auto-greet zprávu
- Zmínit možnost nahrát fotku/obrázek k analýze

## Technické detaily

**Soubory k úpravě:**
- `src/components/did/DidDailySessionPlan.tsx` — přidat `liveSessionActive` stav, import `DidLiveSessionPanel`, podmíněné renderování
- `src/components/did/DidLiveSessionPanel.tsx` — přidat `useImageUpload`, tlačítko pro fotku, handler `handleImageAnalysis`

**Žádné nové edge funkce ani DB migrace** — vše využívá existující infrastrukturu (`karel-analyze-file`, `karel-chat`, `useImageUpload`, `useSessionAudioRecorder`).


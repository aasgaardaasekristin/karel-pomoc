

# Oprava Asistence – chat, obrázky, audio, session sync

## Shrnutí problémů
1. **Obrázky nefungují**: `handleFileChange(e)` resetuje input PŘED přečtením souboru → `e.target.files?.[0]` je `undefined`. Navíc payload má špatná pole (`data` místo `dataUrl`, chybí `category`/`size`).
2. **Chat nereaguje**: `activeSessionId` může být `null`, `updateChatMessages(null!, ...)` tiše selže.
3. **Audio analýza**: výsledek se zobrazí v chatu, ale Karel na něj nenavazuje radou.
4. **Streaming race condition**: `updateSession` čte stale `sessions` z closure.

---

## Změny

### 1. `src/contexts/ActiveSessionsContext.tsx`
- Přepsat `updateSession` na funkční formu `setSessions(prev => ...)` + přímý `saveSessions` z nového stavu
- Tím se odstraní stale closure problém při streamingu

### 2. `src/components/report/LiveSessionPanel.tsx`

**A) Self-heal session + guard**
- Přidat `useEffect` který při mountu/změně zjistí jestli `activeSession?.clientId === clientId`, pokud ne → najde správnou session nebo vytvoří novou
- V `sendMessage` přidat guard: pokud `activeSessionId` je null → `toast.error` + `console.error` + return

**B) Extrahovat `requestLiveReply(messagesForAI)` helper**
- Společná funkce pro streaming odpověď z `karel-chat`
- Volána z: `sendMessage`, po audio analýze, po image analýze
- Eliminuje duplicitu a zajistí že Karel VŽDY navazuje

**C) Oprava obrázků (řádky 515-565)**
- `const file = e.target.files?.[0]` jako PRVNÍ řádek
- Pak teprve reset: `if (fileInputRef.current) fileInputRef.current.value = ""`
- NEPOUŽÍVAT `handleFileChange(e)` (resetuje input)
- Opravit payload: `dataUrl` místo `data`, přidat `category: "image"`, `size: file.size`
- Po analýze: vložit analýzu do chatu + zavolat `requestLiveReply()` pro Karlovu radu

**D) Oprava audia (řádky 184-231)**
- Po úspěšné analýze zavolat `requestLiveReply()` aby Karel navázal radou v chatu

**E) Greeting efekt**
- Rozšířit dependency array o `activeSession`, `sessionMode` aby se greeting vytvořil i když session přijde se zpožděním
- Přidat guard proti duplicitě (pokud `messages.length > 0`)

**F) Debug mount log** (ponechat)

### 3. `src/pages/Kartoteka.tsx`
- Přidat synchronizaci při změně klienta: pokud `activeTab === "assistance"` a `selectedClient` se změní → aktivovat správnou session

---

## Co se NEMĚNÍ
- Backend edge funkce (karel-audio-analysis, karel-analyze-file, karel-chat)
- ChatMessage komponenta
- Datový model ActiveSessionsContext

## Výsledek
- Šipka v chatu → Karel odpovídá
- Kresba/Rukopis/Foto → upload + analýza + Karel naváže radou
- Audio → analýza v chatu + Karel naváže radou
- Chybějící session → toast s chybou
- Přepnutí klienta → správná session automaticky


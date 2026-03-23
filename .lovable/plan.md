

# Oprava + Upload médií pro SessionIntakePanel

## 1. DB migrace — tabulka `session_media` + bucket `session-media`

```sql
CREATE TABLE session_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  user_id uuid NOT NULL DEFAULT auth.uid(),
  session_date date NOT NULL DEFAULT CURRENT_DATE,
  media_type text NOT NULL,
  storage_path text NOT NULL,
  original_filename text,
  ai_analysis jsonb,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE session_media ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users own media" ON session_media FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

INSERT INTO storage.buckets (id, name, public) VALUES ('session-media', 'session-media', false);
CREATE POLICY "Auth upload session media" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'session-media');
CREATE POLICY "Auth read session media" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'session-media');
CREATE POLICY "Auth delete session media" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'session-media');
```

## 2. Nový komponent `SessionMediaUpload.tsx`

Tři upload karty (audio / obrázky / rukopis):
- Drag & drop + file input pro každý typ
- Validace: audio max 100MB (mp3/m4a/wav/ogg/webm/aac/mp4), obrázky max 10 (jpg/png/heic/webp), rukopis max 5 (jpg/png/pdf)
- Upload do `session-media` bucketu: `{clientId}/{sessionDate}/{type}_{i}_{timestamp}.{ext}`
- Po uploadu volání AI analýzy:
  - **Audio**: volání `karel-session-intake` s `audioBase64` + `inputType: "audio"` pro přepis (stejný pattern jako live)
  - **Obrázky**: volání `karel-analyze-file` s attachments obsahujícím `dataUrl` + userPrompt pro terapeutickou vizuální analýzu
  - **Rukopis**: volání `karel-analyze-file` s dvouvrstvým userPrompt (obsah + grafologie — tlak pera, sklon, velikost, mezery, tvar, spojitost, pravidelnost)
- Uložení záznamu do `session_media` tabulky (client_id, media_type, storage_path, ai_analysis)
- Thumbnail preview pro obrázky, výsledky analýzy pod každým souborem
- Callback `onMediaContext(text)` předá agregované analýzy rodiči

`karel-analyze-file` již existuje a přijímá `attachments` array s `dataUrl`/`storagePath` + `userPrompt`. Bude použita přímo — není třeba vytvářet novou funkci.

## 3. Oprava SessionIntakePanel.tsx — čistá obrazovka po uložení

Řádek 232: místo `onComplete()` → `setSessionCompleted(true)` + reset stavů.

Nové stavy:
- `sessionCompleted: boolean`
- `mediaContext: string` (z SessionMediaUpload)

Pokud `sessionCompleted`:
- Zobrazit ✅ "Záznam uložen a analyzován"
- Tlačítko "Zaznamenat nové sezení" → reset všech stavů (sessionCompleted, result, textInput, mediaContext, inputMode → "choose")
- Tlačítko "Zpět na přehled klienta" → `onComplete()`

## 4. Integrace uploadu do SessionIntakePanel

- `<SessionMediaUpload>` vložen pod input selection (viditelný v text i audio režimu)
- `mediaContext` state — text z médií
- V `handleSubmit`: přidat `mediaContext` do body

## 5. Rozšíření `karel-session-intake`

Řádek 26: destructure `mediaContext` z body.
Pokud existuje, přidat do `userContent`:
```
{ type: "text", text: "📎 ANALÝZY MÉDIÍ ZE SEZENÍ:\n" + mediaContext }
```

## Soubory

1. **DB migrace** — tabulka + bucket
2. **`src/components/report/SessionMediaUpload.tsx`** (nový)
3. **`src/components/report/SessionIntakePanel.tsx`** — sessionCompleted + media integrace
4. **`supabase/functions/karel-session-intake/index.ts`** — mediaContext field

## Co se NEZMĚNÍ
- Stávající live audio nahrávání
- Drive write logika
- `karel-analyze-file` edge funkce (použita as-is)
- Core logika `karel-session-intake` (jen přidán mediaContext)


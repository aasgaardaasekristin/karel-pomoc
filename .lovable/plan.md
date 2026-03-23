

# Persistentní ukládání 3 typů dat v kartě klienta

## DB migrace

3 nové tabulky s RLS policies + storage bucket:

```sql
-- client_analyses
CREATE TABLE client_analyses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE NOT NULL,
  user_id UUID NOT NULL DEFAULT auth.uid(),
  created_at TIMESTAMPTZ DEFAULT now(),
  version INT DEFAULT 1,
  content TEXT NOT NULL,
  summary TEXT
);
ALTER TABLE client_analyses ENABLE ROW LEVEL SECURITY;
-- RLS: authenticated users CRUD own rows (user_id = auth.uid())

-- session_preparations
CREATE TABLE session_preparations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE NOT NULL,
  user_id UUID NOT NULL DEFAULT auth.uid(),
  session_number INT,
  created_at TIMESTAMPTZ DEFAULT now(),
  plan JSONB NOT NULL,
  approved_at TIMESTAMPTZ,
  notes TEXT
);
ALTER TABLE session_preparations ENABLE ROW LEVEL SECURITY;

-- session_materials
CREATE TABLE session_materials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE NOT NULL,
  user_id UUID NOT NULL DEFAULT auth.uid(),
  session_id UUID REFERENCES client_sessions(id),
  session_number INT,
  created_at TIMESTAMPTZ DEFAULT now(),
  material_type TEXT NOT NULL,
  label TEXT,
  storage_url TEXT NOT NULL,
  analysis TEXT,
  tags TEXT[]
);
ALTER TABLE session_materials ENABLE ROW LEVEL SECURITY;

-- Storage bucket
INSERT INTO storage.buckets (id, name, public) VALUES ('session-materials', 'session-materials', true);
-- Storage RLS for authenticated upload + public read
```

## Kód — 4 soubory

### 1. `CardAnalysisPanel.tsx` — auto-save po analýze
- Po úspěšné analýze (`handleAnalyze`): insert do `client_analyses` s `content: JSON.stringify(result)`, `summary: result.clientProfile?.slice(0,200)`, `version: count+1`
- Fire-and-forget, bez blokování UI

### 2. `ClientSessionPrepPanel.tsx` — save po schválení + sekce uložených příprav
- V `handleApprove`: insert do `session_preparations` s `plan, session_number, approved_at`
- Nahoře v idle stavu: načíst existující přípravy pro klienta
- Zobrazit jako seznam "Příprava č. X – datum" s tlačítky [Použít] a [🗑]
- [Použít] nastaví plan do stavu review, [🗑] smaže z DB s confirm

### 3. `LiveSessionPanel.tsx` — upload materiálů do Storage + DB
- V `handleImageAnalysis` po úspěšné analýze:
  1. Upload souboru do `session-materials/{clientId}/{timestamp}_{filename}`
  2. Insert do `session_materials` s `material_type` (mapovaný z imageAnalysisType), `storage_url`, `analysis`

### 4. `Kartoteka.tsx` — 2 nové sekce v záložce Karta + materiály v Sezení
- Záložka Karta: pod stávajícím obsahem přidat:
  - **"Analýzy karty"**: fetch `client_analyses` pro klienta, zobrazit jako Accordion seznam, nejnovější rozbalená
  - **"Materiály ze sezení"**: fetch `session_materials`, seskupit dle session_number, zobrazit s lightbox dialogem a rozbalitelnou analýzou
- Záložka Sezení: u každého sezení načíst `session_materials` a zobrazit "📎 Materiály (N)"

## Co se NEMĚNÍ
- Žádné edge funkce
- Existující layout záložek
- client_sessions tabulka


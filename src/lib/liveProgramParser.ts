/**
 * liveProgramParser
 * -----------------
 * Robustní parser schváleného programu sezení, který přežije:
 *   1) **kanonický markdown** — sekce `## Program sezení` + očíslované body
 *      `1. **Block** (8 min)\n   detail`
 *   2) **JSON-array fallback** — pokud se do `plan_markdown` propsal surový
 *      JSON dump bloků (viz historický bug v `sync_and_start_approved_daily_plan`,
 *      který ukládal `# Schválený plán z týmové porady\n\n[{...}]`)
 *   3) **starší heading formát** — `### 1. **Úvod...**` se 2-řádkovým detailem
 *      pod ním (formát z dubnových plánů)
 *
 * Vrací pole textových bulletů ve formátu `Title — detail` (max 12).
 * Když nenajde žádný validní bod, vrátí prázdné pole — UI musí v tomto
 * případě zobrazit explicitní error state, NE tichý fallback string.
 *
 * BLOKER PRINCIP: "Bezformátový program — sleduj plán v chatu" NENÍ
 * akceptovatelný fallback, ale failure state.
 */

const MAX_BULLETS = 12;
const MIN_TITLE_LEN = 3;

/** Stripuje markdown bold/italic/whitespace z textu */
function cleanInline(text: string): string {
  return text
    .replace(/\*\*/g, "")
    .replace(/__/g, "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Z bloku JSON objektu vyrobí jednu textovou položku ve formátu `Title — detail`. */
function blockToBullet(block: unknown): string | null {
  if (!block || typeof block !== "object") return null;
  const b = block as Record<string, unknown>;
  const titleRaw =
    (typeof b.block === "string" && b.block) ||
    (typeof b.title === "string" && b.title) ||
    "";
  const title = cleanInline(String(titleRaw));
  if (title.length < MIN_TITLE_LEN) return null;

  const minutesRaw = b.minutes;
  let minutesStr = "";
  if (typeof minutesRaw === "number" && Number.isFinite(minutesRaw) && minutesRaw > 0) {
    minutesStr = ` (${minutesRaw} min)`;
  } else if (typeof minutesRaw === "string" && /^\d+$/.test(minutesRaw.trim())) {
    minutesStr = ` (${minutesRaw.trim()} min)`;
  }

  const detailRaw =
    (typeof b.detail === "string" && b.detail) ||
    (typeof b.clinical_intent === "string" && b.clinical_intent) ||
    (typeof b.playful_form === "string" && b.playful_form) ||
    (typeof b.script === "string" && b.script) ||
    "";
  const detail = cleanInline(String(detailRaw));

  return detail ? `${title}${minutesStr} — ${detail}` : `${title}${minutesStr}`;
}

/**
 * Pokus #1: standardní markdown s `## Program sezení` + bullety
 * (`-`, `*`, `•`, `1.`, `1)` …).
 *
 * Pokus #2 (rozšíření oproti staré logice): tolerujeme i `# Program sezení`,
 * `### Program sezení` a podobné varianty heading levelu.
 */
function parseMarkdownProgramSection(md: string): string[] {
  if (!md) return [];
  const lines = md.split(/\r?\n/);
  const bullets: string[] = [];
  let inProgramSection = false;
  let bulletBlockStarted = false;

  // Tolerantní: jakýkoli heading level + volitelné emoji před názvem.
  const sectionRe = /^#{1,6}\s+(?:[^\w\s]+\s*)?program\s+sezen[ií]\s*$/i;
  const bulletRe = /^\s*(?:[-*•]|\d+[.)])\s+(.+)$/;

  for (const raw of lines) {
    const line = raw.replace(/\u00A0/g, " ").trimEnd();

    if (sectionRe.test(line)) {
      inProgramSection = true;
      bulletBlockStarted = false;
      continue;
    }

    // Konec programové sekce = další heading stejné nebo vyšší úrovně
    if (inProgramSection && /^#{1,6}\s+/.test(line) && !sectionRe.test(line)) {
      break;
    }

    if (!inProgramSection) continue;

    const m = bulletRe.exec(line);
    if (m) {
      const text = cleanInline(m[1]);
      if (text.length >= MIN_TITLE_LEN) {
        bullets.push(text);
        bulletBlockStarted = true;
      }
      continue;
    }

    // Indentovaný řádek = pokračování posledního bulletu jako detail
    if (bullets.length > 0 && /^\s{2,}\S/.test(raw)) {
      const cont = cleanInline(line);
      if (cont) {
        // Přidej jen pokud tam ještě není " — " separátor
        if (!bullets[bullets.length - 1].includes(" — ")) {
          bullets[bullets.length - 1] = `${bullets[bullets.length - 1]} — ${cont}`;
        } else {
          bullets[bullets.length - 1] = `${bullets[bullets.length - 1]} ${cont}`;
        }
      }
      continue;
    }

    if (line === "") {
      // Prázdné řádky uvnitř programové sekce neukončují parsing —
      // očíslované bloky bývají oddělené prázdným řádkem.
      continue;
    }

    // Neprázdný, ne-bullet, ne-indented řádek po startu = konec sekce.
    if (bulletBlockStarted) break;
  }

  return bullets;
}

/**
 * Pokus #3: pokud markdown obsahuje JSON pole bloků (rozbitý sync z DB
 * historicky ukládal `# Schválený plán z týmové porady\n\n[{...}]`),
 * zkus ho rozparsovat a vyrobit bullety přímo z bloků.
 */
function parseJsonArrayFallback(md: string): string[] {
  if (!md) return [];
  // Najdi první `[` a poslední `]` — defenzivně, kdyby kolem něj bylo
  // markdown wrapping. JSON.parse selže na nevalidu, to je v pořádku.
  const openIdx = md.indexOf("[");
  const closeIdx = md.lastIndexOf("]");
  if (openIdx < 0 || closeIdx <= openIdx) return [];
  const slice = md.slice(openIdx, closeIdx + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const bullets: string[] = [];
  for (const item of parsed) {
    const bullet = blockToBullet(item);
    if (bullet) bullets.push(bullet);
    if (bullets.length >= MAX_BULLETS) break;
  }
  return bullets;
}

/**
 * Pokus #4: starší formát kde každý blok je vlastní heading
 * `### 1. **Úvod a naladění (10 min)**` s odsazenými detaily pod ním.
 */
function parseHeadingPerBlock(md: string): string[] {
  if (!md) return [];
  const lines = md.split(/\r?\n/);
  const bullets: string[] = [];
  // ### 1. **Title** ... | ### **1. Title** ... | ### 1) Title
  const headingRe = /^#{2,6}\s+(?:\*+)?\s*\d+\s*[.)]\s*(?:\*+)?\s*(.+?)\s*$/;
  let lastDetail: string[] = [];

  const flush = (titleRaw: string) => {
    const title = cleanInline(titleRaw);
    if (title.length < MIN_TITLE_LEN) return;
    const detail = lastDetail.join(" ").trim();
    bullets.push(detail ? `${title} — ${detail}` : title);
  };

  let pendingTitle: string | null = null;
  for (const raw of lines) {
    const line = raw.replace(/\u00A0/g, " ").trim();
    const h = headingRe.exec(line);
    if (h) {
      if (pendingTitle !== null) flush(pendingTitle);
      pendingTitle = h[1];
      lastDetail = [];
      continue;
    }
    if (pendingTitle !== null) {
      // Sbírej první 1-2 informativní řádky jako detail (preferuj řádky
      // začínající `*   **Technika:**` / `Cíl:` / souvislou větu).
      if (line.length > 0 && lastDetail.length < 2) {
        // Strip leading bullet markers + bold
        const cleaned = cleanInline(line.replace(/^[-*•]\s*/, ""));
        if (cleaned.length > 0) lastDetail.push(cleaned);
      }
    }
    if (bullets.length >= MAX_BULLETS) break;
  }
  if (pendingTitle !== null) flush(pendingTitle);
  return bullets;
}

/**
 * Hlavní vstupní bod. Pokouší se v pořadí:
 *   1) standardní markdown sekce `## Program sezení`
 *   2) JSON-array fallback (rozbitý DB sync)
 *   3) per-heading formát `### 1. **...**`
 *
 * Vrací max `MAX_BULLETS` bulletů. Když nic nenajde → prázdné pole
 * (UI MUSÍ zobrazit error state, ne tichý fallback).
 */
export function parseProgramBullets(md: string): string[] {
  if (!md || typeof md !== "string") return [];

  let bullets = parseMarkdownProgramSection(md);
  if (bullets.length > 0) return bullets.slice(0, MAX_BULLETS);

  bullets = parseJsonArrayFallback(md);
  if (bullets.length > 0) return bullets.slice(0, MAX_BULLETS);

  bullets = parseHeadingPerBlock(md);
  if (bullets.length > 0) return bullets.slice(0, MAX_BULLETS);

  return [];
}

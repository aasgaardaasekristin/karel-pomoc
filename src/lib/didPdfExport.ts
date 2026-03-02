import jsPDF from "jspdf";
import { autoTable } from "jspdf-autotable";
import { supabase } from "@/integrations/supabase/client";
import { getAuthHeaders } from "@/lib/auth";

interface PartActivity {
  name: string;
  lastSeen: string | null;
  status: "active" | "sleeping" | "warning";
}

const STATUS_LABELS: Record<string, string> = {
  active: "Aktivní",
  sleeping: "Spí",
  warning: "Neaktivní 7+ dní",
};

const formatDate = (isoStr: string | null) => {
  if (!isoStr) return "—";
  return new Date(isoStr).toLocaleDateString("cs-CZ", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

// ── Helper: add wrapped text and auto-paginate ──
function addWrappedText(doc: jsPDF, text: string, x: number, y: number, maxWidth: number, lineHeight = 5): number {
  const lines = doc.splitTextToSize(text, maxWidth);
  for (const line of lines) {
    if (y > doc.internal.pageSize.getHeight() - 15) {
      doc.addPage();
      y = 20;
    }
    doc.text(line, x, y);
    y += lineHeight;
  }
  return y;
}

// ══════════════════════════════════════════════
// generateDidReport — existing DID system report
// ══════════════════════════════════════════════

export async function generateDidReport(): Promise<void> {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 15;
  let y = 20;

  doc.setFontSize(20);
  doc.setTextColor(60, 80, 60);
  doc.text("DID Systém – Report", pageWidth / 2, y, { align: "center" });
  y += 8;

  doc.setFontSize(10);
  doc.setTextColor(120, 120, 120);
  doc.text(`Vygenerováno: ${formatDate(new Date().toISOString())}`, pageWidth / 2, y, { align: "center" });
  y += 12;

  doc.setFontSize(14);
  doc.setTextColor(40, 60, 40);
  doc.text("1. Přehled částí systému", margin, y);
  y += 8;

  const { data: threads } = await supabase
    .from("did_threads")
    .select("part_name, last_activity_at")
    .eq("sub_mode", "cast")
    .order("last_activity_at", { ascending: false });

  const parts: PartActivity[] = [];
  if (threads) {
    const partMap = new Map<string, string>();
    for (const t of threads) {
      if (!partMap.has(t.part_name)) partMap.set(t.part_name, t.last_activity_at);
    }
    const now = Date.now();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    const oneDay = 24 * 60 * 60 * 1000;
    for (const [name, lastSeen] of partMap.entries()) {
      const diff = now - new Date(lastSeen).getTime();
      let status: PartActivity["status"] = "sleeping";
      if (diff < oneDay) status = "active";
      else if (diff > sevenDays) status = "warning";
      parts.push({ name, lastSeen, status });
    }
  }

  if (parts.length > 0) {
    autoTable(doc, {
      startY: y,
      head: [["Část", "Stav", "Poslední aktivita"]],
      body: parts.map(p => [p.name, STATUS_LABELS[p.status] || p.status, formatDate(p.lastSeen)]),
      styles: { fontSize: 9, cellPadding: 3 },
      headStyles: { fillColor: [90, 120, 90], textColor: 255, fontStyle: "bold" },
      alternateRowStyles: { fillColor: [245, 245, 240] },
      margin: { left: margin, right: margin },
    });
    y = (doc as any).lastAutoTable.finalY + 10;
  } else {
    doc.setFontSize(10);
    doc.setTextColor(150, 150, 150);
    doc.text("Zatím žádné záznamy o částech.", margin, y);
    y += 10;
  }

  if (y > 250) { doc.addPage(); y = 20; }
  doc.setFontSize(14);
  doc.setTextColor(40, 60, 40);
  doc.text("2. Historie synchronizačních cyklů", margin, y);
  y += 8;

  const { data: cycles } = await supabase
    .from("did_update_cycles")
    .select("cycle_type, status, completed_at, report_summary")
    .order("completed_at", { ascending: false })
    .limit(15);

  if (cycles && cycles.length > 0) {
    autoTable(doc, {
      startY: y,
      head: [["Typ", "Stav", "Dokončeno", "Souhrn"]],
      body: cycles.map(c => [
        c.cycle_type === "daily" ? "Denní" : c.cycle_type === "weekly" ? "Týdenní" : c.cycle_type,
        c.status === "completed" ? "✓" : c.status,
        formatDate(c.completed_at),
        (c.report_summary || "—").slice(0, 80),
      ]),
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [90, 120, 90], textColor: 255, fontStyle: "bold" },
      alternateRowStyles: { fillColor: [245, 245, 240] },
      columnStyles: { 3: { cellWidth: 60 } },
      margin: { left: margin, right: margin },
    });
    y = (doc as any).lastAutoTable.finalY + 10;
  }

  if (y > 230) { doc.addPage(); y = 20; }
  doc.setFontSize(14);
  doc.setTextColor(40, 60, 40);
  doc.text("3. Analýza vzorců (AI)", margin, y);
  y += 8;

  try {
    const headers = await getAuthHeaders();
    const patternRes = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-patterns`,
      { method: "POST", headers, body: JSON.stringify({}) }
    );
    if (patternRes.ok) {
      const patternData = await patternRes.json();
      if (patternData.summary) {
        doc.setFontSize(10);
        doc.setTextColor(60, 60, 60);
        const summaryLines = doc.splitTextToSize(patternData.summary, pageWidth - 2 * margin);
        doc.text(summaryLines, margin, y);
        y += summaryLines.length * 5 + 5;
      }
      if (patternData.alerts?.length > 0) {
        if (y > 250) { doc.addPage(); y = 20; }
        doc.setFontSize(11);
        doc.setTextColor(180, 80, 40);
        doc.text("Upozornění:", margin, y);
        y += 6;
        for (const alert of patternData.alerts) {
          if (y > 270) { doc.addPage(); y = 20; }
          const severity = alert.severity === "critical" ? "🔴" : alert.severity === "warning" ? "🟡" : "🔵";
          doc.setFontSize(9);
          doc.setTextColor(80, 80, 80);
          const alertLines = doc.splitTextToSize(`${severity} ${alert.message} (${alert.parts?.join(", ") || ""})`, pageWidth - 2 * margin - 5);
          doc.text(alertLines, margin + 3, y);
          y += alertLines.length * 4.5 + 3;
        }
      }
      if (patternData.patterns?.length > 0) {
        if (y > 240) { doc.addPage(); y = 20; }
        doc.setFontSize(11);
        doc.setTextColor(60, 90, 130);
        doc.text("Detekované vzorce:", margin, y);
        y += 6;
        autoTable(doc, {
          startY: y,
          head: [["Typ", "Popis", "Části", "Závažnost"]],
          body: patternData.patterns.map((p: any) => [
            p.type?.replace("_", " ") || "—", (p.description || "").slice(0, 100),
            p.parts_involved?.join(", ") || "—", p.severity || "—",
          ]),
          styles: { fontSize: 8, cellPadding: 2 },
          headStyles: { fillColor: [70, 100, 140], textColor: 255, fontStyle: "bold" },
          alternateRowStyles: { fillColor: [240, 245, 250] },
          margin: { left: margin, right: margin },
        });
        y = (doc as any).lastAutoTable.finalY + 8;
      }
      if (patternData.positive_trends?.length > 0) {
        if (y > 260) { doc.addPage(); y = 20; }
        doc.setFontSize(11);
        doc.setTextColor(50, 120, 60);
        doc.text("Pozitivní trendy:", margin, y);
        y += 6;
        doc.setFontSize(9);
        doc.setTextColor(80, 80, 80);
        for (const trend of patternData.positive_trends) {
          if (y > 275) { doc.addPage(); y = 20; }
          const tLines = doc.splitTextToSize(`✅ ${trend}`, pageWidth - 2 * margin - 5);
          doc.text(tLines, margin + 3, y);
          y += tLines.length * 4.5 + 2;
        }
      }
    }
  } catch (e) {
    doc.setFontSize(9);
    doc.setTextColor(180, 80, 80);
    doc.text("Analýza vzorců není momentálně dostupná.", margin, y);
    y += 8;
  }

  if (y > 230) { doc.addPage(); y = 20; }
  doc.setFontSize(14);
  doc.setTextColor(40, 60, 40);
  doc.text("4. Nedávné rozhovory", margin, y);
  y += 8;

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: recentThreads } = await supabase
    .from("did_threads")
    .select("part_name, started_at, last_activity_at, sub_mode, messages")
    .gte("last_activity_at", thirtyDaysAgo)
    .order("last_activity_at", { ascending: false })
    .limit(20);

  if (recentThreads && recentThreads.length > 0) {
    autoTable(doc, {
      startY: y,
      head: [["Část", "Režim", "Začátek", "Poslední aktivita", "Zpráv"]],
      body: recentThreads.map(t => [
        t.part_name, t.sub_mode, formatDate(t.started_at),
        formatDate(t.last_activity_at), String(Array.isArray(t.messages) ? t.messages.length : 0),
      ]),
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [90, 120, 90], textColor: 255, fontStyle: "bold" },
      alternateRowStyles: { fillColor: [245, 245, 240] },
      margin: { left: margin, right: margin },
    });
  }

  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(160, 160, 160);
    doc.text(`Karel – DID Report • Strana ${i}/${pageCount}`, pageWidth / 2, doc.internal.pageSize.getHeight() - 8, { align: "center" });
  }

  const dateStr = new Date().toISOString().slice(0, 10);
  doc.save(`DID_Report_${dateStr}.pdf`);
}

// ══════════════════════════════════════════════
// generateKataHandbook — Příručka pro Káťu
// ══════════════════════════════════════════════

interface CardData {
  name: string;
  content: string;
}

function extractSection(content: string, sectionLetter: string): string {
  // Match "SEKCE X" or "## X:" patterns
  const patterns = [
    new RegExp(`SEKCE\\s+${sectionLetter}[^\\n]*\\n([\\s\\S]*?)(?=SEKCE\\s+[A-M]|$)`, "i"),
    new RegExp(`##\\s*${sectionLetter}[:\\s][^\\n]*\\n([\\s\\S]*?)(?=##\\s*[A-M][:\\s]|$)`, "i"),
  ];
  for (const pat of patterns) {
    const m = content.match(pat);
    if (m && m[1]?.trim()) return m[1].trim();
  }
  return "";
}

function extractField(content: string, fieldName: string): string {
  const regex = new RegExp(`${fieldName}[:\\s]*([^\\n]+)`, "i");
  const m = content.match(regex);
  return m ? m[1].trim() : "";
}

export async function generateKataHandbook(): Promise<void> {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 15;
  const contentWidth = pageWidth - 2 * margin;
  let y = 20;

  // ── Title page ──
  doc.setFontSize(22);
  doc.setTextColor(50, 80, 140);
  doc.text("Příručka pro Káťu", pageWidth / 2, y, { align: "center" });
  y += 10;
  doc.setFontSize(12);
  doc.setTextColor(100, 100, 100);
  doc.text("Pravidla, triggery a doporučené věty pro každou část", pageWidth / 2, y, { align: "center" });
  y += 6;
  doc.setFontSize(9);
  doc.text(`Vygenerováno: ${formatDate(new Date().toISOString())}`, pageWidth / 2, y, { align: "center" });
  y += 12;

  // ── Load all cards from Drive ──
  doc.setFontSize(10);
  doc.setTextColor(80, 80, 80);
  doc.text("Načítám data z kartotéky...", margin, y);

  let cards: CardData[] = [];
  try {
    const headers = await getAuthHeaders();
    // First get file list
    const listRes = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-drive-read`,
      { method: "POST", headers, body: JSON.stringify({ listAll: true }) }
    );
    if (!listRes.ok) throw new Error("Nelze načíst seznam souborů");
    const listData = await listRes.json();
    const files: Array<{ id: string; name: string; mimeType?: string }> = listData.files || [];

    // Filter card files
    const cardFiles = files.filter(f =>
      f.mimeType !== "application/vnd.google-apps.folder" &&
      (f.name.toLowerCase().startsWith("karta") || f.name.match(/^\d+_karta/i))
    );

    // Read card contents in batches
    if (cardFiles.length > 0) {
      const docNames = cardFiles.map(f => f.name.replace(/\.(txt|md|doc|docx)$/i, ""));
      const readRes = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-drive-read`,
        { method: "POST", headers, body: JSON.stringify({ documents: docNames }) }
      );
      if (readRes.ok) {
        const readData = await readRes.json();
        const docs = readData.documents || {};
        for (const [name, content] of Object.entries(docs)) {
          if (typeof content === "string" && !content.startsWith("[Dokument") && content.length > 50) {
            cards.push({ name, content });
          }
        }
      }
    }
  } catch (e) {
    console.error("Failed to load cards for handbook:", e);
  }

  // Clear loading text
  y = 48;

  if (cards.length === 0) {
    doc.setFontSize(12);
    doc.setTextColor(180, 80, 80);
    doc.text("Nepodařilo se načíst žádné karty z kartotéky.", margin, y);
    doc.save(`Prirucka_pro_Katu_${new Date().toISOString().slice(0, 10)}.pdf`);
    return;
  }

  // ── General rules section ──
  doc.setFontSize(14);
  doc.setTextColor(50, 80, 140);
  doc.text("Obecná pravidla pro Káťu", margin, y);
  y += 7;

  const generalRules = [
    "Vždy mluv klidně a pomalu – nižší tón hlasu = menší hrozba.",
    "Nikdy se neptej 'kdo jsi?' přímo – počkej, až se část představí sama.",
    "Při přepnutí části NEREAGUJ překvapeně. Plynule přizpůsob komunikaci.",
    "Pokud nevíš, kdo mluví – pokračuj neutrálně, ověř nepřímo.",
    "Amálka a Tonička: zapojuj přirozeně (hry, kreslení), ne násilně.",
    "Nikdy neslibuj něco, co nemůžeš splnit. Důvěra se buduje činy.",
    "Při krizi: zpomali, sniž hlas, použij ukotvení (5-4-3-2-1).",
    "Vždy informuj mamku o důležitých událostech.",
  ];

  doc.setFontSize(9);
  doc.setTextColor(60, 60, 60);
  for (const rule of generalRules) {
    if (y > 275) { doc.addPage(); y = 20; }
    const lines = doc.splitTextToSize(`• ${rule}`, contentWidth);
    doc.text(lines, margin, y);
    y += lines.length * 4.5 + 2;
  }
  y += 5;

  // ── Per-card sections ──
  for (const card of cards) {
    doc.addPage();
    y = 20;

    // Extract key info
    const partName = extractField(card.content, "Jméno") || card.name.replace(/^(Karta_?|karta_?|\d+_)/i, "").replace(/_/g, " ");
    const age = extractField(card.content, "Věk") || extractField(card.content, "Odhadovaný věk");
    const lang = extractField(card.content, "Jazyk");
    const type = extractField(card.content, "Typ");

    // Section extractions
    const identity = extractSection(card.content, "A");
    const character = extractSection(card.content, "B");
    const needs = extractSection(card.content, "C");
    const therapy = extractSection(card.content, "D");
    const goals = extractSection(card.content, "J");

    // ── Card header ──
    doc.setFontSize(16);
    doc.setTextColor(50, 80, 140);
    doc.text(partName, margin, y);
    y += 7;

    // Basic info line
    const infoLine = [age && `Věk: ${age}`, lang && `Jazyk: ${lang}`, type && `Typ: ${type}`].filter(Boolean).join(" | ");
    if (infoLine) {
      doc.setFontSize(9);
      doc.setTextColor(100, 100, 100);
      doc.text(infoLine, margin, y);
      y += 6;
    }

    // ── Triggery ──
    doc.setFontSize(11);
    doc.setTextColor(180, 50, 50);
    doc.text("⚠️ TRIGGERY – CO NEDĚLAT", margin, y);
    y += 6;

    // Extract triggers from content
    const triggerMatches = card.content.match(/(?:trigger|spouštěč|⚠️|NIKDY|NEDĚLAT|nezmiňovat)[^\n]*/gi) || [];
    const noDoMatches = card.content.match(/(?:Co nedělat|NEOPAKOVAT|NEPOKOUŠET)[^\n]*/gi) || [];
    const allTriggers = [...new Set([...triggerMatches, ...noDoMatches])];

    doc.setFontSize(9);
    doc.setTextColor(150, 50, 50);
    if (allTriggers.length > 0) {
      for (const t of allTriggers.slice(0, 10)) {
        if (y > 275) { doc.addPage(); y = 20; }
        const lines = doc.splitTextToSize(`🔴 ${t.replace(/^[-*•⚠️\s]+/, "").trim()}`, contentWidth);
        doc.text(lines, margin, y);
        y += lines.length * 4.5 + 2;
      }
    } else {
      doc.text("Zatím nedokumentovány – postupuj opatrně.", margin, y);
      y += 5;
    }
    y += 4;

    // ── Co potřebuje / Co uklidňuje ──
    if (needs) {
      doc.setFontSize(11);
      doc.setTextColor(50, 120, 80);
      doc.text("💚 POTŘEBY A CO UKLIDŇUJE", margin, y);
      y += 6;
      doc.setFontSize(9);
      doc.setTextColor(60, 60, 60);
      y = addWrappedText(doc, needs.slice(0, 600), margin, y, contentWidth, 4.5);
      y += 4;
    }

    // ── Doporučené věty ──
    doc.setFontSize(11);
    doc.setTextColor(50, 80, 140);
    doc.text("💬 DOPORUČENÉ VĚTY PRO KÁŤU", margin, y);
    y += 6;

    // Generate recommended phrases based on age and character
    const ageNum = parseInt(age) || 0;
    const phrases: string[] = [];
    if (ageNum > 0 && ageNum <= 5) {
      phrases.push(`"Ahoj! Já jsem Káťa. Chceš si se mnou hrát?"`, `"To je v pohodě. Tady jsi v bezpečí."`, `"Podívej, co umí Amálka/Tonička – chceš to taky zkusit?"`);
    } else if (ageNum > 5 && ageNum <= 10) {
      phrases.push(`"Ahoj, já jsem Káťa. Jsem tu pro tebe, kdykoli budeš chtít."`, `"Chceš mi o tom povědět, nebo radši děláme něco jiného?"`, `"Amálka a Tonička by tě rády poznaly – ale jen když budeš chtít ty."`);
    } else if (ageNum > 10) {
      phrases.push(`"Ahoj, jsem Káťa. Nemusíš mi nic vysvětlovat, jsem tu prostě s tebou."`, `"Řekni mi, co potřebuješ – a já se pokusím to zařídit."`, `"Jsem součást rodiny. Můžeš se na mě spolehnout."`);
    } else {
      phrases.push(`"Ahoj, jsem Káťa. Jsem tu jako rodina – pro tebe i pro ostatní."`, `"Nemusíš se bát. Jsem tu a nikam neodcházím."`, `"Co bys teď potřeboval/a? Můžeme dělat cokoli – nebo nic."`);
    }

    // Add language-specific note
    if (lang && !lang.toLowerCase().includes("česky") && !lang.toLowerCase().includes("cs")) {
      phrases.push(`Pozn.: Tato část může komunikovat ${lang} – přizpůsob jazyk.`);
    }

    doc.setFontSize(9);
    doc.setTextColor(60, 60, 60);
    for (const phrase of phrases) {
      if (y > 275) { doc.addPage(); y = 20; }
      const lines = doc.splitTextToSize(`→ ${phrase}`, contentWidth);
      doc.text(lines, margin, y);
      y += lines.length * 4.5 + 2;
    }
    y += 4;

    // ── Terapeutická doporučení ──
    if (therapy) {
      if (y > 240) { doc.addPage(); y = 20; }
      doc.setFontSize(11);
      doc.setTextColor(120, 80, 40);
      doc.text("📋 TERAPEUTICKÁ DOPORUČENÍ", margin, y);
      y += 6;
      doc.setFontSize(9);
      doc.setTextColor(60, 60, 60);
      y = addWrappedText(doc, therapy.slice(0, 800), margin, y, contentWidth, 4.5);
      y += 4;
    }

    // ── Aktuální cíle ──
    if (goals) {
      if (y > 240) { doc.addPage(); y = 20; }
      doc.setFontSize(11);
      doc.setTextColor(50, 80, 140);
      doc.text("🎯 AKTUÁLNÍ CÍLE", margin, y);
      y += 6;
      doc.setFontSize(9);
      doc.setTextColor(60, 60, 60);
      y = addWrappedText(doc, goals.slice(0, 500), margin, y, contentWidth, 4.5);
    }
  }

  // ── Footer on all pages ──
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(160, 160, 160);
    doc.text(`Příručka pro Káťu • Strana ${i}/${pageCount}`, pageWidth / 2, doc.internal.pageSize.getHeight() - 8, { align: "center" });
  }

  const dateStr = new Date().toISOString().slice(0, 10);
  doc.save(`Prirucka_pro_Katu_${dateStr}.pdf`);
}

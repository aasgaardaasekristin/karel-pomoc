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

  // ── Load custom font with Czech diacritics support ──
  try {
    const fontResponse = await fetch("/fonts/Roboto-Regular.ttf");
    if (fontResponse.ok) {
      const fontBuffer = await fontResponse.arrayBuffer();
      const fontBytes = new Uint8Array(fontBuffer);
      let binary = "";
      for (let i = 0; i < fontBytes.length; i++) {
        binary += String.fromCharCode(fontBytes[i]);
      }
      const base64Font = btoa(binary);
      doc.addFileToVFS("Roboto-Regular.ttf", base64Font);
      doc.addFont("Roboto-Regular.ttf", "Roboto", "normal");
      doc.setFont("Roboto");
    }
  } catch (e) {
    console.warn("Failed to load custom font:", e);
  }

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

export async function generateKataHandbook(currentMessages?: { role: string; content: string }[]): Promise<void> {
  if (!currentMessages || currentMessages.length < 2) {
    throw new Error("Žádné zprávy k zpracování – nejprve veď rozhovor s Karlem.");
  }

  // ── 1. Call synthesis edge function ──
  const headers = await getAuthHeaders();
  const synthRes = await fetch(
    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-kata-handbook`,
    { method: "POST", headers, body: JSON.stringify({ messages: currentMessages }) }
  );
  if (!synthRes.ok) {
    const errText = await synthRes.text();
    throw new Error(`Syntéza příručky selhala: ${errText}`);
  }
  const handbook = await synthRes.json();

  // ── 2. Build PDF ──
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 15;
  const contentWidth = pageWidth - 2 * margin;
  let y = 20;

  // Load font
  try {
    const fontResponse = await fetch("/fonts/Roboto-Regular.ttf");
    if (fontResponse.ok) {
      const fontBuffer = await fontResponse.arrayBuffer();
      const fontBytes = new Uint8Array(fontBuffer);
      let binary = "";
      for (let i = 0; i < fontBytes.length; i++) {
        binary += String.fromCharCode(fontBytes[i]);
      }
      const base64Font = btoa(binary);
      doc.addFileToVFS("Roboto-Regular.ttf", base64Font);
      doc.addFont("Roboto-Regular.ttf", "Roboto", "normal");
      doc.setFont("Roboto");
    }
  } catch (e) {
    console.warn("Failed to load custom font:", e);
  }

  // ── Title ──
  doc.setFontSize(20);
  doc.setTextColor(50, 80, 140);
  doc.text("Příručka pro Káťu", pageWidth / 2, y, { align: "center" });
  y += 9;
  doc.setFontSize(11);
  doc.setTextColor(80, 80, 80);
  const topicLines = doc.splitTextToSize(`Téma: ${handbook.topic || "konzultace"}`, contentWidth);
  doc.text(topicLines, pageWidth / 2, y, { align: "center" });
  y += topicLines.length * 5 + 4;
  doc.setFontSize(9);
  doc.setTextColor(130, 130, 130);
  doc.text(`Vygenerováno: ${formatDate(new Date().toISOString())}`, pageWidth / 2, y, { align: "center" });
  y += 10;
  doc.setDrawColor(180, 200, 220);
  doc.setLineWidth(0.5);
  doc.line(margin, y, pageWidth - margin, y);
  y += 8;

  // ── Summary ──
  if (handbook.summary) {
    doc.setFontSize(10);
    doc.setTextColor(60, 60, 60);
    y = addWrappedText(doc, handbook.summary, margin, y, contentWidth, 5);
    y += 6;
  }

  // ── Methods ──
  if (handbook.methods?.length > 0) {
    doc.setFontSize(14);
    doc.setTextColor(50, 80, 140);
    doc.text("Doporučené metody a přístupy", margin, y);
    y += 8;

    for (let i = 0; i < handbook.methods.length; i++) {
      const m = handbook.methods[i];
      if (y > 250) { doc.addPage(); y = 20; }

      doc.setFontSize(11);
      doc.setTextColor(40, 70, 120);
      doc.text(`${i + 1}. ${m.name || "Metoda"}${m.difficulty ? ` (${m.difficulty})` : ""}`, margin, y);
      y += 6;

      doc.setFontSize(9);
      doc.setTextColor(50, 50, 50);
      if (m.description) {
        y = addWrappedText(doc, m.description, margin + 3, y, contentWidth - 6, 4.5);
        y += 2;
      }
      if (m.why_it_works) {
        doc.setTextColor(80, 110, 80);
        y = addWrappedText(doc, `Proč to funguje: ${m.why_it_works}`, margin + 3, y, contentWidth - 6, 4.5);
        y += 4;
      }
    }
    y += 4;
  }

  // ── Warnings ──
  if (handbook.warnings?.length > 0) {
    if (y > 250) { doc.addPage(); y = 20; }
    doc.setFontSize(14);
    doc.setTextColor(180, 80, 40);
    doc.text("Na co si dát pozor", margin, y);
    y += 7;

    doc.setFontSize(9);
    doc.setTextColor(100, 50, 30);
    for (const w of handbook.warnings) {
      if (y > 270) { doc.addPage(); y = 20; }
      y = addWrappedText(doc, `• ${w}`, margin + 3, y, contentWidth - 6, 4.5);
      y += 2;
    }
    y += 4;
  }

  // ── Tips ──
  if (handbook.tips?.length > 0) {
    if (y > 250) { doc.addPage(); y = 20; }
    doc.setFontSize(14);
    doc.setTextColor(50, 120, 60);
    doc.text("Praktické tipy", margin, y);
    y += 7;

    doc.setFontSize(9);
    doc.setTextColor(50, 50, 50);
    for (const tip of handbook.tips) {
      if (y > 270) { doc.addPage(); y = 20; }
      y = addWrappedText(doc, `• ${tip}`, margin + 3, y, contentWidth - 6, 4.5);
      y += 2;
    }
    y += 4;
  }

  // ── Additional methods from Perplexity ──
  if (handbook.additional_methods?.length > 0) {
    if (y > 240) { doc.addPage(); y = 20; }
    doc.setFontSize(14);
    doc.setTextColor(60, 90, 130);
    doc.text("Další metody z odborné rešerše", margin, y);
    y += 8;

    for (const am of handbook.additional_methods) {
      if (y > 250) { doc.addPage(); y = 20; }
      doc.setFontSize(10);
      doc.setTextColor(50, 70, 110);
      doc.text(am.name || "Metoda", margin + 3, y);
      y += 5;

      doc.setFontSize(9);
      doc.setTextColor(50, 50, 50);
      if (am.description) {
        y = addWrappedText(doc, am.description, margin + 5, y, contentWidth - 10, 4.5);
        y += 1;
      }
      if (am.source) {
        doc.setTextColor(100, 100, 150);
        doc.setFontSize(8);
        y = addWrappedText(doc, `Zdroj: ${am.source}`, margin + 5, y, contentWidth - 10, 4);
        y += 3;
      }
    }
    y += 4;
  }

  // ── Action plan ──
  if (handbook.action_plan?.length > 0) {
    if (y > 250) { doc.addPage(); y = 20; }
    doc.setFontSize(14);
    doc.setTextColor(50, 80, 140);
    doc.text("Akční plán", margin, y);
    y += 7;

    doc.setFontSize(9);
    doc.setTextColor(50, 50, 50);
    for (let i = 0; i < handbook.action_plan.length; i++) {
      if (y > 270) { doc.addPage(); y = 20; }
      y = addWrappedText(doc, `${i + 1}. ${handbook.action_plan[i]}`, margin + 3, y, contentWidth - 6, 4.5);
      y += 2;
    }
  }

  // ── Footer ──
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

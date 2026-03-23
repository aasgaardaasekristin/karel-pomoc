import jsPDF from "jspdf";
import { parseAiAnalysis } from "@/lib/parseAiAnalysis";

interface SessionData {
  session_number: number | null;
  session_date: string;
  report_context: string;
  report_key_theme: string;
  report_therapist_emotions: string[];
  report_transference: string;
  report_risks: string[];
  report_missing_data: string;
  report_interventions_tried: string;
  report_next_session_goal: string;
  ai_analysis: string;
  voice_analysis: string;
  notes: string;
}

async function loadRobotoFont(doc: jsPDF) {
  try {
    const res = await fetch("/fonts/Roboto-Regular.ttf");
    if (res.ok) {
      const buf = await res.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      doc.addFileToVFS("Roboto-Regular.ttf", btoa(binary));
      doc.addFont("Roboto-Regular.ttf", "Roboto", "normal");
      doc.setFont("Roboto");
    }
  } catch {
    console.warn("Nepodařilo se načíst Roboto font");
  }
}

function wrapped(doc: jsPDF, text: string, x: number, y: number, maxW: number, lh = 5): number {
  const lines = doc.splitTextToSize(text, maxW);
  for (const line of lines) {
    if (y > doc.internal.pageSize.getHeight() - 15) {
      doc.addPage();
      y = 20;
    }
    doc.text(line, x, y);
    y += lh;
  }
  return y;
}

function section(doc: jsPDF, label: string, value: string | null | undefined, x: number, y: number, maxW: number): number {
  if (!value || !value.trim()) return y;
  if (y > doc.internal.pageSize.getHeight() - 30) {
    doc.addPage();
    y = 20;
  }
  doc.setFontSize(10);
  doc.setTextColor(100, 100, 100);
  doc.text(label, x, y);
  y += 5;
  doc.setFontSize(9);
  doc.setTextColor(40, 40, 40);
  y = wrapped(doc, value, x, y, maxW, 4.5);
  y += 3;
  return y;
}

async function buildSessionDoc(clientName: string, session: SessionData): Promise<jsPDF> {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pw = doc.internal.pageSize.getWidth();
  const m = 15;
  const maxW = pw - m * 2;
  let y = 20;

  await loadRobotoFont(doc);

  // Header
  doc.setFontSize(16);
  doc.setTextColor(60, 80, 60);
  doc.text("Report ze sezení", pw / 2, y, { align: "center" });
  y += 8;

  doc.setFontSize(10);
  doc.setTextColor(100, 100, 100);
  const dateStr = new Date(session.session_date).toLocaleDateString("cs-CZ", {
    day: "numeric", month: "long", year: "numeric",
  });
  doc.text(`${clientName} · Sezení ${session.session_number ?? "?"} · ${dateStr}`, pw / 2, y, { align: "center" });
  y += 4;
  doc.text(`Vygenerováno: ${new Date().toLocaleDateString("cs-CZ")}`, pw / 2, y, { align: "center" });
  y += 10;

  // Separator
  doc.setDrawColor(180, 200, 180);
  doc.setLineWidth(0.5);
  doc.line(m, y, pw - m, y);
  y += 8;

  // Sections
  y = section(doc, "KLÍČOVÉ TÉMA", session.report_key_theme, m, y, maxW);
  y = section(doc, "KONTEXT SEZENÍ", session.report_context, m, y, maxW);
  y = section(doc, "PŘENOS / PROTIPŘENOS", session.report_transference, m, y, maxW);
  y = section(doc, "POUŽITÉ INTERVENCE", session.report_interventions_tried, m, y, maxW);
  y = section(doc, "CÍL DALŠÍHO SEZENÍ", session.report_next_session_goal, m, y, maxW);
  y = section(doc, "CO OVĚŘIT", session.report_missing_data, m, y, maxW);

  if (session.report_therapist_emotions?.length > 0) {
    y = section(doc, "EMOCE TERAPEUTA", session.report_therapist_emotions.join(", "), m, y, maxW);
  }
  if (session.report_risks?.length > 0) {
    y = section(doc, "RIZIKA", session.report_risks.join(", "), m, y, maxW);
  }

  // AI Analysis
  if (session.ai_analysis?.trim()) {
    if (y > doc.internal.pageSize.getHeight() - 40) { doc.addPage(); y = 20; }
    doc.setDrawColor(180, 200, 180);
    doc.line(m, y, pw - m, y);
    y += 6;
    doc.setFontSize(12);
    doc.setTextColor(60, 80, 60);
    doc.text("AI ANALÝZA", m, y);
    y += 6;
    doc.setFontSize(9);
    doc.setTextColor(40, 40, 40);
    y = wrapped(doc, parseAiAnalysis(session.ai_analysis), m, y, maxW, 4.5);
    y += 4;
  }

  // Voice Analysis
  if (session.voice_analysis?.trim()) {
    if (y > doc.internal.pageSize.getHeight() - 40) { doc.addPage(); y = 20; }
    doc.setDrawColor(180, 200, 180);
    doc.line(m, y, pw - m, y);
    y += 6;
    doc.setFontSize(12);
    doc.setTextColor(60, 80, 60);
    doc.text("HLASOVÁ ANALÝZA", m, y);
    y += 6;
    doc.setFontSize(9);
    doc.setTextColor(40, 40, 40);
    y = wrapped(doc, session.voice_analysis, m, y, maxW, 4.5);
    y += 4;
  }

  // Notes
  y = section(doc, "POZNÁMKY", session.notes, m, y, maxW);

  // Footer on every page
  const totalPages = doc.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    doc.setFontSize(7);
    doc.setTextColor(160, 160, 160);
    doc.text(`Karel · Report sezení · ${clientName} · Strana ${i}/${totalPages}`, pw / 2, doc.internal.pageSize.getHeight() - 8, { align: "center" });
  }

  return doc;
}

export async function exportSessionReportPdf(
  clientName: string,
  session: SessionData,
): Promise<void> {
  const doc = await buildSessionDoc(clientName, session);
  const safeName = clientName.replace(/[^a-zA-Z0-9áčďéěíňóřšťúůýžÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ ]/g, "").replace(/\s+/g, "_");
  doc.save(`Report_${safeName}_${session.session_date}.pdf`);
}

export async function generateSessionReportBlob(
  clientName: string,
  session: SessionData,
): Promise<Blob> {
  const doc = await buildSessionDoc(clientName, session);
  return doc.output("blob");
}

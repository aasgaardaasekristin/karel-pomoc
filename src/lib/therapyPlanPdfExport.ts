import jsPDF from "jspdf";

async function loadFont(doc: jsPDF) {
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
  } catch {}
}

export async function exportTherapyPlanPdf(clientName: string, planMarkdown: string) {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  await loadFont(doc);

  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 15;
  const maxW = pageW - margin * 2;
  let y = margin;

  const checkPage = (needed: number) => {
    if (y + needed > pageH - margin) { doc.addPage(); y = margin; }
  };

  // Title
  doc.setFontSize(14);
  doc.setTextColor(40, 40, 40);
  doc.text("Terapeutický plán procesu", margin, y);
  y += 7;
  doc.setFontSize(11);
  doc.text(clientName, margin, y);
  y += 5;
  doc.setFontSize(8);
  doc.setTextColor(120, 120, 120);
  doc.text(`Vygenerováno: ${new Date().toLocaleDateString("cs-CZ")}`, margin, y);
  y += 8;
  doc.setDrawColor(200, 200, 200);
  doc.line(margin, y, pageW - margin, y);
  y += 6;

  const lines = planMarkdown.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { y += 3; continue; }

    if (trimmed.startsWith("# ")) {
      checkPage(12);
      doc.setFontSize(13);
      doc.setTextColor(30, 30, 30);
      const wrapped = doc.splitTextToSize(trimmed.replace(/^#+\s*/, ""), maxW);
      for (const w of wrapped) { checkPage(6); doc.text(w, margin, y); y += 6; }
      y += 2;
    } else if (trimmed.startsWith("## ")) {
      checkPage(10);
      y += 3;
      doc.setFontSize(11);
      doc.setTextColor(50, 50, 50);
      const wrapped = doc.splitTextToSize(trimmed.replace(/^#+\s*/, ""), maxW);
      for (const w of wrapped) { checkPage(5.5); doc.text(w, margin, y); y += 5.5; }
      y += 2;
    } else if (trimmed.startsWith("### ")) {
      checkPage(8);
      y += 2;
      doc.setFontSize(10);
      doc.setTextColor(60, 60, 60);
      const wrapped = doc.splitTextToSize(trimmed.replace(/^#+\s*/, ""), maxW);
      for (const w of wrapped) { checkPage(5); doc.text(w, margin, y); y += 5; }
      y += 1;
    } else if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      doc.setFontSize(9);
      doc.setTextColor(40, 40, 40);
      const bullet = trimmed.replace(/^[-*]\s*/, "");
      const bLines = doc.splitTextToSize(`• ${bullet}`, maxW - 4);
      for (const bl of bLines) { checkPage(4.5); doc.text(bl, margin + 2, y); y += 4.5; }
    } else {
      doc.setFontSize(9);
      doc.setTextColor(40, 40, 40);
      const wrapped = doc.splitTextToSize(trimmed.replace(/\*\*/g, ""), maxW);
      for (const w of wrapped) { checkPage(4.5); doc.text(w, margin, y); y += 4.5; }
    }
  }

  const safeDate = new Date().toISOString().slice(0, 10);
  doc.save(`Plan_procesu_${clientName.replace(/\s+/g, "_")}_${safeDate}.pdf`);
}

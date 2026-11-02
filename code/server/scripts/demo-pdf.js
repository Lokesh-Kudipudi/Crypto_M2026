// Writes a one-page certificate PDF using only the built-in Helvetica fonts, with no dependencies.

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
// Standard Helvetica glyph widths in 1/1000 em, for ASCII 32 to 126, used to centre text
const WIDTHS = {
  F1: [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584],
  F2: [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584],
};

const escapeText = (text) => text.replace(/[\\()]/g, "\\$&");

const textWidth = (text, size, font) =>
  [...text].reduce((sum, c) => sum + (WIDTHS[font][c.charCodeAt(0) - 32] ?? 556), 0) * size / 1000;

function centered(text, y, size, font = "F1") {
  const x = Math.max(40, (PAGE_WIDTH - textWidth(text, size, font)) / 2);
  return `BT /${font} ${size} Tf ${x.toFixed(1)} ${y} Td (${escapeText(text)}) Tj ET`;
}

function buildPdf(content) {
  const stream = Buffer.from(content, "latin1");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>`,
    `<< /Length ${stream.length} >>\nstream\n${stream.toString("latin1")}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
  ];

  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, i) => {
    const offset = Buffer.byteLength(body, "latin1");
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

/** values: { certificateId, uid, candidateName, courseName, organizationName, cgpa, completionYear } */
export function certificatePdf(values) {
  const lines = [
    "0.29 0.29 0.84 RG 3 w 40 40 515 762 re S",
    "0.29 0.29 0.84 RG 1 w 48 48 499 746 re S",
    "0.70 0.15 0.12 rg",
    centered("DEMO DOCUMENT - NOT A REAL CERTIFICATE", 760, 12, "F2"),
    "0.11 0.13 0.20 rg",
    centered(values.organizationName, 680, 24, "F2"),
    centered("This is to certify that", 610, 14),
    centered(values.candidateName, 560, 30, "F2"),
    centered("has successfully completed", 510, 14),
    centered(values.courseName, 465, 20, "F2"),
    centered(`CGPA ${values.cgpa}  |  Completed ${values.completionYear}`, 415, 14),
    centered(`Certificate ID: ${values.certificateId}`, 180, 12),
    centered(`UID: ${values.uid}`, 160, 12),
    centered("Fictional sample for testing CertChain. All names are made up.", 100, 10),
  ];
  return buildPdf(lines.join("\n"));
}

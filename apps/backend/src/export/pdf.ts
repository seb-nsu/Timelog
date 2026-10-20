// Minimaler PDF-Erzeuger für Text-Tabellen (Helvetica, WinAnsi), ohne Abhängigkeiten.

const PAGE_W = 842; // A4 quer
const PAGE_H = 595;
const MARGIN = 36;
const LINE_H = 13;

function escapeText(s: string): string {
  // WinAnsi deckt Umlaute und ß ab; andere Zeichen werden ersetzt.
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 63;
    const c = code <= 0xff ? ch : '?';
    out += c === '\\' || c === '(' || c === ')' ? `\\${c}` : c;
  }
  return out;
}

export interface PdfTable {
  title: string;
  subtitle?: string;
  columns: { label: string; width: number }[];
  rows: string[][];
}

export function renderPdf(table: PdfTable): Buffer {
  const rowsPerPage = Math.floor((PAGE_H - 2 * MARGIN - 3 * LINE_H) / LINE_H);
  const pages: string[] = [];
  const chunks: string[][][] = table.rows.length === 0 ? [[]] : [];
  for (let i = 0; i < table.rows.length; i += rowsPerPage)
    chunks.push(table.rows.slice(i, i + rowsPerPage));

  chunks.forEach((rows, pageIndex) => {
    const ops: string[] = [];
    const text = (x: number, y: number, size: number, bold: boolean, s: string) => {
      ops.push(
        `BT /${bold ? 'F2' : 'F1'} ${String(size)} Tf ${String(x)} ${String(y)} Td (${escapeText(s)}) Tj ET`,
      );
    };
    let y = PAGE_H - MARGIN;
    text(MARGIN, y, 14, true, table.title);
    if (table.subtitle) text(MARGIN + 300, y, 9, false, table.subtitle);
    text(
      PAGE_W - MARGIN - 60,
      y,
      9,
      false,
      `Seite ${String(pageIndex + 1)}/${String(chunks.length)}`,
    );
    y -= 2 * LINE_H;
    let x = MARGIN;
    for (const c of table.columns) {
      text(x, y, 8, true, c.label);
      x += c.width;
    }
    ops.push(
      `${String(MARGIN)} ${String(y - 4)} m ${String(PAGE_W - MARGIN)} ${String(y - 4)} l S`,
    );
    for (const row of rows) {
      y -= LINE_H;
      x = MARGIN;
      row.forEach((cell, i) => {
        text(x, y, 8, false, cell);
        x += table.columns[i]?.width ?? 60;
      });
    }
    pages.push(ops.join('\n'));
  });

  // Objekte: 1 Katalog, 2 Seitenbaum, 3/4 Schriften, dann je Seite Inhalt + Seite
  const objects: string[] = [];
  const pageIds: number[] = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objects[4] =
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  let next = 5;
  for (const content of pages) {
    const contentId = next++;
    const pageId = next++;
    const bytes = Buffer.byteLength(content, 'latin1');
    objects[contentId] = `<< /Length ${String(bytes)} >>\nstream\n${content}\nendstream`;
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${String(PAGE_W)} ${String(PAGE_H)}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${String(contentId)} 0 R >>`;
    pageIds.push(pageId);
  }
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${String(id)} 0 R`).join(' ')}] /Count ${String(pageIds.length)} >>`;

  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = Buffer.byteLength(out, 'latin1');
    out += `${String(i)} 0 obj\n${objects[i] ?? 'null'}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${String(objects.length)}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i++)
    out += `${String(offsets[i] ?? 0).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${String(objects.length)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

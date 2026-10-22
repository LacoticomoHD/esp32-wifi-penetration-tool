// Kontext-Dateien für die KI-Analyse einlesen.
//   PDF        → base64 (Claude liest es nativ, inkl. Layout)
//   Bild       → base64 (Claude sieht das Bild)
//   Excel/CSV  → Text (via SheetJS, alle Blätter als CSV)
//   Word .docx → Text (Zip entpacken, word/document.xml auslesen)
// Alles passiert im Browser; nur der extrahierte Inhalt geht an die KI-Funktion.

import { unzipSync, strFromU8 } from 'fflate';
import * as XLSXImport from 'xlsx';
const XLSX = ((XLSXImport as unknown as { default?: typeof XLSXImport }).default ?? XLSXImport) as typeof XLSXImport;

export interface DocAttachment {
  kind: 'pdf' | 'image' | 'text';
  name: string;
  media_type?: string; // pdf/image: MIME-Typ
  data?: string; // pdf/image: base64 (ohne data:-Präfix)
  text?: string; // text: extrahierter Inhalt
  bytes: number; // Rohgröße der Datei (für Größen-Warnungen)
}

const IMG: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
};

const ext = (name: string) => name.slice(name.lastIndexOf('.') + 1).toLowerCase();

async function toBase64(buf: Uint8Array): Promise<string> {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) bin += String.fromCharCode(...buf.subarray(i, i + chunk));
  return btoa(bin);
}

function xlsxToText(buf: Uint8Array): string {
  const wb = XLSX.read(buf, { type: 'array' });
  return wb.SheetNames.map((n) => `# Blatt: ${n}\n${XLSX.utils.sheet_to_csv(wb.Sheets[n])}`).join('\n\n').trim();
}

function docxToText(buf: Uint8Array): string {
  const files = unzipSync(buf);
  const xml = files['word/document.xml'];
  if (!xml) return '';
  let s = strFromU8(xml)
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:tab\b[^>]*\/?>/g, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

/** Liest eine Datei in ein KI-taugliches Anhang-Objekt. Wirft bei nicht unterstützten Typen. */
export async function readAttachment(file: File): Promise<DocAttachment> {
  const e = ext(file.name);
  const bytes = file.size;
  const base = { name: file.name, bytes };
  const buf = new Uint8Array(await file.arrayBuffer());

  if (e === 'pdf') return { ...base, kind: 'pdf', media_type: 'application/pdf', data: await toBase64(buf) };
  if (IMG[e]) return { ...base, kind: 'image', media_type: IMG[e], data: await toBase64(buf) };
  if (e === 'xlsx' || e === 'xls') return { ...base, kind: 'text', text: xlsxToText(buf) };
  if (e === 'docx') return { ...base, kind: 'text', text: docxToText(buf) };
  if (e === 'csv' || e === 'tsv' || e === 'txt' || e === 'md') return { ...base, kind: 'text', text: strFromU8(buf) };
  if (e === 'doc') throw new Error('.doc (altes Word-Format) wird nicht unterstützt — bitte als .docx oder PDF speichern.');
  throw new Error(`Dateityp .${e} wird nicht unterstützt.`);
}

// Parser + Aggregation + Kennzahlen für INTRO Pulse.
// Framework-unabhängig: wird später von der Next.js-App aufgerufen und ist
// per CLI (src/cli.ts) direkt gegen echte Dateien testbar.

import * as XLSXImport from 'xlsx';
// SheetJS ist ein CommonJS-Paket; unter ESM/tsx liegen die Funktionen je nach
// Interop unter .default oder direkt im Namespace — beides abfangen.
const XLSX = ((XLSXImport as unknown as { default?: typeof XLSXImport }).default ??
  XLSXImport) as typeof XLSXImport;
import type {
  AbteilungKpi,
  Activity,
  CallerKpi,
  Company,
  Kpis,
  SegmentKpi,
} from './types';
import { STAGES, classify, stageLabelForRank } from './funnel';

// ---------------------------------------------------------------------------
// Normalisierung deutscher Excel-Eigenheiten
// ---------------------------------------------------------------------------

export function cleanText(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  return String(raw).replace(/ /g, ' ').trim();
}

/** Parst deutsche Zahlen wie "12.000.000,00 €" ebenso wie "64000000". */
export function parseGermanNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') return isFinite(raw) ? raw : null;
  let s = String(raw).replace(/ /g, ' ');
  s = s.replace(/[^0-9.,-]/g, ''); // Währung, Mojibake, Leerzeichen entfernen
  if (s === '' || s === '-') return null;
  const hasDot = s.includes('.');
  const hasComma = s.includes(',');
  if (hasDot && hasComma) {
    s = s.replace(/\./g, '').replace(',', '.'); // Punkt=Tausender, Komma=Dezimal
  } else if (hasComma) {
    s = s.replace(',', '.');
  } else if (hasDot) {
    const parts = s.split('.');
    const groupsLookLikeThousands = parts.slice(1).every((p) => p.length === 3);
    if (parts.length > 2 || groupsLookLikeThousands) s = s.replace(/\./g, '');
  }
  const n = Number(s);
  return isFinite(n) ? n : null;
}

/** Parst Datumsangaben (Date-Objekt, Excel-Serial oder "TT.MM.JJJJ"). */
export function parseDate(raw: unknown): Date | null {
  if (raw instanceof Date) return isNaN(raw.getTime()) ? null : raw;
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') {
    const ms = Math.round((raw - 25569) * 86400 * 1000); // Excel-Serial → ms
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d;
  }
  const s = String(raw).trim();
  const m = s.match(/(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})/);
  if (m) {
    let year = Number(m[3]);
    if (year < 100) year += 2000;
    const d = new Date(year, Number(m[2]) - 1, Number(m[1]));
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function parseJaNein(raw: unknown): boolean | null {
  const s = cleanText(raw).toLowerCase();
  if (!s) return null;
  if (s.startsWith('ja')) return true;
  if (s.startsWith('nein')) return false;
  return null;
}

function normHeader(raw: unknown): string {
  return cleanText(raw).replace(/\s+/g, ' ').toLowerCase();
}

// ---------------------------------------------------------------------------
// Rohdaten einlesen (CSV oder XLSX) → Matrix von Zellen
// ---------------------------------------------------------------------------

function detectDelimiter(headerLine: string): string {
  const counts: Record<string, number> = { ';': 0, ',': 0, '\t': 0 };
  for (const ch of headerLine) if (ch in counts) counts[ch]++;
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > 0 ? best[0] : ',';
}

export function parseCsv(text: string): string[][] {
  text = text.replace(/^﻿/, ''); // BOM
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const delim = detectDelimiter(firstLine);
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === delim) {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

// Wählt aus einer Arbeitsmappe das Aktivitäts-Blatt (Header-Abgleich + meiste Zeilen).
export function pickSheetRows(wb: XLSX.WorkBook): unknown[][] {
  let best: unknown[][] | null = null;
  let bestScore = -1;
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, {
      header: 1,
      raw: true,
      defval: '',
    });
    const hasHeader = rows.some((r) =>
      r.some((c) => normHeader(c).includes('firma')),
    );
    if (hasHeader && rows.length > bestScore) {
      bestScore = rows.length;
      best = rows;
    }
  }
  if (!best)
    throw new Error('Kein Aktivitäts-Blatt gefunden (Spalte "Firma/Account" fehlt).');
  return best;
}

// Datei-Lesen von der Platte liegt in node.ts (Node-only), damit engine.ts
// im Browser gebündelt werden kann.

// Wie readRows, aber aus einem In-Memory-Puffer (für Web-Uploads). Laufzeit-agnostisch.
export function readRowsFromBuffer(data: Uint8Array, filename: string): unknown[][] {
  if (/\.(csv|tsv|txt)$/i.test(filename)) {
    return parseCsv(new TextDecoder('utf-8').decode(data));
  }
  return pickSheetRows(XLSX.read(data, { type: 'array', cellDates: true }));
}

// ---------------------------------------------------------------------------
// Matrix → Activity[]
// ---------------------------------------------------------------------------

const COLS: Record<string, keyof Activity> = {
  'firma/account': 'firma',
  erstelldatum: 'datum',
  ergebnis: 'ergebnis',
  kommentar: 'kommentar',
  'entscheidergespräch': 'entscheidergespraech',
  'contact funktion': 'contactFunktion',
  // Gaengige Alternativbezeichnungen aus anderen CRM-Exporten
  position: 'contactFunktion',
  funktion: 'contactFunktion',
  jobtitel: 'contactFunktion',
  'job title': 'contactFunktion',
  jobtitle: 'contactFunktion',
  rolle: 'contactFunktion',
  abteilung: 'contactFunktion',
  kontakt: 'kontakt',
  'e-mail': 'email',
  telefon: 'telefon',
  'stadt (postanschrift)': 'stadt',
  zugeordnet: 'zugeordnet',
  'account umsatz': 'umsatz',
  'account mitarbeiter': 'mitarbeiter',
  kampagne: 'kampagne',
};

export function rowsToActivities(rows: unknown[][]): Activity[] {
  const headerIdx = rows.findIndex((r) =>
    r.some((c) => normHeader(c) === 'firma/account'),
  );
  if (headerIdx < 0)
    throw new Error('Header-Zeile mit "Firma/Account" nicht gefunden.');
  const header = rows[headerIdx].map(normHeader);
  const idx: Partial<Record<keyof Activity, number>> = {};
  header.forEach((h, i) => {
    const field = COLS[h];
    if (field) idx[field] = i;
  });

  const activities: Activity[] = [];
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    const get = (f: keyof Activity): unknown =>
      idx[f] !== undefined ? row[idx[f]!] : '';
    const firma = cleanText(get('firma'));
    if (!firma) continue;
    const ergebnis = cleanText(get('ergebnis'));
    const cls = classify(ergebnis);
    activities.push({
      firma,
      datum: parseDate(get('datum')),
      ergebnis,
      kommentar: cleanText(get('kommentar')),
      entscheidergespraech: parseJaNein(get('entscheidergespraech')),
      contactFunktion: cleanText(get('contactFunktion')),
      kontakt: cleanText(get('kontakt')),
      email: cleanText(get('email')),
      telefon: cleanText(get('telefon')),
      stadt: cleanText(get('stadt')),
      zugeordnet: cleanText(get('zugeordnet')),
      umsatz: parseGermanNumber(get('umsatz')),
      mitarbeiter: parseGermanNumber(get('mitarbeiter')),
      kampagne: cleanText(get('kampagne')),
      rank: cls.rank,
      flags: cls.flags,
    });
  }
  return activities;
}

/** In-Memory-Puffer (Upload) → Aktivitäten (Web). */
export function parseActivitiesFromBuffer(
  data: Uint8Array,
  filename: string,
): Activity[] {
  return rowsToActivities(readRowsFromBuffer(data, filename));
}

/** Bequemer Einstieg für Web-Uploads: Puffer → Kennzahlen. */
export function analyzeBuffer(
  data: Uint8Array,
  filename: string,
  opts?: { goalPerMonth?: number },
): Kpis {
  return computeKpis(parseActivitiesFromBuffer(data, filename), opts);
}

// ---------------------------------------------------------------------------
// Aggregation zu Firmen + Kennzahlen
// ---------------------------------------------------------------------------

function maxOrNull(nums: (number | null)[]): number | null {
  const vals = nums.filter((n): n is number => n !== null);
  return vals.length ? Math.max(...vals) : null;
}

// --- Viergrad-Projektkontext (heuristisch; in der App manuell korrigierbar) ---
const PUBLIC_WORDS = [
  'landratsamt', 'landkreis', 'gemeindeverwaltung', 'gemeinde', 'stadtverwaltung',
  'rathaus', 'kommun', 'handwerkskammer', 'industrie- und handelskammer',
  'handelskammer', 'volkshochschule', 'wirtschaftsförderung', 'hochschule',
  'universität', 'ministerium', 'landesbetrieb',
];
// Bewusst mit Wortgrenzen bzw. Zeilenanfang: "Stadt Musterhausen" ist öffentlich,
// "Stadtbäckerei GmbH" oder "Gesamtbau GmbH" dagegen nicht.
const PUBLIC_RE =
  /\b(ihk|hwk|vhs|wfg)\b|^stadt\s|^markt\s|\bstadtwerke\b|\bamt\b|(bezirks|landrats|ordnungs|bau|jugend|schul|gesundheits|umwelt|kultur|sozial|standes|gewerbe|liegenschafts)amt\b|zweckverband|verbandsgemeinde|samtgemeinde|kreisverwaltung|bezirksregierung|regierungspr(ä|ae)sidium|eigenbetrieb|anstalt des öffentlichen/;
const FORM_RE = /\b(gmbh|ag|kg|mbh|ug|gbr|ohg|se|kgaa)\b|e\.?\s?k\.?/;
const COMPETITOR_RE =
  /(agentur|werbe|webdesign|web-design|onlinemarketing|online-marketing|seo-)/;

export function classifySektor(name: string): 'öffentlich' | 'privat' | 'unklar' {
  const n = name.toLowerCase();
  if (PUBLIC_WORDS.some((w) => n.includes(w)) || PUBLIC_RE.test(n)) return 'öffentlich';
  if (FORM_RE.test(n)) return 'privat';
  return 'unklar';
}

// Freitext aus „Contact Funktion" → Abteilung. CRM-Einträge sind uneinheitlich
// („Leiter IT", „IT-Leitung", „EDV" meinen dasselbe), deshalb Stichwort-Erkennung
// statt fester Liste. Reihenfolge = Priorität: Spezifisches vor Allgemeinem
// (z. B. „Technischer Einkäufer" → Einkauf, nicht Technik).
const ABTEILUNGEN: { label: string; re: RegExp }[] = [
  { label: 'Geschäftsführung', re: /gesch(ä|ae)ftsf(ü|ue)hr|gesch(ä|ae)ftsleit|\bgf\b|\bgschf\b|inhaber|eigent(ü|ue)mer|gesellschafter|vorstand|\bceo\b|\bcoo\b|managing director|prokurist/ },
  { label: 'Einkauf', re: /einkauf|eink(ä|ae)ufer|beschaffung|purchas|procurement|materialwirtschaft/ },
  { label: 'IT & EDV', re: /\bit\b|\bit[-\/ ]|\bedv\b|informatik|digitalisierung|\bcio\b|\bciso\b|systemadmin|netzwerk|software/ },
  { label: 'Produktion & Fertigung', re: /produktion|fertigung|werkleit|betriebsleit|montage|schichtleit|\bmeister\b/ },
  { label: 'Technik & Entwicklung', re: /technisch|\btechnik\b|instandhalt|wartung|engineering|konstruktion|entwicklung|\bcto\b/ },
  { label: 'Logistik & Lager', re: /logistik|\blager\b|versand|supply chain|spedition|disposition/ },
  { label: 'Qualität', re: /qualit(ä|ae)t|\bqm\b|\bqs\b|quality/ },
  { label: 'Finanzen & Controlling', re: /finanz|buchhalt|controlling|\bcfo\b|kaufm(ä|ae)nn|rechnungswesen/ },
  { label: 'Personal (HR)', re: /personal|\bhr\b|human resources|recruit|ausbildung/ },
  { label: 'Vertrieb & Marketing', re: /vertrieb|verkauf|\bsales\b|marketing|account manage|kundenbetreuung/ },
  { label: 'Assistenz & Empfang', re: /assist|sekret(ä|ae)r|empfang|zentrale|office manage|back ?office/ },
];

/** Grobe Abteilung zu einer Positionsbezeichnung. Leer → „ohne Angabe". */
export function classifyAbteilung(funktion: string): string {
  const f = (funktion || '').toLowerCase().trim();
  if (!f) return 'ohne Angabe';
  for (const a of ABTEILUNGEN) if (a.re.test(f)) return a.label;
  return 'Sonstige';
}

/**
 * Mit welcher Abteilung entstehen Termine?
 * `gespraeche` zählt Aktivitäten, `termine` zählt Firmen — der Termin wird der
 * Abteilung des Ansprechpartners zugeordnet, mit dem er zustande kam.
 */
function groupAbteilungen(activities: Activity[], won: Company[]): AbteilungKpi[] {
  const map = new Map<string, { gespraeche: number; termine: number }>();
  const bump = (label: string, key: 'gespraeche' | 'termine') => {
    const e = map.get(label) || { gespraeche: 0, termine: 0 };
    e[key]++;
    map.set(label, e);
  };
  for (const a of activities) bump(classifyAbteilung(a.contactFunktion), 'gespraeche');
  for (const c of won) {
    const winAct = c.activities.find((a) => a.rank >= 4);
    if (winAct) bump(classifyAbteilung(winAct.contactFunktion), 'termine');
  }
  return [...map.entries()]
    .map(([label, v]) => ({
      label,
      gespraeche: v.gespraeche,
      termine: v.termine,
      quote: v.gespraeche ? v.termine / v.gespraeche : 0,
    }))
    .sort((a, b) => b.termine - a.termine || b.gespraeche - a.gespraeche);
}

function classifyIcp(
  mitarbeiter: number | null,
  sektor: 'öffentlich' | 'privat' | 'unklar',
  name: string,
): boolean | null {
  if (sektor === 'öffentlich') return false; // Multiplikator, nicht Kern-ICP
  if (COMPETITOR_RE.test(name.toLowerCase())) return false; // Interessenkonflikt
  if (mitarbeiter == null) return null;
  return mitarbeiter >= 5 && mitarbeiter <= 100;
}

function classifyEinwand(
  acts: Activity[],
  won: boolean,
  disq: boolean,
  reachedDM: boolean,
): string {
  if (won) return 'Termin vereinbart';
  const t = acts.map((a) => `${a.kommentar} ${a.ergebnis}`).join(' ').toLowerCase();
  if (/agentur|betreut|dienstleister|festen partner/.test(t)) return 'schon Agentur/Partner';
  if (/datenschutz|dsgvo|cloud|usa|hosting|sicherheit|self-?host/.test(t)) return 'Datenschutz/KI-Skepsis';
  if (/budget|kosten|zu teuer|preis|kein geld|finanz/.test(t)) return 'kein Budget/Bedarf';
  if (/entscheid|rücksprache|gremium|vergabe|freigabe|abstimm|vorstand|geschäftsführung/.test(t))
    return 'Entscheider/Freigabe offen';
  if (disq) return 'grundsätzlich kein Interesse';
  if (!reachedDM) return 'nie erreicht';
  return 'offen / in Bearbeitung';
}

export function aggregateCompanies(activities: Activity[]): Company[] {
  const byName = new Map<string, Activity[]>();
  for (const a of activities) {
    if (!byName.has(a.firma)) byName.set(a.firma, []);
    byName.get(a.firma)!.push(a);
  }

  const companies: Company[] = [];
  for (const [name, acts] of byName) {
    const sorted = [...acts].sort(
      (a, b) => (a.datum?.getTime() ?? 0) - (b.datum?.getTime() ?? 0),
    );
    const dmByGespraech = sorted.some((a) => a.entscheidergespraech === true);
    const won = sorted.some((a) => a.flags.includes('termin'));
    let furthestRank = Math.max(0, ...sorted.map((a) => a.rank));
    if (dmByGespraech) furthestRank = Math.max(furthestRank, 2);
    if (won) furthestRank = 4;
    const reachedDM = furthestRank >= 2 || dmByGespraech;

    let callsToTermin: number | null = null;
    if (won) {
      const terminIdx = sorted.findIndex((a) => a.flags.includes('termin'));
      callsToTermin = terminIdx >= 0 ? terminIdx + 1 : sorted.length;
    }

    const disqualifiziert = sorted.some((a) => a.flags.includes('disqualifiziert'));
    const mitarbeiter = maxOrNull(sorted.map((a) => a.mitarbeiter));
    const sektor = classifySektor(name);

    companies.push({
      name,
      activities: sorted,
      furthestRank,
      stage: stageLabelForRank(furthestRank),
      reachedDM,
      won,
      disqualifiziert,
      fruehAbriss: !reachedDM && !won,
      callsToTermin,
      umsatz: maxOrNull(sorted.map((a) => a.umsatz)),
      mitarbeiter,
      stadt: sorted.map((a) => a.stadt).find((s) => s) ?? '',
      zugeordnet:
        sorted[sorted.length - 1]?.zugeordnet || sorted[0]?.zugeordnet || '',
      sektor,
      icpFit: classifyIcp(mitarbeiter, sektor, name),
      einwand: classifyEinwand(sorted, won, disqualifiziert, reachedDM),
    });
  }
  return companies;
}

function groupCallers(companies: Company[]): CallerKpi[] {
  const by = new Map<string, Company[]>();
  for (const c of companies) {
    const k = c.zugeordnet || '—';
    if (!by.has(k)) by.set(k, []);
    by.get(k)!.push(c);
  }
  return [...by.entries()]
    .map(([name, cs]) => {
      const won = cs.filter((c) => c.won).length;
      const dm = cs.filter((c) => c.reachedDM).length;
      return {
        name,
        companies: cs.length,
        won,
        terminQuote: cs.length ? won / cs.length : 0,
        reachedDM: dm,
        entscheiderQuote: cs.length ? dm / cs.length : 0,
        activities: cs.reduce((n, c) => n + c.activities.length, 0),
      };
    })
    .sort((a, b) => b.terminQuote - a.terminQuote);
}

function segment(
  companies: Company[],
  band: (c: Company) => string,
  order: string[],
): SegmentKpi[] {
  const by = new Map<string, Company[]>();
  for (const c of companies) {
    const k = band(c);
    if (!by.has(k)) by.set(k, []);
    by.get(k)!.push(c);
  }
  return [...by.entries()]
    .map(([label, cs]) => {
      const won = cs.filter((c) => c.won).length;
      return { label, companies: cs.length, won, terminQuote: cs.length ? won / cs.length : 0 };
    })
    .sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label));
}

const REV_ORDER = ['< 1 Mio €', '1–10 Mio €', '10–50 Mio €', '> 50 Mio €', 'unbekannt'];
function revenueBand(c: Company): string {
  const u = c.umsatz;
  if (u == null) return 'unbekannt';
  if (u < 1e6) return '< 1 Mio €';
  if (u < 1e7) return '1–10 Mio €';
  if (u < 5e7) return '10–50 Mio €';
  return '> 50 Mio €';
}

const EMP_ORDER = ['1–49', '50–249', '250+', 'unbekannt'];
function employeeBand(c: Company): string {
  const m = c.mitarbeiter;
  if (m == null) return 'unbekannt';
  if (m < 50) return '1–49';
  if (m < 250) return '50–249';
  return '250+';
}

const SEKTOR_ORDER = ['öffentlich', 'privat', 'unklar'];
function sektorBand(c: Company): string {
  return c.sektor;
}

const ICP_ORDER = ['Kern-ICP', 'außerhalb ICP', 'Größe unklar'];
function icpBand(c: Company): string {
  if (c.icpFit === true) return 'Kern-ICP';
  if (c.icpFit === false) return 'außerhalb ICP';
  return 'Größe unklar';
}

function mode(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = '';
  let bestN = 0;
  for (const [v, n] of counts) if (n > bestN) [best, bestN] = [v, n];
  return best;
}

export function computeKpis(
  activities: Activity[],
  opts: { goalPerMonth?: number } = {},
): Kpis {
  const companies = aggregateCompanies(activities);
  const total = companies.length;
  const won = companies.filter((c) => c.won);
  const reachedDM = companies.filter((c) => c.reachedDM);
  const frueh = companies.filter((c) => c.fruehAbriss);
  const callsArr = won
    .map((c) => c.callsToTermin)
    .filter((n): n is number => n !== null);
  const avgCalls = callsArr.length
    ? callsArr.reduce((a, b) => a + b, 0) / callsArr.length
    : null;

  const funnel = STAGES.map((s) => ({
    stage: s.label,
    rank: s.rank,
    companies: companies.filter((c) => c.furthestRank === s.rank).length,
  }));

  const dates = activities
    .map((a) => a.datum)
    .filter((d): d is Date => !!d)
    .sort((a, b) => a.getTime() - b.getTime());

  // Bearbeitungs-Intensität: Aktivitäten (Anrufversuche) je Firma
  const byAttemptsDesc = [...companies].sort(
    (a, b) => b.activities.length - a.activities.length,
  );
  const compactCompany = (c: Company) => ({
    name: c.name,
    attempts: c.activities.length,
    stage: c.stage,
    won: c.won,
    reachedDM: c.reachedDM,
  });
  const mostContacted = byAttemptsDesc.slice(0, 5).map(compactCompany);
  const leastContacted = [...byAttemptsDesc].reverse().slice(0, 5).map(compactCompany);
  // "Schwer zu knacken": viel Aufwand, aber kein Termin
  const hardCases = byAttemptsDesc
    .filter((c) => !c.won && !c.disqualifiziert)
    .slice(0, 5)
    .map(compactCompany);

  // Tages-Zeitreihe (für Verlauf/Charts)
  const dayMap = new Map<string, number>();
  for (const a of activities) {
    if (a.datum) {
      const key = a.datum.toISOString().slice(0, 10);
      dayMap.set(key, (dayMap.get(key) ?? 0) + 1);
    }
  }
  const timeline = [...dayMap.entries()]
    .sort((x, y) => (x[0] < y[0] ? -1 : 1))
    .map(([date, count]) => ({ date, activities: count }));

  // Einwand-Verteilung (warum (noch) kein Termin)
  const einwandCounts = new Map<string, number>();
  for (const c of companies) {
    einwandCounts.set(c.einwand, (einwandCounts.get(c.einwand) ?? 0) + 1);
  }
  const byEinwand = [...einwandCounts.entries()]
    .map(([label, n]) => ({ label, companies: n }))
    .sort((a, b) => b.companies - a.companies);

  // Zielerreichung gegenüber Monatsziel
  const goalPerMonth = opts.goalPerMonth ?? 3;
  const months =
    dates.length >= 2
      ? Math.max(
          (dates[dates.length - 1].getTime() - dates[0].getTime()) /
            (1000 * 60 * 60 * 24 * 30.44),
          0.5,
        )
      : 1;
  const goal = {
    perMonth: goalPerMonth,
    months,
    wonPerMonth: won.length / months,
    attainment: goalPerMonth > 0 ? won.length / months / goalPerMonth : 0,
  };

  return {
    campaign: mode(activities.map((a) => a.kampagne).filter(Boolean)),
    totalCompanies: total,
    totalActivities: activities.length,
    terminQuote: total ? won.length / total : 0,
    wonCompanies: won.length,
    entscheiderQuote: total ? reachedDM.length / total : 0,
    reachedDMCompanies: reachedDM.length,
    fruehAbrissRate: total ? frueh.length / total : 0,
    fruehAbrissCompanies: frueh.length,
    avgCallsToTermin: avgCalls,
    avgAttemptsPerCompany: total ? activities.length / total : 0,
    funnel,
    disqualifiziertCompanies: companies.filter((c) => c.disqualifiziert).length,
    mostContacted,
    leastContacted,
    hardCases,
    byAkquisiteur: groupCallers(companies),
    byRevenueBand: segment(companies, revenueBand, REV_ORDER),
    byEmployeeBand: segment(companies, employeeBand, EMP_ORDER),
    bySektor: segment(companies, sektorBand, SEKTOR_ORDER),
    byIcp: segment(companies, icpBand, ICP_ORDER),
    byEinwand,
    byAbteilung: groupAbteilungen(activities, won),
    goal,
    timeline,
    dateRange: { from: dates[0] ?? null, to: dates[dates.length - 1] ?? null },
  };
}

// analyzeFile / parseActivities (Pfad-basiert) liegen in node.ts.

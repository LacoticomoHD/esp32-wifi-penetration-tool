// Deterministische Tests gegen eine synthetische Fixture (keine echten Daten).
// Nutzung:  npm test

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { analyzeFile, parseActivities } from '../src/node';
import {
  analyzeBuffer,
  parseGermanNumber,
  parseDate,
  aggregateCompanies,
  classifyAbteilung,
  classifySektor,
  computeKpis,
} from '../src/engine';
import { normPhone, phoneKeys, matchKey, buildPhoneIndex, computeAircall, type AircallCall } from '../src/aircall';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, 'fixture.csv');

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}  ${detail}`);
  }
}
function approx(a: number | null, b: number, eps = 1e-9): boolean {
  return a !== null && Math.abs(a - b) < eps;
}

console.log('\nGerman number parsing');
check('"12.000.000,00 €" → 12000000', parseGermanNumber('12.000.000,00 €') === 12000000);
check('"1.000.000,00 €" → 1000000', parseGermanNumber('1.000.000,00 €') === 1000000);
check('"64000000" → 64000000', parseGermanNumber('64000000') === 64000000);
check('"5.200.000" → 5200000', parseGermanNumber('5.200.000') === 5200000);
check('"1,5" → 1.5', parseGermanNumber('1,5') === 1.5);
check('empty → null', parseGermanNumber('') === null);

console.log('\nDate parsing');
check('"05.06.2026" → 2026-06-05', parseDate('05.06.2026')?.getFullYear() === 2026 && parseDate('05.06.2026')?.getMonth() === 5 && parseDate('05.06.2026')?.getDate() === 5);

console.log('\nFixture parsing (German CSV, semicolon delimiter)');
const acts = parseActivities(fixture);
check('7 Aktivitäten geparst', acts.length === 7, `got ${acts.length}`);
const companies = aggregateCompanies(acts);
check('4 Firmen aggregiert', companies.length === 4, `got ${companies.length}`);

console.log('\nKPIs');
const k = analyzeFile(fixture);
check('Kampagne = TestKampagne', k.campaign === 'TestKampagne', k.campaign);
check('4 Firmen', k.totalCompanies === 4);
check('Termin-Quote = 25% (Alpha)', approx(k.terminQuote, 0.25), String(k.terminQuote));
check('1 Gewinner-Firma', k.wonCompanies === 1);
check('Anrufe bis Termin = 3.0 (Alpha)', approx(k.avgCallsToTermin, 3));
check('Entscheider-Quote = 75% (Alpha, Gamma, Delta)', approx(k.entscheiderQuote, 0.75), String(k.entscheiderQuote));
check('Früh-Abriss = 25% (nur Beta)', approx(k.fruehAbrissRate, 0.25), String(k.fruehAbrissRate));
check('1 disqualifizierte Firma (Gamma)', k.disqualifiziertCompanies === 1);

const revBands = Object.fromEntries(k.byRevenueBand.map((s) => [s.label, s]));
check('Umsatz-Klasse 1–10 Mio: 1/2 Termine', revBands['1–10 Mio €']?.won === 1 && revBands['1–10 Mio €']?.companies === 2, JSON.stringify(revBands['1–10 Mio €']));

console.log('\nBearbeitung & schwierige Fälle');
check('Ø Anrufversuche = 1.75', approx(k.avgAttemptsPerCompany, 1.75), String(k.avgAttemptsPerCompany));
check('Meist bearbeitet = Alpha (3×)', k.mostContacted[0]?.name === 'Alpha GmbH' && k.mostContacted[0]?.attempts === 3, JSON.stringify(k.mostContacted[0]));
check('Schwerster Fall = Beta (2×, kein Termin)', k.hardCases[0]?.name === 'Beta AG' && k.hardCases[0]?.attempts === 2, JSON.stringify(k.hardCases[0]));
check('Disqualifizierte nicht in hardCases', !k.hardCases.some((c) => c.name === 'Gamma GmbH'));
check('Timeline summiert 7 Aktivitäten', k.timeline.reduce((n, d) => n + d.activities, 0) === 7, JSON.stringify(k.timeline));

console.log('\nViergrad-Dimensionen (Sektor / ICP / Ziel / Einwände)');
const sekt = Object.fromEntries(k.bySektor.map((s) => [s.label, s]));
check('Sektor: 4 private Firmen (GmbH/AG)', sekt['privat']?.companies === 4, JSON.stringify(k.bySektor));
const icp = Object.fromEntries(k.byIcp.map((s) => [s.label, s]));
check('ICP: Kern-ICP 2 Firmen, 1 Termin (Alpha, Gamma)', icp['Kern-ICP']?.companies === 2 && icp['Kern-ICP']?.won === 1, JSON.stringify(icp['Kern-ICP']));
check('ICP: außerhalb 2 Firmen, 0 Termine (Beta 300 / Delta 120 MA)', icp['außerhalb ICP']?.companies === 2 && icp['außerhalb ICP']?.won === 0, JSON.stringify(icp['außerhalb ICP']));
check('Ziel: default 3/Monat, Ist 2/Monat', k.goal.perMonth === 3 && approx(k.goal.wonPerMonth, 2), JSON.stringify(k.goal));
check('Ziel: goalPerMonth-Override greift', analyzeFile(fixture, { goalPerMonth: 5 }).goal.perMonth === 5);
const einw = Object.fromEntries(k.byEinwand.map((e) => [e.label, e.companies]));
check('Einwand: Beta = nie erreicht', einw['nie erreicht'] === 1, JSON.stringify(k.byEinwand));
check('Einwand: Gamma = grundsätzlich kein Interesse', einw['grundsätzlich kein Interesse'] === 1);
check('Einwand: Alpha = Termin vereinbart', einw['Termin vereinbart'] === 1);

console.log('\nSektor-Erkennung (nur relevant, wo Behörden angerufen werden)');
const sek = (n: string) => classifySektor(n);
check('"Stadt Musterhausen" → öffentlich', sek('Stadt Musterhausen') === 'öffentlich', sek('Stadt Musterhausen'));
check('"Stadtwerke Musterstadt" → öffentlich', sek('Stadtwerke Musterstadt') === 'öffentlich', sek('Stadtwerke Musterstadt'));
check('"Bezirksamt Nord" → öffentlich', sek('Bezirksamt Nord') === 'öffentlich', sek('Bezirksamt Nord'));
check('"Markt Schwaben" → öffentlich', sek('Markt Schwaben') === 'öffentlich', sek('Markt Schwaben'));
check('"Zweckverband Wasser" → öffentlich', sek('Zweckverband Wasser') === 'öffentlich', sek('Zweckverband Wasser'));
check('"Gesamtbau GmbH" → privat (kein Amt-Treffer)', sek('Gesamtbau GmbH') === 'privat', sek('Gesamtbau GmbH'));
check('"Stadtbäckerei Müller GmbH" → privat', sek('Stadtbäckerei Müller GmbH') === 'privat', sek('Stadtbäckerei Müller GmbH'));
check('"Baumarkt Schmidt GmbH" → privat', sek('Baumarkt Schmidt GmbH') === 'privat', sek('Baumarkt Schmidt GmbH'));
check('"Hauptstadt Immobilien AG" → privat', sek('Hauptstadt Immobilien AG') === 'privat', sek('Hauptstadt Immobilien AG'));

console.log('\nAbteilungs-Zuordnung (Contact Funktion → Abteilung)');
const abt = (s: string) => classifyAbteilung(s);
check('"Leiter IT" → IT & EDV', abt('Leiter IT') === 'IT & EDV', abt('Leiter IT'));
check('"IT-Leitung" → IT & EDV', abt('IT-Leitung') === 'IT & EDV', abt('IT-Leitung'));
check('"EDV" → IT & EDV', abt('EDV') === 'IT & EDV', abt('EDV'));
check('"Qualitätsleiter" → Qualität (nicht IT)', abt('Qualitätsleiter') === 'Qualität', abt('Qualitätsleiter'));
check('"Geschäftsführer" → Geschäftsführung', abt('Geschäftsführer') === 'Geschäftsführung', abt('Geschäftsführer'));
check('"GF" (Abkürzung) → Geschäftsführung', abt('GF') === 'Geschäftsführung', abt('GF'));
check('"Technischer Einkäufer" → Einkauf (vor Technik)', abt('Technischer Einkäufer') === 'Einkauf', abt('Technischer Einkäufer'));
check('"Produktionsleiter" → Produktion & Fertigung', abt('Produktionsleiter') === 'Produktion & Fertigung', abt('Produktionsleiter'));
check('"Leiter Instandhaltung" → Technik & Entwicklung', abt('Leiter Instandhaltung') === 'Technik & Entwicklung', abt('Leiter Instandhaltung'));
check('"Marketing" → Vertrieb & Marketing', abt('Marketing') === 'Vertrieb & Marketing', abt('Marketing'));
check('"Zentrale" → Assistenz & Empfang', abt('Zentrale') === 'Assistenz & Empfang', abt('Zentrale'));
check('leer → ohne Angabe', abt('') === 'ohne Angabe', abt(''));
check('"Leitung" (generisch) → Sonstige', abt('Leitung') === 'Sonstige', abt('Leitung'));

console.log('\nTermine je Abteilung (Fixture)');
const byAbt = Object.fromEntries(k.byAbteilung.map((a) => [a.label, a]));
check('Alpha-Termin zählt auf Geschäftsführung? (Fixture: Leitung)', k.byAbteilung.reduce((n, a) => n + a.termine, 0) === k.wonCompanies, JSON.stringify(k.byAbteilung));
check('Gespräche insgesamt = Aktivitäten', k.byAbteilung.reduce((n, a) => n + a.gespraeche, 0) === k.totalActivities, JSON.stringify(k.byAbteilung));
check('Quote = termine/gespraeche', k.byAbteilung.every((a) => approx(a.quote, a.gespraeche ? a.termine / a.gespraeche : 0)), JSON.stringify(byAbt));

console.log('\nUpload-Pfad (Puffer statt Datei)');
const kBuf = analyzeBuffer(readFileSync(fixture), 'fixture.csv');
check('analyzeBuffer == analyzeFile (4 Firmen)', kBuf.totalCompanies === 4);
check('analyzeBuffer Termin-Quote identisch', approx(kBuf.terminQuote, k.terminQuote));

console.log('\nEntscheider-Quote ab Erfassungsbeginn');
check('Fixture: Erfassung ab 02.06., alle 4 Firmen in der Basis', k.entscheiderBasis.firmen === 4, JSON.stringify(k.entscheiderBasis));
const spaet = acts.map((a) => ({ ...a, entscheidergespraech: a.datum && a.datum.getDate() < 5 ? null : a.entscheidergespraech }));
const kSpaet = computeKpis(spaet);
check('Erfassung erst ab 05.06. → seit = 05.06.', kSpaet.entscheiderBasis.seit?.getDate() === 5, String(kSpaet.entscheiderBasis.seit));
check('Basis = nur Alpha (einzige Firma seit 05.06.)', kSpaet.entscheiderBasis.firmen === 1);
check('Entscheider-Quote = 100 % (1/1)', approx(kSpaet.entscheiderQuote, 1), String(kSpaet.entscheiderQuote));
check('Früh-Abriss = 0 % in der Basis', approx(kSpaet.fruehAbrissRate, 0));
check('Termin-Quote bleibt auf allen Firmen (25 %)', approx(kSpaet.terminQuote, 0.25));
const ohneSpalte = computeKpis(acts.map((a) => ({ ...a, entscheidergespraech: null })));
check('Spalte leer → ganzer Zeitraum', ohneSpalte.entscheiderBasis.seit === null && ohneSpalte.entscheiderBasis.firmen === 4);

console.log('\nAircall-Abgleich (Telefonnummer → Firma)');
check('"089 123456-0" → 49891234560', normPhone('089 123456-0') === '49891234560', normPhone('089 123456-0'));
check('"+49 (0) 89 123456" → 4989123456', normPhone('+49 (0) 89 123456') === '4989123456', normPhone('+49 (0) 89 123456'));
check('"0049 30 1234567" → 49301234567', normPhone('0049 30 1234567') === '49301234567');
check('Stammnummer aus "089 123456-0" = 4989123456', phoneKeys('089 123456-0').prefix === '4989123456', JSON.stringify(phoneKeys('089 123456-0')));
check('ohne Durchwahl kein Präfix', phoneKeys('+49 89 1234560').prefix === null);
const ex = new Set(['49891234560']), px = new Set(['4989123456']);
check('exakter Treffer', matchKey('49891234560', ex, px) === '49891234560');
check('andere Durchwahl → Stammnummer', matchKey('4989123456789', ex, px) === 'p:4989123456');
check('fremde Nummer → kein Treffer', matchKey('4940999999', ex, px) === null);
const idx = buildPhoneIndex([{ ...acts[0], telefon: '089 123456-0' }]);
check('Index: Nummer + Stammnummer → Alpha', idx.firmaByKey.get('49891234560') === 'Alpha GmbH' && idx.firmaByKey.get('p:4989123456') === 'Alpha GmbH', JSON.stringify([...idx.firmaByKey]));
check('Index: zu kurze Nummern ignoriert (+49 30 1)', !buildPhoneIndex(acts).exact.includes('49301'));
const keyMap = new Map([['49301', 'Alpha GmbH'], ['49402', 'Beta AG']]);
const t0 = new Date(2026, 5, 1, 10, 0).getTime() / 1000;
const acCalls: AircallCall[] = [
  { k: '49301', u: 'Max', s: t0, a: null, e: t0 + 20 },                       // Alpha, nicht angenommen
  { k: '49301', u: 'Max', s: t0 + 86400 * 2, a: t0 + 86400 * 2 + 10, e: t0 + 86400 * 2 + 130 }, // Alpha, 2 Min
  { k: '49301', u: 'Max', s: t0 + 86400 * 4, a: t0 + 86400 * 4 + 5, e: t0 + 86400 * 4 + 25 },   // Alpha, Termintag, 20 s
  { k: '49301', u: 'Max', s: t0 + 86400 * 9, a: null, e: t0 + 86400 * 9 + 30 },                 // nach dem Termin
  { k: '49402', u: 'Eva', s: t0, a: null, e: t0 + 25 },                       // Beta
  { k: '49999', u: 'Eva', s: t0, a: null, e: t0 + 25 },                       // unbekannt → ignoriert
];
const ac = computeAircall(acts, acCalls, keyMap);
check('5 zugeordnete Wählversuche', ac.calls === 5, String(ac.calls));
check('2 angenommen, 1 Gespräch ≥ 60 s', ac.answered === 2 && ac.gespraeche === 1, JSON.stringify(ac));
check('Gesprächszeit = 140 s', ac.talkSec === 140, String(ac.talkSec));
check('Wählversuche bis Termin (Alpha) = 3', approx(ac.avgCallsToTermin, 3), String(ac.avgCallsToTermin));
check('je Akquisiteur: Max 4, Eva 1', ac.byUser[0]?.name === 'Max' && ac.byUser[0]?.calls === 4 && ac.byUser[1]?.calls === 1);
check('2 von 4 Firmen angewählt', ac.firmenAngewaehlt === 2 && ac.firmen === 4);

console.log('');
if (failures) {
  console.error(`FEHLGESCHLAGEN: ${failures} Prüfung(en).`);
  process.exit(1);
} else {
  console.log('Alle Prüfungen bestanden. ✓\n');
}

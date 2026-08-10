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
} from '../src/engine';

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

console.log('\nUpload-Pfad (Puffer statt Datei)');
const kBuf = analyzeBuffer(readFileSync(fixture), 'fixture.csv');
check('analyzeBuffer == analyzeFile (4 Firmen)', kBuf.totalCompanies === 4);
check('analyzeBuffer Termin-Quote identisch', approx(kBuf.terminQuote, k.terminQuote));

console.log('');
if (failures) {
  console.error(`FEHLGESCHLAGEN: ${failures} Prüfung(en).`);
  process.exit(1);
} else {
  console.log('Alle Prüfungen bestanden. ✓\n');
}

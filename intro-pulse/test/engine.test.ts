// Deterministische Tests gegen eine synthetische Fixture (keine echten Daten).
// Nutzung:  npm test

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  analyzeFile,
  parseGermanNumber,
  parseDate,
  parseActivities,
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

console.log('');
if (failures) {
  console.error(`FEHLGESCHLAGEN: ${failures} Prüfung(en).`);
  process.exit(1);
} else {
  console.log('Alle Prüfungen bestanden. ✓\n');
}

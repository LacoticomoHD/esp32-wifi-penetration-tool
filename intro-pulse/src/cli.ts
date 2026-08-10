// CLI-Runner: analysiert eine Aktivitätsdatei und gibt einen Textreport aus.
// Nutzung:  npm run analyze -- <pfad-zur-datei.xlsx|csv>

import { analyzeFile } from './engine';
import type { Kpis } from './types';

function pct(n: number): string {
  return (n * 100).toFixed(1) + ' %';
}

function bar(n: number, max: number, width = 24): string {
  if (max <= 0) return '';
  const len = Math.round((n / max) * width);
  return '█'.repeat(len) + '·'.repeat(width - len);
}

function fmtDate(d: Date | null): string {
  return d ? d.toLocaleDateString('de-DE') : '—';
}

function report(k: Kpis): string {
  const L: string[] = [];
  L.push('');
  L.push('══════════════════════════════════════════════════════════════');
  L.push(`  INTRO PULSE · Kampagne: ${k.campaign || '—'}`);
  L.push(`  Zeitraum: ${fmtDate(k.dateRange.from)} – ${fmtDate(k.dateRange.to)}`);
  L.push('══════════════════════════════════════════════════════════════');
  L.push('');
  L.push(`  Firmen gesamt:        ${k.totalCompanies}`);
  L.push(`  Aktivitäten gesamt:   ${k.totalActivities}`);
  L.push('');
  L.push('  ── Kennzahlen ────────────────────────────────────────────');
  L.push(`  ► Termin-Quote:       ${pct(k.terminQuote)}   (${k.wonCompanies} von ${k.totalCompanies} Firmen)`);
  L.push(`    Anrufe bis Termin:  ${k.avgCallsToTermin !== null ? k.avgCallsToTermin.toFixed(1) : '—'} Ø`);
  L.push(`    Entscheider-Quote:  ${pct(k.entscheiderQuote)}   (${k.reachedDMCompanies} Firmen)`);
  L.push(`    Früh-Abriss-Rate:   ${pct(k.fruehAbrissRate)}   (${k.fruehAbrissCompanies} Firmen nie einen Entscheider erreicht)`);
  L.push(`    Disqualifiziert:    ${k.disqualifiziertCompanies} Firmen`);
  L.push(`    Ø Anrufversuche:    ${k.avgAttemptsPerCompany.toFixed(1)} je Firma`);
  L.push('');
  L.push('  ── Funnel (Firmen je weitester Stufe) ────────────────────');
  const maxF = Math.max(...k.funnel.map((f) => f.companies), 1);
  for (const f of k.funnel) {
    if (f.rank === 0) continue;
    L.push(`    ${f.stage.padEnd(22)} ${String(f.companies).padStart(3)}  ${bar(f.companies, maxF)}`);
  }
  L.push('');
  L.push('  ── Je Akquisiteur ────────────────────────────────────────');
  for (const c of k.byAkquisiteur) {
    L.push(`    ${c.name.padEnd(22)} Termin-Quote ${pct(c.terminQuote).padStart(7)}  (${c.won}/${c.companies} Firmen, ${c.activities} Aktivitäten)`);
  }
  L.push('');
  L.push('  ── Bearbeitung (Anrufversuche je Firma) ──────────────────');
  L.push('    Meist bearbeitet:');
  for (const c of k.mostContacted) {
    L.push(`      ${c.name.slice(0, 34).padEnd(34)} ${String(c.attempts).padStart(2)}×  → ${c.stage}${c.won ? ' ✅' : ''}`);
  }
  L.push('');
  L.push('  ── Schwer zu knacken (viel Aufwand, kein Termin) ─────────');
  for (const c of k.hardCases) {
    L.push(`      ${c.name.slice(0, 34).padEnd(34)} ${String(c.attempts).padStart(2)}×  → ${c.stage}${c.reachedDM ? ' (Entscheider erreicht)' : ''}`);
  }
  L.push('');
  L.push('  ── Termin-Quote je Umsatz-Klasse ─────────────────────────');
  for (const s of k.byRevenueBand) {
    L.push(`    ${s.label.padEnd(14)} ${pct(s.terminQuote).padStart(7)}  (${s.won}/${s.companies})`);
  }
  L.push('');
  L.push('  ── Termin-Quote je Mitarbeiter-Klasse ────────────────────');
  for (const s of k.byEmployeeBand) {
    L.push(`    ${s.label.padEnd(14)} ${pct(s.terminQuote).padStart(7)}  (${s.won}/${s.companies})`);
  }
  L.push('');
  return L.join('\n');
}

const path = process.argv[2];
if (!path) {
  console.error('Bitte Pfad zur Datei angeben:  npm run analyze -- <datei.xlsx|csv>');
  process.exit(1);
}
try {
  console.log(report(analyzeFile(path)));
} catch (err) {
  console.error('Fehler bei der Analyse:', (err as Error).message);
  process.exit(1);
}

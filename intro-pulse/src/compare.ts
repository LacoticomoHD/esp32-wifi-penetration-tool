// Vergleich zweier Report-Staende (Snapshots). Rein funktional, ohne DOM/DB —
// damit in Browser, Node und Tests nutzbar. Speist die "Δ zum Vorreport"-Anzeige.

import type { Kpis } from './types';

export interface KpiDelta {
  key: string;
  label: string;
  unit: 'pct' | 'count' | 'dec';
  current: number;
  previous: number | null;      // null = kein Vorreport vorhanden
  delta: number | null;         // current - previous
  goodDirection: 'up' | 'down'; // in welche Richtung ist "besser"?
  improved: boolean | null;     // hat sich der Wert verbessert? (null = neutral/kein Vergleich)
}

function row(
  key: string,
  label: string,
  unit: KpiDelta['unit'],
  current: number,
  previous: number | null,
  goodDirection: 'up' | 'down',
): KpiDelta {
  const delta = previous == null ? null : current - previous;
  const improved =
    delta == null || delta === 0 ? null : goodDirection === 'up' ? delta > 0 : delta < 0;
  return { key, label, unit, current, previous, delta, goodDirection, improved };
}

/**
 * Kern-Kennzahlen des aktuellen Reports gegen den Vorreport.
 * `prev = null` liefert die Werte ohne Delta (erster Stand).
 */
export function diffKpis(curr: Kpis, prev: Kpis | null): KpiDelta[] {
  const p = prev;
  return [
    row('terminQuote', 'Termin-Quote', 'pct', curr.terminQuote, p ? p.terminQuote : null, 'up'),
    row('wonCompanies', 'Termine', 'count', curr.wonCompanies, p ? p.wonCompanies : null, 'up'),
    row('entscheiderQuote', 'Entscheider-Quote', 'pct', curr.entscheiderQuote, p ? p.entscheiderQuote : null, 'up'),
    row('fruehAbrissRate', 'Früh-Abriss', 'pct', curr.fruehAbrissRate, p ? p.fruehAbrissRate : null, 'down'),
    row('avgAttemptsPerCompany', 'Ø Versuche/Firma', 'dec', curr.avgAttemptsPerCompany, p ? p.avgAttemptsPerCompany : null, 'down'),
    row('totalCompanies', 'Firmen', 'count', curr.totalCompanies, p ? p.totalCompanies : null, 'up'),
    row('goalAttainment', 'Zielerreichung', 'pct', curr.goal.attainment, p ? p.goal.attainment : null, 'up'),
  ];
}

/** Firmen, die im neuen Report eine weitere Funnel-Stufe erreicht haben (Fortschritt). */
export function movedForward(
  curr: { name: string; rank: number }[],
  prev: { name: string; rank: number }[],
): { name: string; from: number; to: number }[] {
  const before = new Map(prev.map((c) => [c.name, c.rank]));
  const out: { name: string; from: number; to: number }[] = [];
  for (const c of curr) {
    const was = before.get(c.name);
    if (was != null && c.rank > was) out.push({ name: c.name, from: was, to: c.rank });
  }
  return out.sort((a, b) => b.to - b.from - (a.to - a.from));
}

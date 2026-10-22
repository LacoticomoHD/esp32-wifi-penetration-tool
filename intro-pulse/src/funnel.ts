// Funnel-Mapping: bildet die `Ergebnis`-Werte aus der Aktivitätsliste auf
// Funnel-Stufen ab. Dies ist die fachlich abgestimmte Kernlogik (SPEC.md §4)
// und die Stelle, an der neue `Ergebnis`-Ausprägungen ergänzt werden.

import type { Flag } from './types';

export interface ErgebnisMapping {
  rank: number;
  stage: string;
  flags: Flag[];
}

export const STAGES = [
  { rank: 0, label: 'Lead' },
  { rank: 1, label: 'Kontaktversuch' },
  { rank: 2, label: 'Entscheider erreicht' },
  { rank: 3, label: 'Interesse' },
  { rank: 4, label: 'Termin vereinbart' },
] as const;

function norm(s: string): string {
  return s
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const MAP: Record<string, ErgebnisMapping> = {
  'nicht erreicht': { rank: 1, stage: 'Kontaktversuch', flags: ['nie_erreicht'] },
  'dauerhaft nicht erreicht': { rank: 1, stage: 'Kontaktversuch', flags: ['nie_erreicht'] },
  'falscher ansprechpartner': { rank: 1, stage: 'Kontaktversuch', flags: ['ap_recherche'] },
  'entscheider erreicht, nochmal anrufen': { rank: 2, stage: 'Entscheider erreicht', flags: [] },
  'grundsätzlich kein interesse / kampagnen-stopp': { rank: 2, stage: 'Entscheider erreicht', flags: ['disqualifiziert'] },
  'infomaterial angefordert (e-mail)': { rank: 3, stage: 'Interesse', flags: ['info_phase'] },
  'input erhalten': { rank: 3, stage: 'Interesse', flags: ['info_phase'] },
  'zukünftiges interesse': { rank: 3, stage: 'Interesse', flags: ['nurture'] },
  'kurzfristiges interesse': { rank: 3, stage: 'Interesse', flags: ['nurture'] },
  'aktuell kein interesse': { rank: 3, stage: 'Interesse', flags: ['wiedervorlage'] },
  'entscheider, ersttermin vereinbart': { rank: 4, stage: 'Termin vereinbart', flags: ['termin'] },
};

/** Klassifiziert einen `Ergebnis`-Wert. Unbekannte Werte werden defensiv
 *  über Schlüsselwörter eingeordnet, damit neue Kampagnen nicht abstürzen. */
export function classify(ergebnis: string): ErgebnisMapping {
  const key = norm(ergebnis);
  if (key in MAP) return MAP[key];
  if (!key) return { rank: 1, stage: 'Kontaktversuch', flags: ['unbekannt'] };
  if (key.includes('ersttermin') || key.includes('termin vereinbart'))
    return { rank: 4, stage: 'Termin vereinbart', flags: ['termin'] };
  if (key.includes('kein interesse') || key.includes('stopp'))
    return { rank: 2, stage: 'Entscheider erreicht', flags: ['disqualifiziert'] };
  if (key.includes('interesse') || key.includes('infomaterial') || key.includes('input'))
    return { rank: 3, stage: 'Interesse', flags: ['nurture'] };
  if (key.includes('falscher'))
    return { rank: 1, stage: 'Kontaktversuch', flags: ['ap_recherche'] };
  if (key.includes('entscheider'))
    return { rank: 2, stage: 'Entscheider erreicht', flags: [] };
  if (key.includes('nicht erreicht'))
    return { rank: 1, stage: 'Kontaktversuch', flags: ['nie_erreicht'] };
  return { rank: 1, stage: 'Kontaktversuch', flags: ['unbekannt'] };
}

export function stageLabelForRank(rank: number): string {
  for (let i = STAGES.length - 1; i >= 0; i--) {
    if (rank >= STAGES[i].rank) return STAGES[i].label;
  }
  return 'Lead';
}

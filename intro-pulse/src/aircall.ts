// Aircall-Abgleich: echte Wählversuche aus der Telefonanlage statt nur der im
// CRM protokollierten Aktivitäten. Zuordnung Anruf → Firma über die Telefon-
// nummer aus dem Export (exakt oder über die Stammnummer bei Durchwahlen).

import type { Activity } from './types';

/** Aircall-Anruf, wie ihn die Server-Funktion kompakt zurückgibt. */
export interface AircallCall {
  k: string; // Zuordnungsschlüssel (exakte Nummer oder "p:<Stammnummer>")
  u: string; // Aircall-Benutzer (wer hat gewählt)
  s: number; // started_at (Unix, Sekunden)
  a: number | null; // answered_at — null = nicht angenommen
  e: number; // ended_at
}

/** Ab dieser Gesprächsdauer zählt ein angenommener Anruf als echtes Gespräch
 *  (darunter meist Mailbox, Zentrale oder sofortiges Abwimmeln). */
export const GESPRAECH_MIN_SEK = 60;

/** Telefonnummer → nur Ziffern mit Ländercode (Deutschland als Vorgabe). */
export function normPhone(raw: string): string {
  const s = String(raw || '').replace(/\(0\)/g, '').trim();
  const d = s.replace(/\D/g, '');
  if (!d) return '';
  if (s.startsWith('+')) return d;
  if (d.startsWith('00')) return d.slice(2);
  if (d.startsWith('0')) return '49' + d.slice(1);
  return d;
}

/** Schlüssel einer CRM-Nummer: die volle Nummer und – falls die Nummer mit
 *  abgesetzter Durchwahl geschrieben ist (089 123456-0) – die Stammnummer als
 *  Präfix. So passt ein Anruf auf eine andere Durchwahl derselben Firma. */
export function phoneKeys(raw: string): { exact: string; prefix: string | null } {
  const exact = normPhone(raw);
  const m = String(raw || '').match(/^(.*\d)[\s\-/]+\d{1,4}\s*$/);
  const base = m ? normPhone(m[1]) : '';
  return { exact, prefix: base.length >= 9 && base !== exact ? base : null };
}

export interface PhoneIndex {
  exact: string[];
  prefix: string[];
  firmaByKey: Map<string, string>;
}

/** Alle Nummern der Aktivitäten → Schlüssel-Listen für den Server + Rückweg zur Firma. */
export function buildPhoneIndex(acts: Activity[]): PhoneIndex {
  const firmaByKey = new Map<string, string>();
  const exact = new Set<string>();
  const prefix = new Set<string>();
  for (const a of acts) {
    if (!a.telefon) continue;
    for (const part of a.telefon.split(/[;,]| \/ /)) {
      const { exact: ex, prefix: px } = phoneKeys(part);
      if (ex.length >= 6) {
        exact.add(ex);
        if (!firmaByKey.has(ex)) firmaByKey.set(ex, a.firma);
      }
      if (px) {
        prefix.add(px);
        if (!firmaByKey.has('p:' + px)) firmaByKey.set('p:' + px, a.firma);
      }
    }
  }
  return { exact: [...exact], prefix: [...prefix], firmaByKey };
}

/** Gleiche Logik wie in der Server-Funktion: exakt, sonst längste Stammnummer. */
export function matchKey(digits: string, exact: Set<string>, prefix: Set<string>): string | null {
  if (exact.has(digits)) return digits;
  for (let l = digits.length - 1; l >= 9; l--) {
    const p = digits.slice(0, l);
    if (prefix.has(p)) return 'p:' + p;
  }
  return null;
}

export interface AircallKpis {
  calls: number; // Wählversuche zu Firmen dieser Ansicht
  answered: number; // angenommen (inkl. Mailbox/Zentrale)
  gespraeche: number; // angenommen und ≥ GESPRAECH_MIN_SEK
  reachRate: number; // answered / calls
  talkSec: number; // Summe Gesprächszeit (ab Annahme)
  avgTalkSec: number | null; // Ø Dauer der echten Gespräche
  crmActivities: number; // zum Vergleich: im CRM erfasste Aktivitäten
  firmen: number; // Firmen in der Ansicht
  firmenAngewaehlt: number; // davon mind. 1× in Aircall
  avgCallsPerFirma: number | null; // je angewählter Firma
  callsPerTermin: number | null; // alle Wählversuche / Termine
  avgCallsToTermin: number | null; // Wählversuche bis zum Termintag, je Terminfirma
  byUser: { name: string; calls: number; answered: number; gespraeche: number; talkSec: number }[];
  byHour: { hour: number; calls: number; answered: number }[];
  topFirmen: { name: string; calls: number; answered: number; won: boolean }[];
}

/** Kennzahlen aus den Aircall-Anrufen für die (ggf. gefilterte) Aktivitätsliste. */
export function computeAircall(acts: Activity[], calls: AircallCall[], firmaByKey: Map<string, string>): AircallKpis {
  const firmen = new Set(acts.map((a) => a.firma));
  // Termintag je Firma (erste Termin-Aktivität) — für „Anrufe bis Termin".
  const terminTag = new Map<string, number>();
  for (const a of acts) {
    if (a.rank < 4) continue;
    const t = a.datum ? new Date(a.datum.getFullYear(), a.datum.getMonth(), a.datum.getDate() + 1).getTime() / 1000 : Infinity;
    terminTag.set(a.firma, Math.min(terminTag.get(a.firma) ?? Infinity, t));
  }

  const perFirma = new Map<string, { calls: number; answered: number; bisTermin: number }>();
  const perUser = new Map<string, { calls: number; answered: number; gespraeche: number; talkSec: number }>();
  const hours = new Map<number, { calls: number; answered: number }>();
  let n = 0, answered = 0, gespraeche = 0, talkSec = 0, gespraechSec = 0;

  for (const c of calls) {
    const firma = firmaByKey.get(c.k);
    if (!firma || !firmen.has(firma)) continue;
    n++;
    const talk = c.a != null ? Math.max(0, c.e - c.a) : 0;
    const isAns = c.a != null;
    const isGespr = isAns && talk >= GESPRAECH_MIN_SEK;
    if (isAns) { answered++; talkSec += talk; }
    if (isGespr) { gespraeche++; gespraechSec += talk; }

    const f = perFirma.get(firma) || { calls: 0, answered: 0, bisTermin: 0 };
    f.calls++;
    if (isAns) f.answered++;
    if (c.s < (terminTag.get(firma) ?? -Infinity)) f.bisTermin++;
    perFirma.set(firma, f);

    const name = c.u || '—';
    const u = perUser.get(name) || { calls: 0, answered: 0, gespraeche: 0, talkSec: 0 };
    u.calls++;
    if (isAns) { u.answered++; u.talkSec += talk; }
    if (isGespr) u.gespraeche++;
    perUser.set(name, u);

    const h = new Date(c.s * 1000).getHours();
    const hb = hours.get(h) || { calls: 0, answered: 0 };
    hb.calls++;
    if (isAns) hb.answered++;
    hours.set(h, hb);
  }

  const won = [...terminTag.keys()];
  const wonMitAnruf = won.filter((w) => (perFirma.get(w)?.bisTermin ?? 0) > 0);
  return {
    calls: n,
    answered,
    gespraeche,
    reachRate: n ? answered / n : 0,
    talkSec,
    avgTalkSec: gespraeche ? gespraechSec / gespraeche : null,
    crmActivities: acts.length,
    firmen: firmen.size,
    firmenAngewaehlt: perFirma.size,
    avgCallsPerFirma: perFirma.size ? n / perFirma.size : null,
    callsPerTermin: won.length && n ? n / won.length : null,
    avgCallsToTermin: wonMitAnruf.length
      ? wonMitAnruf.reduce((s, w) => s + perFirma.get(w)!.bisTermin, 0) / wonMitAnruf.length
      : null,
    byUser: [...perUser.entries()]
      .map(([name, v]) => ({ name, ...v }))
      .sort((x, y) => y.calls - x.calls),
    byHour: [...hours.entries()]
      .map(([hour, v]) => ({ hour, ...v }))
      .sort((x, y) => x.hour - y.hour),
    topFirmen: [...perFirma.entries()]
      .map(([name, v]) => ({ name, calls: v.calls, answered: v.answered, won: terminTag.has(name) }))
      .sort((x, y) => y.calls - x.calls)
      .slice(0, 8),
  };
}

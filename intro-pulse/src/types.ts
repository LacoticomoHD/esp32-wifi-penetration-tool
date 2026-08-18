// Datentypen für die INTRO-Pulse-Analyse.

export type Flag =
  | 'nie_erreicht' // nie durchgekommen
  | 'ap_recherche' // falscher Ansprechpartner → richtigen recherchieren
  | 'disqualifiziert' // grundsätzlich kein Interesse / Kampagnen-Stopp
  | 'info_phase' // Infomaterial/Input
  | 'nurture' // zukünftiges/kurzfristiges Interesse
  | 'wiedervorlage' // aktuell kein Interesse
  | 'termin' // Ersttermin vereinbart (Erfolg)
  | 'unbekannt';

/** Eine Zeile aus der Aktivitätsliste (ein Kontakt-Versuch). */
export interface Activity {
  firma: string;
  datum: Date | null;
  ergebnis: string;
  kommentar: string;
  entscheidergespraech: boolean | null;
  contactFunktion: string;
  kontakt: string;
  email: string;
  telefon: string;
  stadt: string;
  zugeordnet: string;
  umsatz: number | null;
  mitarbeiter: number | null;
  kampagne: string;
  // abgeleitet aus dem Funnel-Mapping:
  rank: number;
  flags: Flag[];
}

/** Aggregat aller Aktivitäten einer Firma (weitester Funnel-Stand). */
export interface Company {
  name: string;
  activities: Activity[];
  furthestRank: number;
  stage: string;
  reachedDM: boolean; // Entscheider erreicht
  won: boolean; // Termin vereinbart
  disqualifiziert: boolean;
  fruehAbriss: boolean; // nie einen Entscheider erreicht
  callsToTermin: number | null; // Aktivitäten bis zum Termin
  umsatz: number | null;
  mitarbeiter: number | null;
  stadt: string;
  zugeordnet: string;
  // Viergrad-Projektkontext (heuristisch, in der App manuell korrigierbar):
  sektor: 'öffentlich' | 'privat' | 'unklar';
  icpFit: boolean | null; // im Kern-Zielsegment (5–100 MA, privat, kein Wettbewerber)?
  einwand: string; // Einwand-/Status-Kategorie
}

export interface CallerKpi {
  name: string;
  companies: number;
  won: number;
  terminQuote: number;
  reachedDM: number;
  entscheiderQuote: number;
  activities: number;
}

export interface SegmentKpi {
  label: string;
  companies: number;
  won: number;
  terminQuote: number;
}

/** Mit welcher Abteilung wurde gesprochen — und wo entstanden Termine? */
export interface AbteilungKpi {
  label: string;
  gespraeche: number; // Aktivitäten mit Ansprechpartnern dieser Abteilung
  termine: number; // Firmen, deren Ersttermin mit dieser Abteilung zustande kam
  quote: number; // termine / gespraeche
}

/** Firma verdichtet auf Bearbeitungs-Intensität. */
export interface CompanyContact {
  name: string;
  attempts: number; // Anzahl Aktivitäten (Anrufversuche)
  stage: string;
  won: boolean;
  reachedDM: boolean;
}

export interface Kpis {
  campaign: string;
  totalCompanies: number;
  totalActivities: number;
  terminQuote: number;
  wonCompanies: number;
  entscheiderQuote: number;
  reachedDMCompanies: number;
  fruehAbrissRate: number;
  fruehAbrissCompanies: number;
  avgCallsToTermin: number | null;
  avgAttemptsPerCompany: number;
  funnel: { stage: string; rank: number; companies: number }[];
  disqualifiziertCompanies: number;
  mostContacted: CompanyContact[];
  leastContacted: CompanyContact[];
  hardCases: CompanyContact[];
  byAkquisiteur: CallerKpi[];
  byRevenueBand: SegmentKpi[];
  byEmployeeBand: SegmentKpi[];
  bySektor: SegmentKpi[]; // öffentlich vs. privat
  byIcp: SegmentKpi[]; // Kern-ICP vs. außerhalb
  byEinwand: { label: string; companies: number }[]; // warum (noch) kein Termin
  byAbteilung: AbteilungKpi[]; // mit welcher Abteilung entstehen Termine?
  goal: { perMonth: number; months: number; wonPerMonth: number; attainment: number };
  timeline: { date: string; activities: number }[];
  dateRange: { from: Date | null; to: Date | null };
}

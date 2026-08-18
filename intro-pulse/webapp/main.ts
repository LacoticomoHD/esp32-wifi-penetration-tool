// INTRO Pulse — Phase 1 Browser-App.
// Upload → parseActivitiesFromBuffer → computeKpis → Dashboard. Läuft komplett
// im Browser; die Datei verlässt den Rechner nicht.

import {
  parseActivitiesFromBuffer,
  readRowsFromBuffer,
  computeKpis,
  classifySektor,
} from '../src/engine';
import type { Activity, CallerKpi, Kpis } from '../src/types';
import { diffKpis, type KpiDelta } from '../src/compare';
import { readAttachment, type DocAttachment } from './src/attachments';

interface Empfehlung { titel: string; detail?: string; prio?: 'hoch' | 'mittel' | 'niedrig' }
interface KiResult { text: string; empfehlungen?: Empfehlung[]; model?: string }

let allActivities: Activity[] = [];
let currentKpis: Kpis | null = null;
let currentActs: Activity[] = [];
let chatHistory: { role: string; content: string }[] = [];
let kiAttachments: DocAttachment[] = [];
let currentEmpfehlungen: Empfehlung[] = [];
let currentChecklistScope = '';
let lastFullKpis: Kpis | null = null;             // KPIs des geladenen Reports (ungefiltert)
let snapshotDeltas: KpiDelta[] = [];              // aktueller Vergleich (leer = keiner)
let comparePrevLabel = '';                        // Beschreibung des Vergleichs-Vorreports
let manualPrev: { kpis: Kpis; label: string } | null = null; // manuell gewählter Vorreport
let autoPrev: SnapStore | null = null;            // Vorstand aus localStorage, bei Datei-Load erfasst
let autoPrevSame = false;                          // war der letzte Upload derselbe Datenstand?

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const appEl = () => $('app');
const filterbar = () => $('filterbar');
const fAkq = () => $('f-akq') as HTMLSelectElement;
const fSekt = () => $('f-sekt') as HTMLSelectElement;
const fErg = () => $('f-erg') as HTMLSelectElement;

// ---- Formatierung -----------------------------------------------------------
const pct = (n: number) => (n * 100).toFixed(1).replace('.', ',') + ' %';
const dec = (n: number, d = 1) => n.toFixed(d).replace('.', ',');
const de = (n: number) => n.toLocaleString('de-DE');
const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const fmtDate = (d: Date | null) => (d ? d.toLocaleDateString('de-DE') : '—');

// ---- Bausteine --------------------------------------------------------------
const tile = (cls: string, lab: string, num: string, sub: string, pill: string) =>
  `<div class="card tile ${cls}"><div class="lab">${lab}</div><div class="num">${num}</div><div class="sub">${sub}</div>${pill}</div>`;
const pill = (cls: string, txt: string) => `<span class="pill ${cls}">${esc(txt)}</span>`;
const bar = (name: string, w: number, val: string, best = false, labW = 150, won = false) =>
  `<div class="srow${best ? ' best' : ''}${won ? ' won' : ''}" style="grid-template-columns:${labW}px 1fr 84px">` +
  `<span class="sname">${esc(name)}</span>` +
  `<span class="strack"><span class="sfill" style="--w:${Math.max(w, 1).toFixed(0)}%"></span></span>` +
  `<span class="sval">${val}</span></div>`;

function secHead(eyebrow: string, title: string, meta = '') {
  return `<div class="sec-head"><div><div class="eyebrow">${eyebrow}</div><h2>${title}</h2></div>${
    meta ? `<div class="m">${meta}</div>` : ''
  }</div>`;
}

// ---- Dashboard --------------------------------------------------------------
function renderDashboard(k: Kpis, activityCount: number) {
  $('meta').textContent =
    `${k.campaign || 'Kampagne'} · ${fmtDate(k.dateRange.from)}–${fmtDate(k.dateRange.to)} · ${k.totalCompanies} Firmen · ${activityCount} Aktivitäten`;

  const funnelMax = Math.max(1, ...k.funnel.map((f) => f.companies));
  const funnelRows = k.funnel
    .filter((f) => f.rank > 0)
    .map((f) =>
      bar(f.stage, (f.companies / funnelMax) * 100, `${f.companies} <small>Firmen</small>`, false, 150, f.rank === 4),
    )
    .join('');

  const sektIcp = [...k.bySektor, ...k.byIcp];
  const segMax = Math.max(0.001, ...sektIcp.map((s) => s.terminQuote));
  const bestSekt = k.bySektor.reduce((a, b) => (b.terminQuote > a.terminQuote ? b : a), k.bySektor[0]);
  const bestIcp = k.byIcp.reduce((a, b) => (b.terminQuote > a.terminQuote ? b : a), k.byIcp[0]);
  const segRows =
    k.bySektor
      .map((s) =>
        bar(s.label, (s.terminQuote / segMax) * 100, `${pct(s.terminQuote)} <small>${s.won}/${s.companies}</small>`, s === bestSekt && s.won > 0),
      )
      .join('') +
    k.byIcp
      .map((s) =>
        bar(s.label, (s.terminQuote / segMax) * 100, `${pct(s.terminQuote)} <small>${s.won}/${s.companies}</small>`, s === bestIcp && s.won > 0),
      )
      .join('');

  const einw = k.byEinwand.filter((e) => e.label !== 'Termin vereinbart');
  const einwMax = Math.max(1, ...einw.map((e) => e.companies));
  const einwRows = einw
    .map((e) => bar(e.label, (e.companies / einwMax) * 100, `${e.companies}`, false, 210))
    .join('');

  const contactRow = (c: { name: string; attempts: number; stage: string; reachedDM: boolean }, flag = false) =>
    `<div class="crow${flag && !c.reachedDM ? ' flag' : ''}"><span class="cn">${esc(c.name)}</span>` +
    `<span class="cst">${flag ? `${c.attempts}× · ${c.reachedDM ? 'Entscheider erreicht' : 'nie beim Entscheider'}` : esc(c.stage)}</span>` +
    `<span class="cx">${c.attempts}×</span></div>`;

  // Team-Vergleich je Akquisiteur. Nur sinnvoll, wenn mehrere Personen in der
  // Ansicht sind — bei Filter auf eine Person bleibt genau ein Eintrag übrig,
  // dann fällt der Abschnitt automatisch weg.
  const akq = k.byAkquisiteur.filter((c) => c.name && c.name !== '—');
  const avgTries = (c: CallerKpi) => c.activities / Math.max(1, c.companies);
  let teamSection = '';
  if (akq.length > 1) {
    const bestQ = akq.reduce((a, b) => (b.terminQuote > a.terminQuote ? b : a), akq[0]);
    const worstQ = akq.reduce((a, b) => (b.terminQuote < a.terminQuote ? b : a), akq[0]);
    const bestE = akq.reduce((a, b) => (b.entscheiderQuote > a.entscheiderQuote ? b : a), akq[0]);
    const qMax = Math.max(0.001, ...akq.map((c) => c.terminQuote));
    const eMax = Math.max(0.001, ...akq.map((c) => c.entscheiderQuote));
    const qRows = akq
      .map((c) => bar(c.name, (c.terminQuote / qMax) * 100, `${pct(c.terminQuote)} <small>${c.won}/${c.companies}</small>`, c === bestQ && c.won > 0, 120))
      .join('');
    const eRows = akq
      .map((c) => bar(c.name, (c.entscheiderQuote / eMax) * 100, `${pct(c.entscheiderQuote)} <small>${dec(avgTries(c))}×</small>`, c === bestE && c.reachedDM > 0, 120))
      .join('');
    const insightTeam =
      bestQ.won > 0 && bestQ !== worstQ
        ? `<b>${esc(bestQ.name)}</b> führt mit ${pct(bestQ.terminQuote)} (${bestQ.won} von ${bestQ.companies} Firmen), ${esc(worstQ.name)} liegt bei ${pct(worstQ.terminQuote)} — bei Ø ${dec(avgTries(bestQ))} statt ${dec(avgTries(worstQ))} Versuchen je Firma.`
        : bestQ.won > 0
          ? `Alle liegen bei ${pct(bestQ.terminQuote)} Termin-Quote.`
          : `Noch kein Termin im Team — die Entscheider-Quote zeigt, wer am weitesten kommt.`;
    teamSection = `
    ${secHead('Team', 'Wer holt wie viele Termine?', `${akq.length} Akquisiteure · Filter oben grenzt auf eine Person ein`)}
    <div class="cols even">
      <div class="card panel"><h3>Termin‑Quote je Akquisiteur</h3><p class="cap">Firmen mit Termin, geteilt durch bearbeitete Firmen.</p><div class="seg">${qRows}</div><p class="insight">${insightTeam}</p></div>
      <div class="card panel"><h3>Entscheider‑Quote</h3><p class="cap">Wie oft kommt jemand bis zum Entscheider? Rechts: Ø Versuche je Firma.</p><div class="seg">${eRows}</div></div>
    </div>
`;
  }

  // Mit welcher Abteilung entstehen Termine? (aus „Contact Funktion" zugeordnet)
  const abt = k.byAbteilung.filter((a) => a.label !== 'ohne Angabe');
  let abtSection = '';
  if (abt.length) {
    const withT = abt.filter((a) => a.termine > 0);
    const tMax = Math.max(1, ...abt.map((a) => a.termine));
    const gMax = Math.max(1, ...abt.map((a) => a.gespraeche));
    const tRows = withT
      .map((a, i) => bar(a.label, (a.termine / tMax) * 100, `${a.termine} <small>${pct(a.quote)}</small>`, i === 0, 165))
      .join('');
    const gRows = abt
      .slice(0, 8)
      .map((a) => bar(a.label, (a.gespraeche / gMax) * 100, `${a.gespraeche} <small>${a.termine ? `${a.termine} Term.` : '—'}</small>`, false, 165))
      .join('');
    const ohneTermin = abt.filter((a) => a.termine === 0).sort((x, y) => y.gespraeche - x.gespraeche)[0];
    const insightAbt = withT.length
      ? `<b>${esc(withT[0].label)}</b> bringt die meisten Termine: ${withT[0].termine} aus ${withT[0].gespraeche} Gesprächen (${pct(withT[0].quote)}).` +
        (ohneTermin && ohneTermin.gespraeche > 1
          ? ` Mit <b>${esc(ohneTermin.label)}</b> gab es ${ohneTermin.gespraeche} Gespräche — aber keinen Termin.`
          : '')
      : `Noch kein Termin — die meisten Gespräche liefen über ${esc(abt[0].label)} (${abt[0].gespraeche}).`;
    abtSection = `
    ${secHead('Ansprechpartner', 'Mit welcher Abteilung entstehen Termine?', 'Position automatisch zugeordnet')}
    <div class="cols even">
      <div class="card panel"><h3>Termine nach Abteilung</h3><p class="cap">Wem der Ersttermin zugesagt wurde. Rechts: Trefferquote je Gespräch.</p><div class="seg">${tRows || '<p class="cap">Noch keine Termine.</p>'}</div><p class="insight">${insightAbt}</p></div>
      <div class="card panel"><h3>Gespräche nach Abteilung</h3><p class="cap">Wohin der Aufwand geht — und was dabei herauskommt.</p><div class="seg">${gRows}</div></div>
    </div>
`;
  }

  const icpZero = k.byIcp.find((s) => s.label === 'Kern-ICP');
  const insightSeg = icpZero && icpZero.won === 0 && icpZero.companies > 0
    ? `<b>Alle ${k.wonCompanies} Termine kommen aus „${bestSekt?.label}".</b> Im Kern‑ICP (5–100 MA, privat) steht bisher kein Termin.`
    : `Beste Termin‑Quote: <b>${bestSekt?.label}</b>.`;

  const compareMeta = filtersActive()
    ? 'gefiltert · Vergleich gilt für die Gesamtkampagne'
    : comparePrevLabel === 'erster Stand'
      ? 'Erster Stand — lade einen weiteren Report für den Vergleich'
      : comparePrevLabel === 'gleicher Stand wie zuletzt'
        ? 'Unverändert zum letzten Upload'
        : `Δ zum Vorreport · ${esc(comparePrevLabel)}${manualPrev ? ' · <a id="cmp-clear" class="cmp-clear">↺ zurück zum Auto‑Vergleich</a>' : ''}`;

  appEl().innerHTML = `
    ${secHead('Kampagnen‑Überblick', 'Wie steht die Kampagne?', compareMeta)}
    <div class="kpis">
      ${tile('hero', 'Termin‑Quote', pct(k.terminQuote), `${k.wonCompanies} von ${k.totalCompanies} Firmen${deltaBadge('terminQuote')}`, pill('key', 'Kern‑KPI'))}
      ${tile('', 'Ø Anrufe bis Termin', k.avgCallsToTermin != null ? dec(k.avgCallsToTermin) : '—', 'je gewonnener Firma', pill('flat', `Ø ${dec(k.avgAttemptsPerCompany)} Versuche/Firma`))}
      ${tile('', 'Entscheider‑Quote', pct(k.entscheiderQuote), `${k.reachedDMCompanies} von ${k.totalCompanies} erreicht${deltaBadge('entscheiderQuote')}`, pill('good', 'stark'))}
      ${tile('', 'Früh‑Abriss', pct(k.fruehAbrissRate), `${k.fruehAbrissCompanies} nie beim Entscheider${deltaBadge('fruehAbrissRate')}`, pill('warn', 'beobachten'))}
    </div>

    ${secHead('Verlauf', 'Aktivitäten im Zeitverlauf', `Ziel ${k.goal.perMonth} Termine/Monat`)}
    <div class="card chart-wrap">
      <div class="chart"><svg id="tl" viewBox="0 0 960 160" role="img" aria-label="Aktivitäten je Tag"></svg></div>
      <div class="axis"><span>${fmtDate(k.dateRange.from)}</span><span>${fmtDate(k.dateRange.to)}</span></div>
      <p class="cap" style="margin-top:8px">${activityCount} Anrufversuche über ${k.timeline.length} aktive Tage.</p>
    </div>

    ${secHead('Funnel', 'Wo stehen die Firmen — und wo reißen Kontakte ab?')}
    <div class="cols">
      <div class="card panel"><h3>Firmen je weitester Stufe</h3><p class="cap">Jede Firma zählt einmal auf ihrer weitesten Stufe.</p><div class="seg">${funnelRows}</div></div>
      <div class="card panel"><h3>Abriss‑Punkte</h3><p class="cap">Wo Firmen hängen bleiben.</p><div class="drops">
        <div class="drop a"><div class="big">${k.fruehAbrissCompanies}</div><div class="txt"><b>Nie beim Entscheider</b> — gezielte Ansprechpartner‑Recherche vor dem Anruf lohnt sich.</div></div>
        <div class="drop b"><div class="big">${k.disqualifiziertCompanies}</div><div class="txt"><b>Disqualifiziert</b> — kein Interesse / Kampagnen‑Stopp. Sauber aussortiert.</div></div>
      </div></div>
    </div>

    ${teamSection}
    ${secHead('Zielsegment', 'Öffentlich vs. privat — woher kommen die Termine?')}
    <div class="cols">
      <div class="card panel"><h3>Termin‑Quote nach Sektor &amp; ICP</h3><p class="cap">Wer bringt tatsächlich Termine?</p><div class="seg">${segRows}</div><p class="insight">${insightSeg}</p></div>
      <div class="card panel"><h3>Zielerreichung</h3><p class="cap">Ziel: ${k.goal.perMonth} Termine pro Monat.</p>
        <div style="font-size:40px;font-weight:750;letter-spacing:-.03em;color:var(--accent);line-height:1;margin-top:2px">${pct(k.goal.attainment)}</div>
        <div style="font-size:12.5px;color:var(--muted);margin-top:6px">${dec(k.goal.wonPerMonth)} von ${k.goal.perMonth} Terminen/Monat · ${k.wonCompanies} Termine in ${dec(k.goal.months)} Monaten</div>
        <div class="strack" style="height:16px;margin-top:14px;overflow:hidden"><span class="sfill" style="--w:${Math.min(100, k.goal.attainment * 100).toFixed(0)}%;background:var(--accent)"></span></div>
      </div>
    </div>

    ${abtSection}
    ${secHead('Einwände', 'Warum (noch) kein Termin?', 'heuristisch')}
    <div class="card panel"><div class="seg">${einwRows}</div></div>

    ${secHead('Bearbeitung', 'Wer wurde wie oft angegangen?')}
    <div class="cols">
      <div class="card panel"><h3>Meist bearbeitete Firmen</h3><p class="cap">Höchster Aufwand.</p><div class="clist">${k.mostContacted.map((c) => contactRow(c)).join('')}</div></div>
      <div class="card panel"><h3>Schwer zu knacken</h3><p class="cap">Viel Aufwand, noch kein Termin.</p><div class="clist">${k.hardCases.map((c) => contactRow(c, true)).join('')}</div></div>
    </div>

  `;

  drawTimeline(k.timeline);
  document.getElementById('cmp-clear')?.addEventListener('click', (e) => { e.preventDefault(); clearCompare(); });
}

function drawTimeline(timeline: { date: string; activities: number }[]) {
  const svg = document.getElementById('tl');
  if (!svg || timeline.length === 0) return;
  const d = timeline.map((t) => t.activities);
  const W = 960, H = 160, padX = 10, padT = 16, padB = 16;
  const cs = getComputedStyle(document.documentElement);
  const barC = (cs.getPropertyValue('--bar') || '#2E4A6B').trim();
  const acc = (cs.getPropertyValue('--accent') || '#FF6F61').trim();
  const brd = (cs.getPropertyValue('--border') || '#E4E8EE').trim();
  const max = Math.max(...d), n = d.length, iw = W - padX * 2, ih = H - padT - padB;
  const X = (i: number) => padX + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const Y = (v: number) => padT + ih - (max ? (v / max) * ih : 0);
  let line = '', area = `M${X(0)} ${H - padB}`;
  d.forEach((v, i) => { const x = X(i), y = Y(v); line += (i ? 'L' : 'M') + x + ' ' + y + ' '; area += `L${x} ${y} `; });
  area += `L${X(n - 1)} ${H - padB} Z`;
  const ns = 'http://www.w3.org/2000/svg';
  const el = (t: string, a: Record<string, string | number>) => { const e = document.createElementNS(ns, t); for (const k in a) e.setAttribute(k, String(a[k])); return e; };
  svg.appendChild(el('line', { x1: padX, y1: H - padB, x2: W - padX, y2: H - padB, stroke: brd, 'stroke-width': 1 }));
  svg.appendChild(el('path', { d: area, fill: barC, 'fill-opacity': 0.14 }));
  svg.appendChild(el('path', { d: line, fill: 'none', stroke: barC, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  d.forEach((v, i) => svg.appendChild(el('circle', { cx: X(i), cy: Y(v), r: 2.6, fill: barC })));
  svg.appendChild(el('circle', { cx: X(n - 1), cy: Y(d[n - 1]), r: 4, fill: acc }));
}

// ---- Filter -----------------------------------------------------------------
function distinct(values: string[]): string[] {
  return [...new Set(values.filter((v) => v))].sort((a, b) => a.localeCompare(b, 'de'));
}
function populateFilters() {
  fAkq().innerHTML =
    `<option value="">Akquisiteur: alle</option>` +
    distinct(allActivities.map((a) => a.zugeordnet)).map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
  fErg().innerHTML =
    `<option value="">Ergebnis: alle</option>` +
    distinct(allActivities.map((a) => a.ergebnis)).map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
  fSekt().value = '';
}
function apply() {
  let acts = allActivities;
  if (fAkq().value) acts = acts.filter((a) => a.zugeordnet === fAkq().value);
  if (fSekt().value) acts = acts.filter((a) => classifySektor(a.firma) === fSekt().value);
  if (fErg().value) acts = acts.filter((a) => a.ergebnis === fErg().value);
  if (acts.length === 0) {
    hideKI();
    appEl().innerHTML = `<div class="empty"><div class="big">🔍</div><h2>Keine Aktivitäten</h2><p>Für diese Filter gibt es keine Daten. Setze die Filter zurück.</p></div>`;
    return;
  }
  currentActs = acts;
  currentKpis = computeKpis(acts, { goalPerMonth: 3 });
  renderDashboard(currentKpis, acts.length);
  showKI();
}

// ---- Snapshot-Vergleich ("was hat sich seit dem letzten Report geändert?") --
// Zwei Wege: (a) Auto-Vergleich mit dem zuletzt hochgeladenen Report derselben
// Kampagne (im Browser via localStorage gemerkt) und (b) manuell zwei Dateien.
// Verglichen werden immer die UNGEFILTERTEN Kennzahlen (ganze Kampagne).
const SNAP_KEY = 'pulse-snapshots';
// Nur die Skalar-Felder, die diffKpis() liest — klein & JSON-tauglich.
function slimKpis(k: Kpis) {
  return {
    terminQuote: k.terminQuote, wonCompanies: k.wonCompanies, entscheiderQuote: k.entscheiderQuote,
    fruehAbrissRate: k.fruehAbrissRate, avgAttemptsPerCompany: k.avgAttemptsPerCompany,
    totalCompanies: k.totalCompanies, goal: { attainment: k.goal.attainment },
  };
}
interface SnapStore { sig: string; rangeLabel: string; savedAt: number; kpis: ReturnType<typeof slimKpis> }
function snapSig(k: Kpis): string {
  return [fmtDate(k.dateRange.from), fmtDate(k.dateRange.to), k.totalActivities, k.totalCompanies, k.wonCompanies].join('|');
}
function loadSnapshots(): Record<string, SnapStore> {
  try { return JSON.parse(localStorage.getItem(SNAP_KEY) || '{}'); } catch { return {}; }
}
function saveSnapshot(k: Kpis, sig: string) {
  const all = loadSnapshots();
  all[k.campaign || ''] = { sig, rangeLabel: `${fmtDate(k.dateRange.from)}–${fmtDate(k.dateRange.to)}`, savedAt: Date.now(), kpis: slimKpis(k) };
  try { localStorage.setItem(SNAP_KEY, JSON.stringify(all)); } catch { /* localStorage evtl. voll/gesperrt */ }
}
// Einmal je Datei-Load: den gespeicherten Vorstand erfassen und den aktuellen
// Stand als neuen "letzter Upload" merken (für den NÄCHSTEN Upload).
function prepareComparison() {
  if (!lastFullKpis) { autoPrev = null; autoPrevSame = false; return; }
  const curr = lastFullKpis;
  const sig = snapSig(curr);
  const prev = loadSnapshots()[curr.campaign || '']; // VOR dem Speichern lesen
  autoPrev = prev && prev.sig !== sig ? prev : null;  // nur ein ECHTER Vorstand
  autoPrevSame = !!(prev && prev.sig === sig);
  saveSnapshot(curr, sig);
}
// Setzt snapshotDeltas + comparePrevLabel — nutzt manuellen ODER erfassten Auto-Vorstand.
function updateComparison() {
  if (!lastFullKpis) { snapshotDeltas = []; comparePrevLabel = ''; return; }
  const curr = lastFullKpis;
  if (manualPrev) {
    snapshotDeltas = diffKpis(curr, manualPrev.kpis);
    comparePrevLabel = manualPrev.label;
  } else if (autoPrev) {
    snapshotDeltas = diffKpis(curr, autoPrev.kpis as unknown as Kpis);
    comparePrevLabel = `letzter Upload · ${autoPrev.rangeLabel}`;
  } else {
    snapshotDeltas = diffKpis(curr, null);
    comparePrevLabel = autoPrevSame ? 'gleicher Stand wie zuletzt' : 'erster Stand';
  }
}
// Δ-Anzeige für eine Kennzahl (nur im ungefilterten Blick sichtbar).
const filtersActive = () => !!(fAkq().value || fSekt().value || fErg().value);
function deltaBadge(key: string): string {
  if (filtersActive()) return '';
  const d = snapshotDeltas.find((x) => x.key === key);
  if (!d || d.delta == null || d.delta === 0) return '';
  const cls = d.improved ? 'up' : 'down'; // Farbe = Qualität (grün besser / rot schlechter)
  const arrow = d.delta > 0 ? '▲' : '▼';  // Pfeil = Richtung der Zahl
  const s = d.delta > 0 ? '+' : '−';
  const mag = Math.abs(d.delta);
  const val = d.unit === 'pct' ? `${dec(mag * 100)} Pp` : d.unit === 'count' ? `${mag}` : `${dec(mag)}`;
  return ` <span class="dlt ${cls}" title="seit ${esc(comparePrevLabel)}">${arrow} ${s}${val}</span>`;
}
async function loadCompareFile(file: File) {
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    const acts = parseActivitiesFromBuffer(buf, file.name);
    if (acts.length === 0) throw new Error('Keine Aktivitäten in der Vergleichsdatei gefunden.');
    manualPrev = { kpis: computeKpis(acts, { goalPerMonth: 3 }), label: `Datei „${file.name}"` };
    updateComparison();
    apply();
  } catch (e) {
    comparePrevLabel = `Vergleich fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`;
    apply();
  }
}
function clearCompare() { manualPrev = null; updateComparison(); apply(); }

// ---- KI-Kontext je Kampagne -------------------------------------------------
// Beim Wechsel auf einen anderen Report MUSS der KI-Kontext weg: sonst stehen
// Analyse, Checkliste, Chat und Anhänge der vorherigen Kampagne unter den neuen
// Zahlen — und landen so auch im PDF. Der Steckbrief wird dagegen je Kampagne
// aufgehoben und beim Wiederöffnen automatisch zurückgeholt.
const STECK_KEY = 'pulse-steckbriefe';
const KI_HINT =
  '<p class="ki-hint">Klick auf „Analyse starten" — Claude bewertet Termin‑Quote, Funnel und Einwände und gibt priorisierte Empfehlungen. Anschließend kannst du unten Rückfragen stellen.</p>';
function loadSteckbriefe(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(STECK_KEY) || '{}'); } catch { return {}; }
}
function saveSteckbrief(campaign: string, text: string) {
  const all = loadSteckbriefe();
  if (text.trim()) all[campaign] = text;
  else delete all[campaign];
  try { localStorage.setItem(STECK_KEY, JSON.stringify(all)); } catch { /* Speicher voll/gesperrt */ }
}
function resetKiContext(campaign: string) {
  chatHistory = [];
  kiAttachments = [];
  currentEmpfehlungen = [];
  renderDocs();
  renderChecklist();
  const out = document.getElementById('ki-out');
  if (out) out.innerHTML = KI_HINT;
  const log = document.getElementById('ki-log');
  if (log) log.innerHTML = '';
  const docerr = document.getElementById('ki-docerr');
  if (docerr) docerr.textContent = '';
  const steck = document.getElementById('ki-steck') as HTMLTextAreaElement | null;
  if (!steck) return;
  const all = loadSteckbriefe();
  // Einmalige Übernahme des alten, kampagnenlosen Steckbriefs auf die aktuelle
  // Kampagne — danach ist der Alt-Schlüssel weg und kann nicht mehr überlaufen.
  const legacy = localStorage.getItem('ki-steck');
  if (legacy && !all[campaign]) {
    all[campaign] = legacy;
    try { localStorage.setItem(STECK_KEY, JSON.stringify(all)); localStorage.removeItem('ki-steck'); } catch { /* egal */ }
  }
  steck.value = all[campaign] || '';
}

// ---- Import-Diagnose --------------------------------------------------------
// Häufigste Upload-Ursache für Fehler: die Spalten heißen im Export anders.
// Statt einer technischen Meldung zeigen wir, welche Spalten die Datei
// tatsächlich enthält und welche Pflichtspalten fehlen.
const REQUIRED_COLS = ['Firma/Account', 'Ergebnis'];
const normCol = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Wahrscheinlichste Kopfzeile aus den ersten Zeilen der Datei. */
function sniffColumns(buf: Uint8Array | null, filename: string): string[] {
  if (!buf) return [];
  try {
    const rows = readRowsFromBuffer(buf, filename).slice(0, 12);
    let best: string[] = [];
    for (const r of rows) {
      const cells = (r || []).map((c) => String(c ?? '').trim()).filter(Boolean);
      if (cells.length > best.length) best = cells;
    }
    return best.slice(0, 24);
  } catch {
    return [];
  }
}

function importErrorHtml(msg: string, cols: string[]): string {
  const have = new Set(cols.map(normCol));
  const missing = REQUIRED_COLS.filter((c) => !have.has(normCol(c)));
  const chip = (t: string, cls = '') => `<span class="chip ${cls}">${esc(t)}</span>`;
  const tip = missing.length
    ? `<p>Benenne im Export ${missing.length > 1 ? 'die Spalten' : 'die Spalte'} <b>${missing.map(esc).join('</b> und <b>')}</b> entsprechend um — dann klappt der Upload.</p>`
    : `<p>Die Pflichtspalten sind vorhanden. Prüfe, ob unterhalb der Kopfzeile auch Datenzeilen mit Firmennamen stehen.</p>`;
  const found = cols.length
    ? `<span class="lab">In deiner Datei gefunden</span><div class="chips">${cols.map((c) => chip(c)).join('')}</div>`
    : `<span class="lab">Hinweis</span><p>Die Datei ließ sich nicht öffnen — ist es wirklich eine Excel- oder CSV-Datei?</p>`;
  return (
    `<div class="imperr"><h3>⚠️ Diese Datei konnte ich nicht auswerten</h3>` +
    `<p class="why">${esc(msg)}</p>${tip}` +
    `<span class="lab">Diese Spalten brauche ich</span><div class="chips">${REQUIRED_COLS.map((c) => chip(c, missing.includes(c) ? 'miss' : 'ok')).join('')}</div>` +
    found +
    `<p class="fine">Unterstützt: Excel (.xlsx/.xls) und CSV (Semikolon oder Komma). Die Kopfzeile darf irgendwo im Blatt stehen.</p></div>`
  );
}

// ---- Datei-Upload -----------------------------------------------------------
async function loadFile(file: File) {
  let buf: Uint8Array | null = null;
  try {
    buf = new Uint8Array(await file.arrayBuffer());
    allActivities = parseActivitiesFromBuffer(buf, file.name);
    if (allActivities.length === 0) throw new Error('Keine Aktivitäten in der Datei gefunden. Erwartet werden Spalten wie „Firma/Account", „Ergebnis" …');
    manualPrev = null; // neuer Report → zurück zum Auto-Vergleich (letzter Upload)
    lastFullKpis = computeKpis(allActivities, { goalPerMonth: 3 });
    resetKiContext(lastFullKpis.campaign || ''); // KI-Kontext der Vorkampagne verwerfen
    prepareComparison();
    updateComparison();
    populateFilters();
    filterbar().style.display = '';
    apply();
    window.scrollTo({ top: 0 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const html = importErrorHtml(msg, sniffColumns(buf, file.name));
    const err = document.getElementById('err');
    // Ist schon ein Report geladen, bleibt das Dashboard stehen — die Meldung
    // erscheint darüber, statt die Auswertung zu verwerfen.
    if (err) err.innerHTML = html;
    else appEl().insertAdjacentHTML('afterbegin', html);
  }
}

function wireInput(id: string) {
  const el = document.getElementById(id) as HTMLInputElement | null;
  el?.addEventListener('change', () => { if (el.files && el.files[0]) loadFile(el.files[0]); });
}
wireInput('file');
wireInput('file2');
document.getElementById('f-cmp')?.addEventListener('change', (e) => {
  const el = e.target as HTMLInputElement;
  if (el.files && el.files[0]) loadCompareFile(el.files[0]);
  el.value = '';
});
[fAkq(), fSekt(), fErg()].forEach((s) => s.addEventListener('change', apply));
$('f-reset').addEventListener('click', (e) => { e.preventDefault(); fAkq().value = ''; fSekt().value = ''; fErg().value = ''; apply(); });

// ---- KI-Sektion (serverseitiger Claude-Aufruf) ------------------------------
function showKI() {
  const sec = document.getElementById('kisec');
  if (sec) sec.style.display = '';
  // Der Steckbrief wird NICHT hier gesetzt — das macht resetKiContext() beim
  // Dateiwechsel, kampagnengenau. Sonst würde ein Filterwechsel ihn überschreiben.
  const model = document.getElementById('ki-model') as HTMLSelectElement | null;
  if (model && localStorage.getItem('ki-model')) model.value = localStorage.getItem('ki-model')!;
}
function hideKI() { const sec = document.getElementById('kisec'); if (sec) sec.style.display = 'none'; }

// ---- Kontext-Dateien (Anhänge für die KI) -----------------------------------
const MAX_TOTAL_DOCS = 12 * 1024 * 1024; // ~12 MB Rohdaten insgesamt
function renderDocs() {
  const list = document.getElementById('ki-doclist');
  if (!list) return;
  list.innerHTML = kiAttachments
    .map((a, i) => {
      const ic = a.kind === 'image' ? '🖼️' : a.kind === 'pdf' ? '📄' : '📊';
      return `<span class="ki-doc"><span class="ki-doc-ic">${ic}</span><span class="ki-doc-n">${esc(a.name)}</span><button class="ki-doc-x" data-i="${i}" title="entfernen" aria-label="entfernen">×</button></span>`;
    })
    .join('');
  list.querySelectorAll<HTMLButtonElement>('.ki-doc-x').forEach((b) =>
    b.addEventListener('click', () => { kiAttachments.splice(Number(b.dataset.i), 1); renderDocs(); }),
  );
}
async function addDocs(files: FileList) {
  const err = document.getElementById('ki-docerr');
  if (err) err.textContent = '';
  for (const f of Array.from(files)) {
    const total = kiAttachments.reduce((s, a) => s + a.bytes, 0);
    if (total + f.size > MAX_TOTAL_DOCS) { if (err) err.textContent = `„${f.name}" übersprungen — insgesamt max. 12 MB Anhänge.`; continue; }
    try { kiAttachments.push(await readAttachment(f)); }
    catch (e) { if (err) err.textContent = (e as Error).message; }
  }
  renderDocs();
}

function buildReport() {
  const k = currentKpis!;
  // Notizen inkl. Ansprechpartner, Position und Bearbeiter — eigene CRM-Daten,
  // die der KI erlauben, Gesprächsverläufe Personen und Rollen zuzuordnen.
  const notizen = currentActs
    .filter((a) => a.kommentar && a.kommentar.trim().length > 3)
    .slice(0, 60)
    .map((a) => ({
      firma: a.firma,
      ergebnis: a.ergebnis,
      kontakt: a.kontakt || undefined,
      funktion: a.contactFunktion || undefined,
      akquisiteur: a.zugeordnet || undefined,
      notiz: a.kommentar.slice(0, 280),
    }));
  // Welche Positionen werden erreicht — und führen sie zum Termin?
  // Zeigt z. B., ob man im Marketing landet statt bei der Geschäftsführung.
  const posMap = new Map<string, { kontakte: number; termine: number }>();
  for (const a of currentActs) {
    const f = a.contactFunktion.trim();
    if (!f) continue;
    const e = posMap.get(f) || { kontakte: 0, termine: 0 };
    e.kontakte++;
    if (a.rank >= 4) e.termine++;
    posMap.set(f, e);
  }
  const positionen = [...posMap.entries()]
    .sort((x, y) => y[1].kontakte - x[1].kontakte)
    .slice(0, 15)
    .map(([funktion, v]) => ({ funktion, kontakte: v.kontakte, termine: v.termine }));
  const akquisiteure = k.byAkquisiteur
    .filter((c) => c.name && c.name !== '—')
    .map((c) => ({
      name: c.name,
      firmen: c.companies,
      termine: c.won,
      terminQuoteProzent: +(c.terminQuote * 100).toFixed(1),
      entscheiderQuoteProzent: +(c.entscheiderQuote * 100).toFixed(1),
      aktivitaeten: c.activities,
      avgVersucheJeFirma: +(c.activities / Math.max(1, c.companies)).toFixed(1),
    }));
  return {
    kampagne: k.campaign,
    zeitraum: `${fmtDate(k.dateRange.from)}–${fmtDate(k.dateRange.to)}`,
    kennzahlen: {
      firmen: k.totalCompanies, aktivitaeten: k.totalActivities,
      terminQuoteProzent: +(k.terminQuote * 100).toFixed(1), termine: k.wonCompanies,
      entscheiderQuoteProzent: +(k.entscheiderQuote * 100).toFixed(1),
      fruehAbrissRateProzent: +(k.fruehAbrissRate * 100).toFixed(1),
      avgAnrufeBisTermin: k.avgCallsToTermin, avgVersucheJeFirma: +k.avgAttemptsPerCompany.toFixed(1),
      zielProMonat: k.goal.perMonth, zielerreichungProzent: +(k.goal.attainment * 100).toFixed(0),
    },
    funnel: k.funnel.filter((f) => f.rank > 0),
    sektor: k.bySektor, icp: k.byIcp, einwaende: k.byEinwand,
    akquisiteure,
    abteilungen: k.byAbteilung, // gruppiert: wo entstehen Termine?
    erreichtePositionen: positionen, // Rohbezeichnungen aus dem CRM
    meistBearbeitet: k.mostContacted, schwerZuKnacken: k.hardCases,
    gespraechsnotizen: notizen,
  };
}
// Endpoint der KI-Analyse: gehostete Supabase-Funktion (zur Build-Zeit gesetzt)
// oder – beim lokalen `npm run dev` – der eigene Server unter /api/analyze.
const KI_ENDPOINT = (globalThis as { __PULSE_KI_ENDPOINT__?: string }).__PULSE_KI_ENDPOINT__ || '/api/analyze';
async function callKI(payload: Record<string, unknown>): Promise<KiResult> {
  const res = await fetch(KI_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const data = await res.json().catch(() => ({ error: 'Ungültige Antwort vom Server.' }));
  if (!res.ok || data.error) throw new Error(data.error || `Server-Fehler ${res.status}`);
  return data as KiResult;
}
function md(t: string): string {
  const inline = (s: string) => s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  let html = '', inList = false;
  for (const raw of esc(t).split('\n')) {
    const l = raw.trim();
    if (/^#{1,4}\s+/.test(l)) { if (inList) { html += '</ul>'; inList = false; } html += `<h4>${inline(l.replace(/^#{1,4}\s+/, ''))}</h4>`; }
    else if (/^[-*]\s+/.test(l)) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${inline(l.replace(/^[-*]\s+/, ''))}</li>`; }
    else if (l === '') { if (inList) { html += '</ul>'; inList = false; } }
    else { if (inList) { html += '</ul>'; inList = false; } html += `<p>${inline(l)}</p>`; }
  }
  if (inList) html += '</ul>';
  return html;
}

// ---- KI-Handlungs-Checkliste -------------------------------------------------
// Die Empfehlungen der Analyse werden zu abhakbaren To-dos. Der Haken-Zustand
// bleibt im Browser (localStorage), getrennt je Kampagne + Akquisiteur-Filter,
// und wird beim Drucken mit ins PDF übernommen.
const CHECKS_KEY = 'pulse-checks';
const normKey = (s: string) => s.trim().toLowerCase().slice(0, 120);
function loadAllChecks(): Record<string, Record<string, boolean>> {
  try { return JSON.parse(localStorage.getItem(CHECKS_KEY) || '{}'); } catch { return {}; }
}
function isChecked(scope: string, titel: string): boolean {
  return !!loadAllChecks()[scope]?.[normKey(titel)];
}
function setChecked(scope: string, titel: string, val: boolean) {
  const all = loadAllChecks();
  if (!all[scope]) all[scope] = {};
  if (val) all[scope][normKey(titel)] = true;
  else delete all[scope][normKey(titel)];
  localStorage.setItem(CHECKS_KEY, JSON.stringify(all));
}
function renderChecklist() {
  const el = document.getElementById('ki-checklist');
  if (!el) return;
  if (!currentEmpfehlungen.length) { el.innerHTML = ''; return; }
  const prioTxt: Record<string, string> = { hoch: 'Hoch', mittel: 'Mittel', niedrig: 'Niedrig' };
  el.innerHTML =
    `<div class="ki-cl-head">✅ Nächste Schritte<span class="ki-cl-hint">abhaken — der Stand bleibt im Browser gespeichert und kommt mit ins PDF</span></div>` +
    currentEmpfehlungen
      .map((e, i) => {
        const p = e.prio && prioTxt[e.prio] ? e.prio : 'mittel';
        const done = isChecked(currentChecklistScope, e.titel);
        return (
          `<label class="ki-cl-item${done ? ' done' : ''}">` +
          `<input type="checkbox" data-i="${i}"${done ? ' checked' : ''} />` +
          `<span class="ki-cl-body"><span class="ki-cl-title">${esc(e.titel)}</span>` +
          (e.detail ? `<span class="ki-cl-detail">${esc(e.detail)}</span>` : '') +
          `</span>` +
          `<span class="ki-cl-prio p-${p}">${prioTxt[p]}</span>` +
          `</label>`
        );
      })
      .join('');
  el.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const e = currentEmpfehlungen[Number(cb.dataset.i)];
      if (!e) return;
      setChecked(currentChecklistScope, e.titel, cb.checked);
      cb.closest('.ki-cl-item')?.classList.toggle('done', cb.checked);
    });
  });
}

async function runAnalysis() {
  if (!currentKpis) return;
  const out = document.getElementById('ki-out')!;
  const btn = document.getElementById('ki-run') as HTMLButtonElement;
  const model = (document.getElementById('ki-model') as HTMLSelectElement).value;
  const steckbrief = (document.getElementById('ki-steck') as HTMLTextAreaElement).value;
  saveSteckbrief(currentKpis!.campaign || '', steckbrief);
  localStorage.setItem('ki-model', model);
  btn.disabled = true;
  out.innerHTML = '<div class="ki-loading">Claude analysiert den Report …</div>';
  try {
    const data = await callKI({ mode: 'analyze', model, steckbrief, report: buildReport(), attachments: kiAttachments });
    out.innerHTML = md(data.text);
    currentEmpfehlungen = Array.isArray(data.empfehlungen) ? data.empfehlungen : [];
    currentChecklistScope = `${currentKpis!.campaign || 'Kampagne'}||${fAkq().value || 'alle'}`;
    renderChecklist();
  } catch (e) {
    out.innerHTML = `<div class="err">${esc((e as Error).message)}</div>`;
    currentEmpfehlungen = [];
    renderChecklist();
  } finally {
    btn.disabled = false;
  }
}
async function runChat() {
  if (!currentKpis) return;
  const input = document.getElementById('ki-q') as HTMLInputElement;
  const q = input.value.trim(); if (!q) return;
  const log = document.getElementById('ki-log')!;
  const btn = document.getElementById('ki-ask') as HTMLButtonElement;
  const model = (document.getElementById('ki-model') as HTMLSelectElement).value;
  const steckbrief = (document.getElementById('ki-steck') as HTMLTextAreaElement).value;
  input.value = '';
  btn.disabled = true;
  log.insertAdjacentHTML('beforeend', `<div class="ki-q">${esc(q)}</div><div class="ki-a ki-loading">…</div>`);
  const aEl = log.lastElementChild as HTMLElement;
  log.scrollTop = log.scrollHeight;
  try {
    const { text } = await callKI({ mode: 'chat', model, steckbrief, report: buildReport(), history: chatHistory, question: q, attachments: kiAttachments });
    chatHistory.push({ role: 'user', content: q }, { role: 'assistant', content: text });
    if (chatHistory.length > 12) chatHistory = chatHistory.slice(-12);
    aEl.className = 'ki-a'; aEl.innerHTML = md(text);
  } catch (e) { aEl.className = 'ki-a'; aEl.innerHTML = `<div class="err">${esc((e as Error).message)}</div>`; }
  finally { btn.disabled = false; }
  log.scrollTop = log.scrollHeight;
}
document.getElementById('ki-run')?.addEventListener('click', runAnalysis);
document.getElementById('ki-ask')?.addEventListener('click', runChat);
document.getElementById('ki-q')?.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') runChat(); });
document.getElementById('ki-docs')?.addEventListener('change', (e) => {
  const el = e.target as HTMLInputElement;
  if (el.files && el.files.length) addDocs(el.files);
  el.value = '';
});

// ---- PDF / Druck ------------------------------------------------------------
// Druckt die AKTUELL gefilterte Ansicht (Dashboard + ggf. KI-Analyse) als A4-PDF.
// Das eigentliche Layout macht die Druck-CSS in index.html; hier nur Blatt-Kopf,
// Dateiname und die Entscheidung, ob der KI-Abschnitt mitgedruckt wird.
function fillPrintHead() {
  const el = document.getElementById('printhead');
  if (!el || !currentKpis) return;
  const k = currentKpis;
  const bits: string[] = [];
  if (fAkq().value) bits.push(`Akquisiteur: ${fAkq().value}`);
  if (fSekt().value) bits.push(`Sektor: ${fSekt().value}`);
  if (fErg().value) bits.push(`Ergebnis: ${fErg().value}`);
  const scope = bits.length ? bits.join(' · ') : 'Gesamte Kampagne';
  const heute = new Date().toLocaleDateString('de-DE');
  el.innerHTML =
    `<h1>${esc(k.campaign || 'Kampagne')}</h1>` +
    `<p class="ph-sub">${esc(scope)} · Zeitraum ${fmtDate(k.dateRange.from)}–${fmtDate(k.dateRange.to)} · ` +
    `${k.totalCompanies} Firmen · ${k.wonCompanies} Termine · erstellt am ${heute}</p>`;
}
const BASE_TITLE = document.title; // statischer <title>, Ziel fürs Zurücksetzen
let printTitleTimer: ReturnType<typeof setTimeout> | undefined;
function printReport() {
  if (!currentKpis) return;
  fillPrintHead();
  // KI-Abschnitt nur drucken, wenn wirklich eine Analyse gelaufen ist
  // (der Platzhalter-Hinweis .ki-hint zählt nicht).
  const kiOut = document.getElementById('ki-out');
  const kiRun = !!kiOut && !kiOut.querySelector('.ki-hint') && (kiOut.textContent || '').trim().length > 0;
  document.body.classList.toggle('print-no-ki', !kiRun);
  // Sinnvoller Standard-Dateiname für „Als PDF speichern".
  const who = fAkq().value ? ` — ${fAkq().value}` : '';
  document.title = `INTRO Pulse — ${currentKpis.campaign || 'Kampagne'}${who}`;
  const restore = () => { document.title = BASE_TITLE; };
  if (printTitleTimer) clearTimeout(printTitleTimer);
  window.addEventListener('afterprint', restore, { once: true });
  printTitleTimer = setTimeout(restore, 3000); // Fallback, falls afterprint nicht feuert
  window.print();
}
document.getElementById('f-print')?.addEventListener('click', printReport);
// Steckbrief auch ohne Analyse sichern — je Kampagne.
document.getElementById('ki-steck')?.addEventListener('blur', (e) => {
  if (currentKpis) saveSteckbrief(currentKpis.campaign || '', (e.target as HTMLTextAreaElement).value);
});

// INTRO Pulse — Phase 1 Browser-App.
// Upload → parseActivitiesFromBuffer → computeKpis → Dashboard. Läuft komplett
// im Browser; die Datei verlässt den Rechner nicht.

import {
  parseActivitiesFromBuffer,
  readRowsFromBuffer,
  computeKpis,
  classifyAbteilung,
} from '../src/engine';
import type { Activity, CallerKpi, Kpis } from '../src/types';
import { diffKpis, type KpiDelta } from '../src/compare';
import { readAttachment, type DocAttachment } from './src/attachments';
import {
  buildPhoneIndex,
  computeAircall,
  GESPRAECH_MIN_SEK,
  type AircallCall,
  type AircallKpis,
  type PhoneIndex,
} from '../src/aircall';

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
const fErg = () => $('f-erg') as HTMLSelectElement;

// ---- Formatierung -----------------------------------------------------------
const pct = (n: number) => (n * 100).toFixed(1).replace('.', ',') + ' %';
const dec = (n: number, d = 1) => n.toFixed(d).replace('.', ',');
const de = (n: number) => n.toLocaleString('de-DE');
const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const fmtDate = (d: Date | null) => (d ? d.toLocaleDateString('de-DE') : '—');
/** Sekunden → „3 h 12 min" bzw. „2:05 min". */
const fmtDur = (sec: number | null) => {
  if (sec == null) return '—';
  const s = Math.round(sec);
  if (s >= 3600) return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} min`;
};

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
      <div class="card panel"><h3>Entscheider‑Quote</h3><p class="cap">Wie oft kommt jemand bis zum Entscheider?${k.entscheiderBasis.seit ? ` Firmen seit ${fmtDate(k.entscheiderBasis.seit)}.` : ''} Rechts: Ø Versuche je Firma.</p><div class="seg">${eRows}</div></div>
    </div>
`;
  }

  // Mit welcher Abteilung entstehen Termine? (aus „Contact Funktion" zugeordnet)
  // Wichtig: Der Abschnitt wird IMMER gezeigt, sobald Aktivitäten da sind —
  // fehlt die Position im Export, sagen wir das, statt still zu verschwinden.
  const abtAlle = k.byAbteilung;
  const abtBekannt = abtAlle.filter((a) => a.label !== 'ohne Angabe');
  const abtMitTermin = abtBekannt.filter((a) => a.termine > 0);
  // Konkret: wer hat zugesagt? (Firma · Person · Funktion → Abteilung)
  const abtRang = new Map(abtAlle.map((a, i) => [a.label, i] as [string, number]));
  const termineDetail = currentActs
    .filter((a) => a.rank >= 4)
    .map((a) => ({
      firma: a.firma,
      person: a.kontakt || '—',
      funktion: a.contactFunktion || '',
      abteilung: classifyAbteilung(a.contactFunktion),
    }))
    .sort((x, y) =>
      (abtRang.get(x.abteilung) ?? 99) - (abtRang.get(y.abteilung) ?? 99) ||
      x.firma.localeCompare(y.firma, 'de'));
  const ohneFunktion = termineDetail.filter((t) => !t.funktion).length;
  let abtSection = '';
  if (abtAlle.length) {
    const tMax = Math.max(1, ...abtBekannt.map((a) => a.termine));
    const gMax = Math.max(1, ...abtAlle.map((a) => a.gespraeche));
    const tRows = abtMitTermin
      .map((a, i) => bar(a.label, (a.termine / tMax) * 100, `${a.termine} <small>${pct(a.quote)}</small>`, i === 0, 165))
      .join('');
    const gRows = [...abtAlle]
      .sort((x, y) => y.gespraeche - x.gespraeche)
      .slice(0, 8)
      .map((a) => bar(a.label, (a.gespraeche / gMax) * 100, `${a.gespraeche} <small>${a.termine ? `${a.termine} Term.` : '—'}</small>`, false, 165))
      .join('');
    // Liste der Zusagen — beantwortet „wer genau hat zugesagt, aus welcher Abteilung?"
    const detailRows = termineDetail
      .slice(0, 12)
      .map((t) =>
        `<div class="trow"><span class="tn">${esc(t.firma)}</span>` +
        `<span class="tp">${esc(t.person)}${t.funktion ? ` · ${esc(t.funktion)}` : ' · Position nicht hinterlegt'}</span>` +
        `<span class="ta${t.funktion ? '' : ' none'}">${esc(t.abteilung === 'ohne Angabe' ? '—' : t.abteilung)}</span></div>`)
      .join('');
    const mehr = termineDetail.length > 12 ? `<p class="cap" style="margin-top:8px">… und ${termineDetail.length - 12} weitere Termine.</p>` : '';
    const ohneHinweis = ohneFunktion
      ? `<p class="cap" style="margin-top:10px">Bei ${ohneFunktion} von ${termineDetail.length} Terminen ist keine Position hinterlegt — im Export fehlt dort die Spalte „Contact Funktion".</p>`
      : '';
    const linkeSeite = abtMitTermin.length
      ? `<div class="seg">${tRows}</div><p class="insight">${
          `<b>${esc(abtMitTermin[0].label)}</b> bringt die meisten Termine: ${abtMitTermin[0].termine} aus ${abtMitTermin[0].gespraeche} Gesprächen (${pct(abtMitTermin[0].quote)}).` +
          (() => {
            const ohneT = abtBekannt.filter((a) => a.termine === 0).sort((x, y) => y.gespraeche - x.gespraeche)[0];
            return ohneT && ohneT.gespraeche > 1 ? ` Mit <b>${esc(ohneT.label)}</b> gab es ${ohneT.gespraeche} Gespräche — aber keinen Termin.` : '';
          })()
        }</p>`
      : termineDetail.length
        ? `<p class="cap">Es gibt ${termineDetail.length} Termin(e), aber im Export ist keine Position dazu hinterlegt. Fülle die Spalte „Contact Funktion", dann siehst du hier die Abteilungen.</p>`
        : `<p class="cap">Noch keine Termine — sobald einer zustande kommt, steht hier die Abteilung des Ansprechpartners.</p>`;
    abtSection = `
    ${secHead('Ansprechpartner', 'Mit welcher Abteilung entstehen Termine?', 'Position automatisch zugeordnet')}
    <div class="cols even">
      <div class="card panel"><h3>Termine nach Abteilung</h3><p class="cap">Wem der Ersttermin zugesagt wurde. Rechts: Trefferquote je Gespräch.</p>${linkeSeite}
        ${termineDetail.length ? `<h3 style="margin-top:18px">Wer hat zugesagt?</h3><p class="cap">Absteigend nach Abteilung.</p><div class="tlist">${detailRows}</div>${mehr}${ohneHinweis}` : ''}</div>
      <div class="card panel"><h3>Gespräche nach Abteilung</h3><p class="cap">Wohin der Aufwand geht — und was dabei herauskommt.</p><div class="seg">${gRows}</div></div>
    </div>
`;
  }

  // Wird „Entscheidergespräch" erst seit einem Stichtag gepflegt, gilt die Quote ab dann.
  const dmSeit = k.entscheiderBasis.seit ? fmtDate(k.entscheiderBasis.seit) : '';
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
      ${tile('', 'Entscheider‑Quote', pct(k.entscheiderQuote), `${k.reachedDMCompanies} von ${k.entscheiderBasis.firmen} erreicht${deltaBadge('entscheiderQuote')}`, dmSeit ? pill('flat', `erfasst seit ${dmSeit}`) : pill('good', 'stark'))}
      ${tile('', 'Früh‑Abriss', pct(k.fruehAbrissRate), `${k.fruehAbrissCompanies} nie beim Entscheider${deltaBadge('fruehAbrissRate')}`, dmSeit ? pill('flat', `seit ${dmSeit}`) : pill('warn', 'beobachten'))}
      ${callsTile(k, activityCount)}
    </div>

    ${aircallSection()}
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
        <div class="drop a"><div class="big">${k.fruehAbrissCompanies}</div><div class="txt"><b>Nie beim Entscheider</b>${k.entscheiderBasis.seit ? ` (seit ${fmtDate(k.entscheiderBasis.seit)})` : ''} — gezielte Ansprechpartner‑Recherche vor dem Anruf lohnt sich.</div></div>
        <div class="drop b"><div class="big">${k.disqualifiziertCompanies}</div><div class="txt"><b>Disqualifiziert</b> — kein Interesse / Kampagnen‑Stopp. Sauber aussortiert.</div></div>
      </div></div>
    </div>

    ${teamSection}
    ${secHead('Ziel', 'Werden die Zielvorgaben erreicht?')}
    <div class="card panel">
      <h3>Zielerreichung</h3>
      <p class="cap">Ziel: <input id="goal-in" class="goalin" type="number" min="1" max="999" step="1" value="${k.goal.perMonth}" aria-label="Termine pro Monat" /><span class="goalprint">${k.goal.perMonth}</span> Termine pro Monat <span class="goalhint">— je Kampagne gespeichert</span></p>
      <div style="font-size:40px;font-weight:750;letter-spacing:-.03em;color:var(--accent);line-height:1;margin-top:2px">${pct(k.goal.attainment)}</div>
      <div style="font-size:12.5px;color:var(--muted);margin-top:6px">${dec(k.goal.wonPerMonth)} von ${k.goal.perMonth} Terminen/Monat · ${k.wonCompanies} Termine in ${dec(k.goal.months)} Monaten</div>
      <div class="strack" style="height:16px;margin-top:14px;overflow:hidden"><span class="sfill" style="--w:${Math.min(100, k.goal.attainment * 100).toFixed(0)}%;background:var(--accent)"></span></div>
    </div>

    ${abtSection}
    ${secHead('Einwände', k.wonCompanies > 0 ? 'Woran hakt es bei den übrigen Firmen?' : 'Warum (noch) kein Termin?', 'heuristisch')}
    <div class="card panel"><div class="seg">${einwRows}</div></div>

    ${secHead('Bearbeitung', 'Wer wurde wie oft angegangen?')}
    <div class="cols">
      <div class="card panel"><h3>Meist bearbeitete Firmen</h3><p class="cap">Höchster Aufwand.</p><div class="clist">${k.mostContacted.map((c) => contactRow(c)).join('')}</div></div>
      <div class="card panel"><h3>Schwer zu knacken</h3><p class="cap">Viel Aufwand, noch kein Termin.</p><div class="clist">${k.hardCases.map((c) => contactRow(c, true)).join('')}</div></div>
    </div>

  `;

  drawTimeline(k.timeline);
  document.getElementById('cmp-clear')?.addEventListener('click', (e) => { e.preventDefault(); clearCompare(); });
  document.getElementById('ac-retry')?.addEventListener('click', (e) => { e.preventDefault(); loadAircall(); });
  const goalIn = document.getElementById('goal-in') as HTMLInputElement | null;
  goalIn?.addEventListener('change', () => {
    const n = Math.round(Number(goalIn.value));
    goalPerMonth = Number.isFinite(n) && n > 0 ? Math.min(n, 999) : GOAL_DEFAULT;
    saveGoal(currentKpis?.campaign || '', goalPerMonth);
    // Kennzahlen mit dem neuen Ziel neu rechnen — auch die Vergleichsbasis.
    if (allActivities.length) lastFullKpis = computeKpis(allActivities, { goalPerMonth });
    apply();
  });
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
}
function apply() {
  let acts = allActivities;
  if (fAkq().value) acts = acts.filter((a) => a.zugeordnet === fAkq().value);
  if (fErg().value) acts = acts.filter((a) => a.ergebnis === fErg().value);
  if (acts.length === 0) {
    hideKI();
    appEl().innerHTML = `<div class="empty"><div class="big">🔍</div><h2>Keine Aktivitäten</h2><p>Für diese Filter gibt es keine Daten. Setze die Filter zurück.</p></div>`;
    return;
  }
  currentActs = acts;
  currentKpis = computeKpis(acts, { goalPerMonth });
  renderDashboard(currentKpis, acts.length);
  showKI();
}

// ---- Aircall: echte Wählversuche aus der Telefonanlage ---------------------
// Das CRM kennt nur, was protokolliert wurde. Aircall zählt jeden Wählversuch,
// ob angenommen wurde und wie lange gesprochen wurde. Zuordnung über die
// Telefonnummer im Export; der Aircall-Schlüssel bleibt auf dem Server.
const KI_EP = (globalThis as { __PULSE_KI_ENDPOINT__?: string }).__PULSE_KI_ENDPOINT__ || '';
const AIRCALL_ENDPOINT =
  (globalThis as { __PULSE_AIRCALL_ENDPOINT__?: string }).__PULSE_AIRCALL_ENDPOINT__ ||
  (KI_EP.includes('pulse-analyze') ? KI_EP.replace('pulse-analyze', 'pulse-aircall') : '');
type AircallState = 'off' | 'loading' | 'ready' | 'error' | 'not_configured' | 'nophones';
const aircall = {
  state: 'off' as AircallState,
  calls: [] as AircallCall[],
  unmatched: 0,
  msg: '',
  index: null as PhoneIndex | null,
};
let aircallSeq = 0;
const DAY = 86400;

interface AircallResponse { calls?: AircallCall[]; unmatched?: number; nextPage?: number | null; split?: boolean; code?: string; error?: string }
async function postAircall(body: Record<string, unknown>): Promise<AircallResponse> {
  const res = await fetch(AIRCALL_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data: AircallResponse = await res.json().catch(() => ({ error: `Server-Fehler ${res.status}` }));
  if (!res.ok || data.error) {
    const err = new Error(data.error || `Server-Fehler ${res.status}`) as Error & { code?: string };
    err.code = data.code;
    throw err;
  }
  return data;
}

async function loadAircall() {
  const seq = ++aircallSeq;
  Object.assign(aircall, { state: 'off', calls: [], unmatched: 0, msg: '', index: null });
  if (!AIRCALL_ENDPOINT || !lastFullKpis) return;
  const idx = buildPhoneIndex(allActivities);
  aircall.index = idx;
  if (!idx.exact.length && !idx.prefix.length) { aircall.state = 'nophones'; apply(); return; }
  const { from, to } = lastFullKpis.dateRange;
  if (!from || !to) { aircall.state = 'error'; aircall.msg = 'Im Export fehlt ein Datum — ohne Zeitraum kann ich Aircall nicht abfragen.'; apply(); return; }
  aircall.state = 'loading';
  apply();

  const start = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime() / 1000;
  const end = Math.min(Date.now() / 1000, new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1).getTime() / 1000);
  const queue: [number, number][] = [];
  for (let w = start; w < end; w += 7 * DAY) queue.push([w, Math.min(w + 7 * DAY, end)]);
  const total = queue.length;
  let done = 0, stalls = 0;
  try {
    while (queue.length) {
      const [wf, wt] = queue.shift()!;
      let page: number | null = 1;
      while (page) {
        const r = await postAircall({ from: Math.floor(wf), to: Math.ceil(wt), page, exact: idx.exact, prefix: idx.prefix });
        if (seq !== aircallSeq) return; // inzwischen anderer Report geladen
        if (r.split && wt - wf > 3600) {
          const mid = Math.floor((wf + wt) / 2);
          queue.unshift([wf, mid], [mid, wt]);
          break;
        }
        aircall.calls.push(...(r.calls || []));
        aircall.unmatched += r.unmatched || 0;
        const next: number | null = r.nextPage ?? null;
        if (next != null && next === page && !(r.calls || []).length) {
          // Aircall-Rate-Limit: kurz warten und an derselben Stelle weitermachen
          if (++stalls > 8) throw new Error('Aircall drosselt gerade die Abfragen — bitte in ein paar Minuten erneut laden.');
          await new Promise((res) => setTimeout(res, 15000));
        }
        page = next;
        const prog = document.getElementById('ac-progress');
        if (prog) prog.textContent = `${de(aircall.calls.length)} Anrufe gefunden · Woche ${Math.min(done + 1, total)} von ${total}`;
      }
      done++;
    }
    aircall.state = 'ready';
  } catch (e) {
    if (seq !== aircallSeq) return;
    const code = (e as Error & { code?: string }).code;
    aircall.state = code === 'not_configured' ? 'not_configured' : 'error';
    aircall.msg = (e as Error).message;
  }
  if (seq === aircallSeq) apply();
}

function currentAircall(): AircallKpis | null {
  if (aircall.state !== 'ready' || !aircall.index) return null;
  return computeAircall(currentActs, aircall.calls, aircall.index.firmaByKey);
}

function aircallSection(): string {
  if (aircall.state === 'off') return '';
  const head = (meta: string) => secHead('Telefonie', 'Was zeigt Aircall wirklich?', meta);
  if (aircall.state === 'loading') {
    return `${head('wird geladen …')}<div class="card panel acbox"><p class="cap"><span class="acspin"></span>Lade die echten Anrufe aus Aircall … <span id="ac-progress"></span></p></div>`;
  }
  if (aircall.state === 'nophones') {
    return `${head('nicht möglich')}<div class="card panel acbox"><p class="cap">Im Export fehlt die Spalte „Telefon" — ohne Nummer kann ich die Aircall‑Anrufe keiner Firma zuordnen.</p></div>`;
  }
  if (aircall.state === 'not_configured') {
    return `${head('noch nicht verbunden')}<div class="card panel acbox"><p class="cap">Aircall ist noch nicht verbunden. Einmalig in Aircall einen API‑Schlüssel anlegen und als <b>AIRCALL_API_ID</b> und <b>AIRCALL_API_TOKEN</b> in Supabase (Edge Functions → Secrets) hinterlegen — danach erscheinen hier die echten Anrufzahlen. <a href="#" id="ac-retry">Erneut prüfen</a></p></div>`;
  }
  if (aircall.state === 'error') {
    return `${head('Fehler')}<div class="card panel acbox"><p class="cap">⚠️ ${esc(aircall.msg)} <a href="#" id="ac-retry">Erneut laden</a></p></div>`;
  }
  const a = currentAircall();
  if (!a) return '';
  if (!a.calls) {
    return `${head('keine Treffer')}<div class="card panel acbox"><p class="cap">Im Zeitraum gab es in Aircall keine ausgehenden Anrufe auf die Nummern dieses Reports${aircall.unmatched ? ` (${de(aircall.unmatched)} Anrufe gingen an andere Nummern)` : ''}. Stimmen die Telefonnummern im Export? <a href="#" id="ac-retry">Erneut laden</a></p></div>`;
  }

  const diff = a.calls - a.crmActivities;
  const crmPill = diff > 0
    ? pill('warn', `${pct(diff / a.calls)} der Anrufe`)
    : pill('good', 'alles erfasst');
  const tiles = `<div class="kpis">
      ${tile('', 'Nicht im CRM erfasst', de(Math.max(0, diff)), `${de(a.calls)} Wählversuche · ${de(a.crmActivities)} CRM‑Aktivitäten`, crmPill)}
      ${tile('', 'Angenommen', pct(a.reachRate), `${de(a.answered)} von ${de(a.calls)} · ${de(a.gespraeche)} Gespräche ≥ 1 Min`, pill('flat', 'inkl. Mailbox/Zentrale'))}
      ${tile('', 'Gesprächszeit', fmtDur(a.talkSec), `Ø ${fmtDur(a.avgTalkSec)} je Gespräch`, pill('flat', 'ab Annahme'))}
      ${tile('', 'Wählversuche je Termin', a.callsPerTermin != null ? dec(a.callsPerTermin) : '—', a.avgCallsToTermin != null ? `Ø ${dec(a.avgCallsToTermin)} Versuche bis zum Termin` : 'noch kein Termin', pill('key', 'echter Aufwand'))}
    </div>`;

  const uMax = Math.max(1, ...a.byUser.map((u) => u.calls));
  const userRows = a.byUser
    .map((u) => bar(u.name, (u.calls / uMax) * 100, `${de(u.calls)} <small>${pct(u.answered / Math.max(1, u.calls))}</small>`, false, 120))
    .join('');
  const userBest = a.byUser.length > 1
    ? [...a.byUser].filter((u) => u.calls >= 10).sort((x, y) => y.gespraeche / y.calls - x.gespraeche / x.calls)[0]
    : undefined;
  const userInsight = userBest
    ? `<p class="insight"><b>${esc(userBest.name)}</b> führt die meisten echten Gespräche: ${pct(userBest.gespraeche / userBest.calls)} der Anrufe dauern ≥ 1 Min · Gesprächszeit ${fmtDur(userBest.talkSec)}.</p>`
    : '';

  const hours = a.byHour.filter((h) => h.calls > 0);
  const rate = (h: { calls: number; answered: number }) => h.answered / Math.max(1, h.calls);
  const rMax = Math.max(0.001, ...hours.map(rate));
  const minCalls = Math.max(5, Math.round(a.calls * 0.03));
  const bestHour = hours.filter((h) => h.calls >= minCalls).sort((x, y) => rate(y) - rate(x))[0];
  const hourRows = hours
    .map((h) => bar(`${h.hour}–${h.hour + 1} Uhr`, (rate(h) / rMax) * 100, `${pct(rate(h))} <small>${h.calls}</small>`, h === bestHour, 90))
    .join('');
  const hourInsight = bestHour
    ? `<p class="insight">Am besten erreichbar: <b>${bestHour.hour}–${bestHour.hour + 1} Uhr</b> — ${pct(rate(bestHour))} angenommen bei ${bestHour.calls} Anrufen.</p>`
    : '';

  const firmRows = a.topFirmen
    .map((f) => `<div class="crow"><span class="cn">${esc(f.name)}</span><span class="cst">${f.answered}× angenommen${f.won ? ' · Termin' : ''}</span><span class="cx">${f.calls}×</span></div>`)
    .join('');
  const ohne = a.firmen - a.firmenAngewaehlt;
  const notes = [
    ohne > 0 ? `${de(ohne)} von ${de(a.firmen)} Firmen wurden laut Aircall nie angewählt (Nummer im CRM fehlt oder weicht ab, oder anderer Anschluss).` : '',
    !filtersActive() && aircall.unmatched ? `${de(aircall.unmatched)} weitere ausgehende Anrufe im Zeitraum gingen an Nummern außerhalb dieses Reports (andere Projekte).` : '',
    `„Angenommen" heißt: jemand oder die Mailbox hat abgehoben. Als Gespräch zählen Anrufe ab ${GESPRAECH_MIN_SEK} Sekunden.`,
  ].filter(Boolean).map((t) => `<p class="cap" style="margin-top:6px">${t}</p>`).join('');

  return `
    ${head(`${de(a.firmenAngewaehlt)} Firmen angewählt · Zuordnung über die Telefonnummer`)}
    ${tiles}
    <div class="cols even" style="margin-top:14px">
      <div class="card panel"><h3>Wählversuche je Akquisiteur</h3><p class="cap">Laut Aircall. Rechts: Anteil angenommen.</p><div class="seg">${userRows}</div>${userInsight}</div>
      <div class="card panel"><h3>Erreichbarkeit nach Uhrzeit</h3><p class="cap">Anteil angenommener Anrufe. Rechts: Anzahl Anrufe.</p><div class="seg">${hourRows}</div>${hourInsight}</div>
    </div>
    <div class="card panel" style="margin-top:14px"><h3>Am häufigsten angewählt</h3><p class="cap">Echte Wählversuche je Firma.</p><div class="clist">${firmRows}</div>${notes}</div>
`;
}

/** Überblicks-Kachel: Anrufe im Zeitraum — aus Aircall, sonst aus dem CRM. */
function callsTile(k: Kpis, activityCount: number): string {
  const a = currentAircall();
  if (a && a.calls) {
    return tile('', 'Anrufe im Zeitraum', de(a.calls),
      `Ø ${dec(a.calls / Math.max(1, a.aktiveTage))} pro Telefontag · ${a.aktiveTage} Tage`, pill('key', 'laut Aircall'));
  }
  const tage = Math.max(1, k.timeline.length);
  const hinweis = aircall.state === 'loading' ? 'Aircall lädt …' : 'laut CRM';
  return tile('', 'Anrufe im Zeitraum', de(activityCount),
    `Ø ${dec(activityCount / tage)} pro Tag · ${k.timeline.length} aktive Tage`, pill('flat', hinweis));
}

function aircallReport() {
  const a = currentAircall();
  if (!a || !a.calls) return undefined;
  return {
    hinweis: 'Echte Telefoniedaten aus Aircall — für Anrufzahlen verlässlicher als die CRM-Aktivitäten.',
    waehlversuche: a.calls,
    telefontage: a.aktiveTage,
    crmAktivitaeten: a.crmActivities,
    angenommen: a.answered,
    angenommenProzent: +(a.reachRate * 100).toFixed(1),
    gespraecheAb60Sek: a.gespraeche,
    gespraechszeitMinuten: Math.round(a.talkSec / 60),
    avgGespraechSekunden: a.avgTalkSec != null ? Math.round(a.avgTalkSec) : null,
    waehlversucheJeTermin: a.callsPerTermin != null ? +a.callsPerTermin.toFixed(1) : null,
    avgVersucheBisTermin: a.avgCallsToTermin != null ? +a.avgCallsToTermin.toFixed(1) : null,
    firmenNieAngewaehlt: a.firmen - a.firmenAngewaehlt,
    nachAkquisiteur: a.byUser.map((u) => ({ name: u.name, anrufe: u.calls, angenommen: u.answered, gespraeche: u.gespraeche, minuten: Math.round(u.talkSec / 60) })),
    nachUhrzeit: a.byHour.map((h) => ({ stunde: h.hour, anrufe: h.calls, angenommen: h.answered })),
  };
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
const filtersActive = () => !!(fAkq().value || fErg().value);
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
    manualPrev = { kpis: computeKpis(acts, { goalPerMonth }), label: `Datei „${file.name}"` };
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
const GOAL_KEY = 'pulse-ziele';
const GOAL_DEFAULT = 3;
let goalPerMonth = GOAL_DEFAULT; // Terminziel der aktuellen Kampagne
function loadGoals(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(GOAL_KEY) || '{}'); } catch { return {}; }
}
function saveGoal(campaign: string, n: number) {
  const all = loadGoals();
  if (n > 0 && n !== GOAL_DEFAULT) all[campaign] = n;
  else delete all[campaign];
  try { localStorage.setItem(GOAL_KEY, JSON.stringify(all)); } catch { /* Speicher gesperrt */ }
}

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
    // Terminziel dieser Kampagne laden (Vorgabe 3/Monat), bevor gerechnet wird.
    const kampagne = allActivities.find((a) => a.kampagne)?.kampagne || '';
    goalPerMonth = loadGoals()[kampagne] ?? GOAL_DEFAULT;
    lastFullKpis = computeKpis(allActivities, { goalPerMonth });
    resetKiContext(lastFullKpis.campaign || ''); // KI-Kontext der Vorkampagne verwerfen
    prepareComparison();
    updateComparison();
    populateFilters();
    filterbar().style.display = '';
    apply();
    window.scrollTo({ top: 0 });
    loadAircall(); // echte Anrufzahlen nachladen (läuft im Hintergrund)
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
[fAkq(), fErg()].forEach((s) => s.addEventListener('change', apply));
$('f-reset').addEventListener('click', (e) => { e.preventDefault(); fAkq().value = ''; fErg().value = ''; apply(); });

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
      entscheiderErfasstSeit: k.entscheiderBasis.seit ? fmtDate(k.entscheiderBasis.seit) : 'ganzer Zeitraum',
      entscheiderBasisFirmen: k.entscheiderBasis.firmen,
      fruehAbrissRateProzent: +(k.fruehAbrissRate * 100).toFixed(1),
      avgAnrufeBisTermin: k.avgCallsToTermin, avgVersucheJeFirma: +k.avgAttemptsPerCompany.toFixed(1),
      zielProMonat: k.goal.perMonth, zielerreichungProzent: +(k.goal.attainment * 100).toFixed(0),
    },
    funnel: k.funnel.filter((f) => f.rank > 0),
    einwaende: k.byEinwand,
    akquisiteure,
    abteilungen: k.byAbteilung, // gruppiert: wo entstehen Termine?
    erreichtePositionen: positionen, // Rohbezeichnungen aus dem CRM
    meistBearbeitet: k.mostContacted, schwerZuKnacken: k.hardCases,
    gespraechsnotizen: notizen,
    aircall: aircallReport(),
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

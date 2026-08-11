// INTRO Pulse — Phase 1 Browser-App.
// Upload → parseActivitiesFromBuffer → computeKpis → Dashboard. Läuft komplett
// im Browser; die Datei verlässt den Rechner nicht.

import {
  parseActivitiesFromBuffer,
  computeKpis,
  classifySektor,
} from '../src/engine';
import type { Activity, Kpis } from '../src/types';
import { readAttachment, type DocAttachment } from './src/attachments';

let allActivities: Activity[] = [];
let currentKpis: Kpis | null = null;
let currentActs: Activity[] = [];
let chatHistory: { role: string; content: string }[] = [];
let kiAttachments: DocAttachment[] = [];

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
const bar = (name: string, w: number, val: string, best = false, labW = 150) =>
  `<div class="srow${best ? ' best' : ''}" style="grid-template-columns:${labW}px 1fr 84px">` +
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
      bar(f.stage, (f.companies / funnelMax) * 100, `${f.companies} <small>Firmen</small>`, f.rank === 4),
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

  const icpZero = k.byIcp.find((s) => s.label === 'Kern-ICP');
  const insightSeg = icpZero && icpZero.won === 0 && icpZero.companies > 0
    ? `<b>Alle ${k.wonCompanies} Termine kommen aus „${bestSekt?.label}".</b> Im Kern‑ICP (5–100 MA, privat) steht bisher kein Termin.`
    : `Beste Termin‑Quote: <b>${bestSekt?.label}</b>.`;

  appEl().innerHTML = `
    ${secHead('Kampagnen‑Überblick', 'Wie steht die Kampagne?', `Δ zum Vorreport: — (erster Stand)`)}
    <div class="kpis">
      ${tile('hero', 'Termin‑Quote', pct(k.terminQuote), `${k.wonCompanies} von ${k.totalCompanies} Firmen`, pill('key', 'Kern‑KPI'))}
      ${tile('', 'Ø Anrufe bis Termin', k.avgCallsToTermin != null ? dec(k.avgCallsToTermin) : '—', 'je gewonnener Firma', pill('flat', `Ø ${dec(k.avgAttemptsPerCompany)} Versuche/Firma`))}
      ${tile('', 'Entscheider‑Quote', pct(k.entscheiderQuote), `${k.reachedDMCompanies} von ${k.totalCompanies} erreicht`, pill('good', 'stark'))}
      ${tile('', 'Früh‑Abriss', pct(k.fruehAbrissRate), `${k.fruehAbrissCompanies} nie beim Entscheider`, pill('warn', 'beobachten'))}
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

    ${secHead('Zielsegment', 'Öffentlich vs. privat — woher kommen die Termine?')}
    <div class="cols">
      <div class="card panel"><h3>Termin‑Quote nach Sektor &amp; ICP</h3><p class="cap">Wer bringt tatsächlich Termine?</p><div class="seg">${segRows}</div><p class="insight">${insightSeg}</p></div>
      <div class="card panel"><h3>Zielerreichung</h3><p class="cap">Ziel: ${k.goal.perMonth} Termine pro Monat.</p>
        <div style="font-size:40px;font-weight:750;letter-spacing:-.03em;color:var(--accent);line-height:1;margin-top:2px">${pct(k.goal.attainment)}</div>
        <div style="font-size:12.5px;color:var(--muted);margin-top:6px">${dec(k.goal.wonPerMonth)} von ${k.goal.perMonth} Terminen/Monat · ${k.wonCompanies} Termine in ${dec(k.goal.months)} Monaten</div>
        <div class="strack" style="height:16px;margin-top:14px;overflow:hidden"><span class="sfill" style="--w:${Math.min(100, k.goal.attainment * 100).toFixed(0)}%;background:var(--accent)"></span></div>
      </div>
    </div>

    ${secHead('Einwände', 'Warum (noch) kein Termin?', 'heuristisch')}
    <div class="card panel"><div class="seg">${einwRows}</div></div>

    ${secHead('Bearbeitung', 'Wer wurde wie oft angegangen?')}
    <div class="cols">
      <div class="card panel"><h3>Meist bearbeitete Firmen</h3><p class="cap">Höchster Aufwand.</p><div class="clist">${k.mostContacted.map((c) => contactRow(c)).join('')}</div></div>
      <div class="card panel"><h3>Schwer zu knacken</h3><p class="cap">Viel Aufwand, noch kein Termin.</p><div class="clist">${k.hardCases.map((c) => contactRow(c, true)).join('')}</div></div>
    </div>

  `;

  drawTimeline(k.timeline);
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

// ---- Datei-Upload -----------------------------------------------------------
async function loadFile(file: File) {
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    allActivities = parseActivitiesFromBuffer(buf, file.name);
    if (allActivities.length === 0) throw new Error('Keine Aktivitäten in der Datei gefunden. Erwartet werden Spalten wie „Firma/Account", „Ergebnis" …');
    populateFilters();
    filterbar().style.display = '';
    apply();
    window.scrollTo({ top: 0 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const err = document.getElementById('err');
    if (err) err.innerHTML = `<div class="err">Fehler: ${esc(msg)}</div>`;
    else appEl().innerHTML = `<div class="empty"><div class="big">⚠️</div><h2>Datei konnte nicht gelesen werden</h2><p>${esc(msg)}</p></div>`;
  }
}

function wireInput(id: string) {
  const el = document.getElementById(id) as HTMLInputElement | null;
  el?.addEventListener('change', () => { if (el.files && el.files[0]) loadFile(el.files[0]); });
}
wireInput('file');
wireInput('file2');
[fAkq(), fSekt(), fErg()].forEach((s) => s.addEventListener('change', apply));
$('f-reset').addEventListener('click', (e) => { e.preventDefault(); fAkq().value = ''; fSekt().value = ''; fErg().value = ''; apply(); });

// ---- KI-Sektion (serverseitiger Claude-Aufruf) ------------------------------
function showKI() {
  const sec = document.getElementById('kisec');
  if (sec) sec.style.display = '';
  const steck = document.getElementById('ki-steck') as HTMLTextAreaElement | null;
  const model = document.getElementById('ki-model') as HTMLSelectElement | null;
  if (steck && !steck.value) steck.value = localStorage.getItem('ki-steck') || '';
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
  const notizen = currentActs
    .filter((a) => a.kommentar && a.kommentar.trim().length > 3)
    .slice(0, 60)
    .map((a) => ({ firma: a.firma, ergebnis: a.ergebnis, notiz: a.kommentar.slice(0, 280) }));
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
    meistBearbeitet: k.mostContacted, schwerZuKnacken: k.hardCases,
    gespraechsnotizen: notizen,
  };
}
// Endpoint der KI-Analyse: gehostete Supabase-Funktion (zur Build-Zeit gesetzt)
// oder – beim lokalen `npm run dev` – der eigene Server unter /api/analyze.
const KI_ENDPOINT = (globalThis as { __PULSE_KI_ENDPOINT__?: string }).__PULSE_KI_ENDPOINT__ || '/api/analyze';
async function callKI(payload: Record<string, unknown>): Promise<string> {
  const res = await fetch(KI_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const data = await res.json().catch(() => ({ error: 'Ungültige Antwort vom Server.' }));
  if (!res.ok || data.error) throw new Error(data.error || `Server-Fehler ${res.status}`);
  return data.text as string;
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
async function runAnalysis() {
  if (!currentKpis) return;
  const out = document.getElementById('ki-out')!;
  const btn = document.getElementById('ki-run') as HTMLButtonElement;
  const model = (document.getElementById('ki-model') as HTMLSelectElement).value;
  const steckbrief = (document.getElementById('ki-steck') as HTMLTextAreaElement).value;
  localStorage.setItem('ki-steck', steckbrief); localStorage.setItem('ki-model', model);
  btn.disabled = true;
  out.innerHTML = '<div class="ki-loading">Claude analysiert den Report …</div>';
  try { out.innerHTML = md(await callKI({ mode: 'analyze', model, steckbrief, report: buildReport(), attachments: kiAttachments })); }
  catch (e) { out.innerHTML = `<div class="err">${esc((e as Error).message)}</div>`; }
  finally { btn.disabled = false; }
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
    const text = await callKI({ mode: 'chat', model, steckbrief, report: buildReport(), history: chatHistory, question: q, attachments: kiAttachments });
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

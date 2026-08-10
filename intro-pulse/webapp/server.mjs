// Schlanker lokaler Server: liefert das gebaute Dashboard aus und ruft Claude
// SERVERSEITIG auf (der API-Key bleibt in der Umgebung, nie im Browser).
// Start:  npm run dev   (baut + startet)   ·   http://localhost:3000
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

const here = dirname(fileURLToPath(import.meta.url));
const APP = join(here, 'dist', 'intro-pulse-app.html');
const PORT = Number(process.env.PORT) || 3000;

const send = (res, code, type, body) => { res.writeHead(code, { 'content-type': type }); res.end(body); };
const readBody = (req) =>
  new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 8e6) req.destroy(); });
    req.on('end', () => resolve(d));
    req.on('error', reject);
  });

function systemPrompt(steckbrief) {
  return [
    'Du bist ein nüchterner, erfahrener B2B-Vertriebsanalyst und wertest die Kaltakquise-Kampagne eines Kunden aus.',
    'Antworte auf Deutsch — konkret, knapp, mit Zahlenbezug. Keine Floskeln, kein Marketing-Sprech.',
    'Bleib ehrlich: Wenn die Fallzahl klein ist oder etwas unklar bleibt, sag das.',
    steckbrief ? `\n--- Projekt-Steckbrief (Kontext zum Kunden/zur Kampagne) ---\n${steckbrief}` : '',
  ].join('\n');
}
function analyzeUser(report) {
  return [
    'Hier sind die aggregierten Kennzahlen und Gesprächsnotizen einer Kampagne als JSON:',
    '```json',
    JSON.stringify(report, null, 2),
    '```',
    '',
    'Erstelle eine Auswertung mit GENAU diesen Abschnitten (jeweils 2–4 Sätze, immer mit konkreten Zahlen):',
    '## Was lief gut',
    '## Warum (noch) keine Termine',
    '## Früh-Abriss & schwer zu knackende Firmen',
    '## Konkrete Empfehlungen (max. 4, priorisiert)',
    'Nutze den Projekt-Steckbrief für die Deutung (Zielsegment/ICP, Einwände, Angebot, Kampagnenziel).',
  ].join('\n');
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    try { send(res, 200, 'text/html; charset=utf-8', readFileSync(APP)); }
    catch { send(res, 500, 'text/plain; charset=utf-8', 'App noch nicht gebaut. Bitte: npm run build:web'); }
    return;
  }
  if (req.method === 'POST' && req.url === '/api/analyze') {
    if (!process.env.ANTHROPIC_API_KEY) {
      send(res, 400, 'application/json', JSON.stringify({ error: 'Kein ANTHROPIC_API_KEY gesetzt. Lege ihn in intro-pulse/.env an (ANTHROPIC_API_KEY=sk-ant-…) und starte neu.' }));
      return;
    }
    try {
      const p = JSON.parse(await readBody(req));
      const model = p.model || 'claude-sonnet-5';
      const system = systemPrompt(p.steckbrief);
      const messages =
        p.mode === 'chat'
          ? [
              { role: 'user', content: `Kampagnendaten (JSON):\n\`\`\`json\n${JSON.stringify(p.report)}\n\`\`\`` },
              { role: 'assistant', content: 'Verstanden — ich habe die Kampagnendaten vorliegen. Was möchtest du wissen?' },
              ...(Array.isArray(p.history) ? p.history : []),
              { role: 'user', content: String(p.question || '') },
            ]
          : [{ role: 'user', content: analyzeUser(p.report) }];

      const client = new Anthropic();
      const resp = await client.messages.create({ model, max_tokens: 2500, system, messages });
      const text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      send(res, 200, 'application/json', JSON.stringify({ text, model: resp.model }));
    } catch (e) {
      const msg = e && e.message ? e.message : 'Fehler beim KI-Aufruf.';
      send(res, 502, 'application/json', JSON.stringify({ error: msg }));
    }
    return;
  }
  send(res, 404, 'text/plain; charset=utf-8', 'not found');
});

server.listen(PORT, () => {
  console.log(`\n  INTRO Pulse läuft auf http://localhost:${PORT}`);
  console.log(process.env.ANTHROPIC_API_KEY ? '  KI: aktiv (API-Key erkannt)\n' : '  KI: inaktiv (kein ANTHROPIC_API_KEY) — Dashboard funktioniert trotzdem\n');
});

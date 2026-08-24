// Bündelt die Browser-App (Engine + UI + xlsx) in eine einzige, selbstständige
// HTML-Datei. Das Logo wird als data-URI eingebettet — kein externer Request.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// KI-Endpoint: gehostete Supabase-Funktion. Öffentliche URL (kein Secret) —
// der API-Key liegt serverseitig als Supabase-Secret, nie hier. Per Env
// überschreibbar, falls das Projekt mal wechselt.
const KI_ENDPOINT =
  process.env.PULSE_KI_ENDPOINT ||
  'https://coydygpnumqxxealikqb.supabase.co/functions/v1/pulse-analyze';

const res = await build({
  entryPoints: [join(here, 'main.ts')],
  bundle: true,
  format: 'iife',
  minify: true,
  write: false,
  platform: 'browser',
  target: 'es2019',
  legalComments: 'none',
});

// </script> im gebündelten Code neutralisieren, damit es das <script>-Tag nicht schließt.
const js = res.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const logo = readFileSync(join(here, 'logo.b64'), 'utf8').trim();

let html = readFileSync(join(here, 'index.html'), 'utf8');
html = html.replace('__LOGO_B64__', () => logo);
// Sichtbarer Versionsstempel: so ist auf einen Blick erkennbar, ob der Browser
// die aktuelle Fassung geladen hat oder eine zwischengespeicherte alte.
const buildStamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
html = html.replace('__BUILD__', () => buildStamp);
html = html.replace(
  '<!--BUNDLE-->',
  () => `<script>window.__PULSE_KI_ENDPOINT__=${JSON.stringify(KI_ENDPOINT)}</script>\n<script>${js}</script>`,
);

mkdirSync(join(here, 'dist'), { recursive: true });

// (1) Vollständiges Dokument — zum lokalen Öffnen / Hosten.
const full = join(here, 'dist', 'intro-pulse-app.html');
writeFileSync(full, html);

// (2) Body-Fragment (<style> + Body-Inhalt) — für die Artifact-Veröffentlichung,
//     die selbst ein <!doctype>/<head>/<body>-Gerüst darum legt.
const style = html.match(/<style>[\s\S]*?<\/style>/)[0];
const bodyInner = html.match(/<body>([\s\S]*?)<\/body>/)[1];
const frag = join(here, 'dist', 'intro-pulse-artifact.html');
writeFileSync(frag, `${style}\n${bodyInner}`);

// (3) GitHub-Pages-Kopie: dieselbe App unter <repo>/docs/index.html, damit ein
//     teilbarer Link (ohne Login) funktioniert. .nojekyll umgeht Jekyll, sonst
//     würde GitHub Pages die Seite durch den Jekyll-Build schicken.
const pagesDir = join(here, '..', '..', 'docs');
mkdirSync(pagesDir, { recursive: true });
writeFileSync(join(pagesDir, 'index.html'), html);
writeFileSync(join(pagesDir, '.nojekyll'), '');

console.log(`built ${full} — ${(html.length / 1024).toFixed(0)} KB`);
console.log(`built ${frag} (Artifact-Fragment)`);
console.log(`built ${join(pagesDir, 'index.html')} (GitHub Pages)`);

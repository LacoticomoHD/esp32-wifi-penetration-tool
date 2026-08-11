// INTRO Pulse — KI-Analyse als Supabase Edge Function.
//
// Ruft Claude SERVERSEITIG auf. Der API-Key liegt als Secret ANTHROPIC_API_KEY
// in Supabase (Dashboard → Edge Functions → Secrets) und ist im Browser nie
// sichtbar. Die App (Dashboard-HTML) ruft diese Funktion per fetch auf.
//
// Hinweis Zugriff: Die Funktion ist ohne Login erreichbar (verify_jwt=false),
// damit das verteilte Dashboard-HTML sie direkt aufrufen kann. Der Schutz gegen
// Kostenmissbrauch ist ein Ausgabe-Limit auf dem Anthropic-Key (Console).
// Echte Login-Absicherung folgt mit der Auth-Schicht (pulse_profiles, RLS).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (code: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status: code,
    headers: { ...CORS, "content-type": "application/json; charset=utf-8" },
  });

function systemPrompt(steckbrief?: string): string {
  return [
    "Du bist ein nüchterner, erfahrener B2B-Vertriebsanalyst und wertest die Kaltakquise-Kampagne eines Kunden aus.",
    "Antworte auf Deutsch — konkret, knapp, mit Zahlenbezug. Keine Floskeln, kein Marketing-Sprech.",
    "Bleib ehrlich: Wenn die Fallzahl klein ist oder etwas unklar bleibt, sag das.",
    steckbrief ? `\n--- Projekt-Steckbrief (Kontext zum Kunden/zur Kampagne) ---\n${steckbrief}` : "",
  ].join("\n");
}
function analyzeUser(report: unknown): string {
  return [
    "Hier sind die aggregierten Kennzahlen und Gesprächsnotizen einer Kampagne als JSON:",
    "```json",
    JSON.stringify(report, null, 2),
    "```",
    "",
    "Erstelle eine Auswertung mit GENAU diesen Abschnitten (jeweils 2–4 Sätze, immer mit konkreten Zahlen):",
    "## Was lief gut",
    "## Warum (noch) keine Termine",
    "## Früh-Abriss & schwer zu knackende Firmen",
    "## Konkrete Empfehlungen (max. 4, priorisiert)",
    "Nutze den Projekt-Steckbrief für die Deutung (Zielsegment/ICP, Einwände, Angebot, Kampagnenziel).",
  ].join("\n");
}

// Angehängte Kontext-Dateien → Claude-Content-Blöcke.
// PDF/Bild als base64, Office/CSV als bereits im Browser extrahierter Text.
// deno-lint-ignore no-explicit-any
function attachmentBlocks(atts: any): any[] {
  if (!Array.isArray(atts)) return [];
  // deno-lint-ignore no-explicit-any
  const out: any[] = [];
  for (const a of atts) {
    if (!a) continue;
    if (a.kind === "pdf" && a.data) {
      out.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: a.data } });
    } else if (a.kind === "image" && a.data) {
      out.push({ type: "image", source: { type: "base64", media_type: a.media_type || "image/png", data: a.data } });
    } else if (a.kind === "text" && a.text) {
      out.push({ type: "text", text: `--- Angehängte Datei: ${a.name || "Dokument"} ---\n${String(a.text).slice(0, 200000)}` });
    }
  }
  return out;
}

// deno-lint-ignore no-explicit-any
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json(405, { error: "Nur POST." });

  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) {
    return json(400, {
      error: "Kein ANTHROPIC_API_KEY gesetzt. Lege ihn in Supabase unter Edge Functions → Secrets an (ANTHROPIC_API_KEY=sk-ant-…).",
    });
  }

  // deno-lint-ignore no-explicit-any
  let p: any;
  try { p = await req.json(); } catch { return json(400, { error: "Ungültiger Request-Body (kein JSON)." }); }

  const model: string = p.model || "claude-sonnet-5";
  const system = systemPrompt(p.steckbrief);
  const docs = attachmentBlocks(p.attachments);
  const messages =
    p.mode === "chat"
      ? [
          { role: "user", content: [...docs, { type: "text", text: `Kampagnendaten (JSON):\n\`\`\`json\n${JSON.stringify(p.report)}\n\`\`\`` }] },
          { role: "assistant", content: "Verstanden — ich habe die Kampagnendaten und ggf. die angehängten Dokumente vorliegen. Was möchtest du wissen?" },
          ...(Array.isArray(p.history) ? p.history : []),
          { role: "user", content: String(p.question || "") },
        ]
      : [{ role: "user", content: [...docs, { type: "text", text: analyzeUser(p.report) }] }];

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model, max_tokens: 2500, system, messages }),
    });
    const data = await r.json();
    if (!r.ok) {
      const msg = data?.error?.message || `Anthropic-Fehler ${r.status}`;
      return json(502, { error: msg });
    }
    // deno-lint-ignore no-explicit-any
    const text = (data.content || [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n")
      .trim();
    return json(200, { text, model: data.model });
  } catch (e) {
    return json(502, { error: (e as Error)?.message || "Fehler beim KI-Aufruf." });
  }
});

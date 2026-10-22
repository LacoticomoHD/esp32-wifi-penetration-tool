// INTRO Pulse — Aircall-Abgleich als Supabase Edge Function.
//
// Holt die ausgehenden Anrufe eines Zeitfensters SERVERSEITIG aus der Aircall-
// API. Zugangsdaten liegen als Secrets AIRCALL_API_ID / AIRCALL_API_TOKEN in
// Supabase (Dashboard → Edge Functions → Secrets), nie im Browser.
//
// Datensparsam: Die App schickt die Telefonnummern ihrer Kampagne (normalisiert)
// mit. Zurück kommen nur Anrufe auf genau diese Nummern — fremde Nummern
// verlassen den Server nie, zu ihnen gibt es nur eine Anzahl.
//
// Aircall begrenzt auf 50 Anrufe je Seite, 10.000 je Abfrage und 120 Anfragen
// pro Minute. Deshalb arbeitet die Funktion in Etappen: die App fragt Fenster
// von max. 8 Tagen ab und blättert mit `page`, bis `nextPage` null ist.

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

const MAX_WINDOW_SEC = 8 * 24 * 3600;
const MAX_KEYS = 20000;
const PAGES_PER_CALL = 25; // 1.250 Anrufe je Aufruf — bleibt unter dem Zeitlimit
const AIRCALL_MAX_ITEMS = 10000;

// Gleiche Normalisierung wie src/aircall.ts (Browser).
function normPhone(raw: string): string {
  const s = String(raw || "").replace(/\(0\)/g, "").trim();
  const d = s.replace(/\D/g, "");
  if (!d) return "";
  if (s.startsWith("+")) return d;
  if (d.startsWith("00")) return d.slice(2);
  if (d.startsWith("0")) return "49" + d.slice(1);
  return d;
}
function matchKey(digits: string, exact: Set<string>, prefix: Set<string>): string | null {
  if (exact.has(digits)) return digits;
  for (let l = digits.length - 1; l >= 9; l--) {
    const p = digits.slice(0, l);
    if (prefix.has(p)) return "p:" + p;
  }
  return null;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "Nur POST." });

  const id = Deno.env.get("AIRCALL_API_ID");
  const token = Deno.env.get("AIRCALL_API_TOKEN");
  if (!id || !token) {
    return json(503, { code: "not_configured", error: "Aircall ist noch nicht verbunden (Secrets AIRCALL_API_ID / AIRCALL_API_TOKEN fehlen)." });
  }

  // deno-lint-ignore no-explicit-any
  let body: any;
  try { body = await req.json(); } catch { return json(400, { error: "Ungültiges JSON." }); }
  const from = Math.floor(Number(body?.from));
  const to = Math.floor(Number(body?.to));
  const startPage = Math.max(1, Math.floor(Number(body?.page) || 1));
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return json(400, { error: "Zeitraum fehlt oder ist ungültig." });
  if (to - from > MAX_WINDOW_SEC) return json(400, { error: "Zeitfenster zu groß (max. 8 Tage je Abfrage)." });
  const exactArr: string[] = Array.isArray(body?.exact) ? body.exact.map(String) : [];
  const prefixArr: string[] = Array.isArray(body?.prefix) ? body.prefix.map(String) : [];
  if (exactArr.length + prefixArr.length === 0) return json(400, { error: "Keine Telefonnummern übergeben." });
  if (exactArr.length + prefixArr.length > MAX_KEYS) return json(400, { error: "Zu viele Telefonnummern." });
  const exact = new Set(exactArr.filter((k) => /^\d{6,}$/.test(k)));
  const prefix = new Set(prefixArr.filter((k) => /^\d{9,}$/.test(k)));

  const auth = "Basic " + btoa(`${id}:${token}`);
  const calls: { k: string; u: string; s: number; a: number | null; e: number }[] = [];
  let scanned = 0, unmatched = 0, total = 0;
  let page = startPage;
  let nextPage: number | null = null;

  for (let i = 0; i < PAGES_PER_CALL; i++) {
    const url = `https://api.aircall.io/v1/calls/search?direction=outbound&order=asc&per_page=50&page=${page}&from=${from}&to=${to}`;
    let res = await fetch(url, { headers: { Authorization: auth } });
    if (res.status === 429) {
      // Rate-Limit: bis zum Reset warten (max. 20 s), dann einmal erneut.
      const reset = Number(res.headers.get("X-AircallApi-Reset")) || 0;
      const wait = Math.min(20000, Math.max(1000, reset * 1000 - Date.now() + 500));
      await sleep(wait);
      res = await fetch(url, { headers: { Authorization: auth } });
      if (res.status === 429) { nextPage = page; break; } // App setzt später fort
    }
    if (res.status === 401 || res.status === 403) {
      return json(502, { code: "auth", error: "Aircall lehnt die Zugangsdaten ab — API-ID/Token in Supabase prüfen." });
    }
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return json(502, { error: `Aircall-Fehler ${res.status}: ${t.slice(0, 200)}` });
    }
    // deno-lint-ignore no-explicit-any
    const data: any = await res.json();
    total = Number(data?.meta?.total) || 0;
    if (page === 1 && total > AIRCALL_MAX_ITEMS) {
      return json(200, { split: true, total }); // App halbiert das Fenster
    }
    for (const c of data?.calls ?? []) {
      scanned++;
      const k = matchKey(normPhone(String(c?.raw_digits ?? "")), exact, prefix);
      if (!k) { unmatched++; continue; }
      calls.push({
        k,
        u: String(c?.user?.name ?? ""),
        s: Number(c?.started_at) || 0,
        a: c?.answered_at ? Number(c.answered_at) : null,
        e: Number(c?.ended_at) || Number(c?.started_at) || 0,
      });
    }
    if (!data?.meta?.next_page_link) { nextPage = null; break; }
    page++;
    nextPage = page;
  }

  return json(200, { calls, scanned, unmatched, total, nextPage });
});

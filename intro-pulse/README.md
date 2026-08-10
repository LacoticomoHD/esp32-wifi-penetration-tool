# INTRO Pulse

Interne Web-App der **INTRO Business Contact GmbH** zur Auswertung von
Kaltakquise-Kampagnen. Details siehe [`SPEC.md`](./SPEC.md).

Status: **Phase 1** in Umsetzung. Dieses Paket enthält aktuell den
framework-unabhängigen **Analyse-Kern** (Parser + Funnel-Mapping + KPIs), der
später von der Next.js-App aufgerufen wird.

## Analyse-Kern lokal ausprobieren

Voraussetzung: Node ≥ 20.

```bash
cd intro-pulse
npm install

# Tests (synthetische Fixture, keine echten Daten)
npm test

# Eine echte Aktivitätsdatei auswerten (XLSX oder CSV)
npm run analyze -- /pfad/zur/Aktivitaeten.xlsx
```

## Was der Kern berechnet

- **Termin-Quote** (Firmen mit Termin / kontaktierte Firmen)
- **Anrufe bis Termin** (Ø Aktivitäten je Firma bis zum Erfolg)
- **Entscheider-Quote** und **Früh-Abriss-Rate**
- Funnel-Verteilung, je **Akquisiteur** und je **Segment** (Umsatz, Mitarbeiter)

Das Funnel-Mapping (`Ergebnis` → Stufe) steht zentral in
[`src/funnel.ts`](./src/funnel.ts) und ist dort leicht erweiterbar.

## Datenschutz

Echte Uploads enthalten personenbezogene B2B-Kontaktdaten und werden **nie**
committet (siehe `.gitignore`). Für die KI-Analyse (Phase 2) wird ein
Anthropic-**API**-Schlüssel benötigt (`ANTHROPIC_API_KEY`) — nutzungsbasiert,
unabhängig vom Claude-Pro-Abo.

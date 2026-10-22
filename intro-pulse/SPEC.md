# INTRO Pulse — Spezifikation (v0.1)

Interne Web-App der **INTRO Business Contact GmbH** zur Auswertung von
Kaltakquise-Kampagnen. Kennzahlen werden **deterministisch** berechnet, die
qualitative Deutung liefert **Claude** (Anthropic-API). Das CSM-Team nutzt die
App, um Akquisiteuren gezieltes Feedback zu geben.

> Status: abgestimmt am 2026-08-10. Phase 1 in Umsetzung.

## 1. Zweck

Je Kampagne sichtbar machen: was läuft gut, warum kommen Termine (nicht)
zustande, wo reißen Kontakte ab — mit Vergleich zum vorherigen Stand.

## 2. Kernobjekte (Datenmodell)

| Objekt | Bedeutung |
|---|---|
| **Projekt** | = eine Kampagne (Name aus Spalte `Kampagne`, z. B. „viergrad GmbH" = Kunde). Anlegen · archivieren (Soft-Delete) · Gesamtübersicht. |
| **Snapshot** | Ein Upload (XLSX/CSV) zu einem Zeitpunkt. Mehrere pro Projekt → Vergleich / Deltas. |
| **Aktivität** | Eine Zeile = ein Kontakt-Versuch. Wird zu **Firma** verdichtet (weitester Funnel-Stand). |
| **Firma** | Aggregat aller Aktivitäten einer `Firma/Account`. |
| **Akquisiteur** | Aus `Zugeordnet`. Ermöglicht Leistung je Person + CSM-Feedback. |

## 3. Eingabeformat

XLSX/CSV mit 14 festen Spalten (Stand Beispieldatei):

`Firma/Account`, `Erstelldatum`, `Ergebnis`, `Kommentar`,
`Entscheidergespräch`, `Contact Funktion`, `Kontakt`, `E-Mail`, `Telefon`,
`Stadt (Postanschrift)`, `Zugeordnet`, `Account Umsatz`,
`Account Mitarbeiter`, `Kampagne`.

Robuster Parser für deutsche Eigenheiten: Semikolon-Trenner, Umlaute/BOM,
`TT.MM.JJJJ`, `"12.000.000,00 €"`, geschützte Leerzeichen (NBSP), kaputte
Zeichen (Mojibake). Das Aktivitäts-Blatt wird automatisch erkannt
(Header-Abgleich + meiste Zeilen); ein evtl. zweites Blatt
(`Ersttermin vereinbart`) wird abgeleitet, nicht benötigt.

## 4. Funnel-Mapping (`Ergebnis` → Stufe)

| `Ergebnis` | Stufe (Rang) | Flag |
|---|---|---|
| *(jede Firma)* | Lead (0) | — |
| Nicht erreicht · Dauerhaft nicht erreicht | Kontaktversuch (1) | nie erreicht |
| Falscher Ansprechpartner | Kontaktversuch (1) | AP-Recherche |
| Entscheider erreicht, nochmal anrufen | Entscheider erreicht (2) | — |
| Grundsätzlich kein Interesse / Kampagnen-Stopp | Entscheider erreicht (2) | disqualifiziert |
| Infomaterial angefordert · Input erhalten | Interesse (3) | Info-Phase |
| Zukünftiges · Kurzfristiges Interesse | Interesse (3) | Nurture |
| Aktuell kein Interesse | Interesse (3) | Wiedervorlage |
| Entscheider, Ersttermin vereinbart | **Termin vereinbart (4)** | Erfolg |

Zusätzlich hebt `Entscheidergespräch = Ja` eine Firma auf mindestens
Rang 2 (Entscheider erreicht). **Früh-Abriss** (Q5) = Firma hat nie einen
Entscheider erreicht (Rang ≤ 1, kein Entscheidergespräch, kein Termin).

## 5. Kennzahlen (Priorität: Termin-Quote)

1. **Termin-Quote** = Firmen mit Termin / kontaktierte Firmen.
2. **Anrufe bis Termin** — Ø Aktivitäten je Firma bis zum Termin.
3. **Entscheider-/Kontaktquote** — Firmen mit Entscheidergespräch / kontaktierte.
4. **Früh-Abriss-Rate** — Firmen, die nie einen Entscheider erreicht haben.

Alle KPIs zusätzlich **je Akquisiteur** und **je Segment** (Umsatz-Klasse,
Mitarbeiter-Klasse, Stadt), plus **Delta zum Vor-Snapshot** und Zeitverlauf
(aus `Erstelldatum`, schon ab einer Datei).

## 6. Analyse (Claude, Phase 2)

Feste Bausteine: (a) Was lief gut · (b) Warum keine Termine · (c) Früh-Abriss-
Muster · (d) Abriss-Punkte im Funnel · (e) Verbesserungsvorschläge ·
(f) Delta-Deutung. Claude wertet v. a. die `Kommentar`-Spalte aus. Zusätzlich
**freier KI-Chat je Projekt**. Läuft über die **Anthropic-API**
(`ANTHROPIC_API_KEY`, nutzungsbasiert — nicht das Claude-Pro-Abo).

## 7. Rollen & Zugriff

- **Admin** — legt Nutzer an, vergibt Rolle + Bezeichnung.
- **CSM** — Vollzugriff + Feedback.
- **Akquisiteur** — eigene Sicht.

Login per E-Mail/Passwort. CSM kann Feedback/Notizen je Projekt und je
Akquisiteur speichern (mit Historie).

## 8. Design

Hell/weiß, **Navy-Header mit weißem INTRO-Logo**, Akzentfarbe **#ff6f61**,
Schrift/Farben angelehnt an intro-bc.de. Voll interaktiv (Filter, Drill-down,
Charts). Nur interne Ansicht (kein PDF-Export).

## 9. Technik

Next.js + TypeScript · Prisma (**SQLite lokal**, Postgres für EU-Cloud) ·
serverseitiges XLSX/CSV-Parsing · Anthropic-API serverseitig ·
Docker-/EU-deploybar. Start: **lokal** (0 € Betrieb).

## 10. Phasen

1. **Fundament** — Login · Projekt · Upload+Parsing · KPIs + Funnel · Übersicht.
2. **Intelligenz** — Claude-Analyse + Snapshot-Deltas + KI-Chat.
3. **Feinschliff** — CSM-Feedback-Modul + Design-Politur.

## 11. Datenschutz

Verarbeitet werden B2B-Kontaktdaten Dritter. Vor Team-Rollout: AVV/DPA mit
Anthropic, EU-Hosting bevorzugt. Rohdaten liegen in der eigenen DB; echte
Löschung nur für Admin.

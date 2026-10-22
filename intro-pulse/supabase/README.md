# INTRO Pulse — Persistenz (Phase 1, Schritt 4–5)

Grundlage für **mehrere Projekte speichern · Reports vergleichen (Snapshot vs.
Vorreport) · Login & Rollen · CSM‑Feedback**. Alles läuft auf Supabase
(PostgreSQL + Auth, Region EU/Frankfurt).

Diese Migrationen sind **rein additiv** und mit `pulse_`‑Präfix versehen — sie
lassen sich in ein eigenes oder ein bestehendes Supabase‑Projekt einspielen,
ohne mit anderen Tabellen zu kollidieren.

## Tabellen

| Tabelle | Zweck |
|---|---|
| `pulse_profiles` | Ein Datensatz je App‑Nutzer (1:1 zu `auth.users`), mit globaler Rolle. |
| `pulse_projects` | Projekte/Kampagnen — inkl. An/Aus‑Schalter (`is_active`) und „entfernt" (`archived_at`, Historie bleibt). |
| `pulse_project_members` | Wer hat Zugriff auf welches Projekt (Admin vergibt). |
| `pulse_snapshots` | Jeder Upload = ein vergleichbarer Report‑Stand; komplettes Kpis‑Objekt als `jsonb`. |
| `pulse_feedback` | CSM‑Feedback an Akquisiteure (Phase‑3‑Modul, Schema schon jetzt angelegt). |

## Rollen

- **admin** — sieht/verwaltet alles, vergibt Zugriff, benennt Rollen.
- **csm** — arbeitet mit den Listen, schreibt Feedback (nur eigene Projekte).
- **akquisiteur** — sieht die zugewiesenen Projekte + an ihn gerichtetes Feedback.

Row Level Security ist auf allen Tabellen aktiv (`0002_pulse_rls.sql`): Zugriff
auf ein Projekt = Admin **oder** Eintrag in `pulse_project_members`. Rollen
darf nur ein Admin ändern (zusätzlich per DB‑Trigger abgesichert).

## Einspielen

**A) Supabase SQL‑Editor** (einfachster Weg): Inhalt von `0001_pulse_schema.sql`
einfügen und ausführen, danach `0002_pulse_rls.sql`.

**B) Supabase CLI:**
```bash
supabase link --project-ref <ref>
supabase db push        # wendet supabase/migrations/* an
```

## Ersten Admin festlegen (einmalig)

Nach der ersten Registrierung legt ein Trigger automatisch ein
`pulse_profiles`‑Profil an (Standardrolle `akquisiteur`). Den ersten Admin
setzt du einmalig von Hand:

```sql
update pulse_profiles set role = 'admin'
where email = 'deine-admin-mail@intro-bc.de';
```

Danach vergibt dieser Admin alle weiteren Rollen und Projekt‑Zugriffe in der App.

## App‑Anbindung

`webapp/src/db.ts` ist die typisierte Datenzugriffs‑Schicht (Login, Projekte,
Snapshots, Mitglieder/Rollen, Feedback). Sie ist noch **nicht** ins laufende
Dashboard eingebunden — das ist der nächste Schritt (Login‑Ansicht +
Projekt‑Überblick + Snapshot speichern/vergleichen). Konfiguration über
`SUPABASE_URL` / `SUPABASE_ANON_KEY` (siehe `.env.example`); der Snapshot‑Vergleich
nutzt `src/compare.ts` (`diffKpis`).

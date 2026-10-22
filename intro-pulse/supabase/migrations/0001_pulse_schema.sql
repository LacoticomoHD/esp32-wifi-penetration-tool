-- INTRO Pulse — Persistenz-Schema (Phase 1, Schritt 4–5)
-- Projekte · Snapshots (Report-Vergleich) · Rollen · Zugriff · CSM-Feedback
--
-- Alle Objekte sind mit "pulse_" praefixiert, damit INTRO Pulse sich sauber von
-- anderen Apps in derselben Datenbank trennt. Nichts Bestehendes wird veraendert.
-- Reihenfolge: dieses Skript zuerst, danach 0002_pulse_rls.sql.

-- === Rollen =================================================================
do $$ begin
  create type pulse_role as enum ('admin', 'csm', 'akquisiteur');
exception when duplicate_object then null; end $$;

-- === Profile (1:1 zu auth.users) ===========================================
-- Ein Datensatz je App-Nutzer. role steuert die globale Berechtigung.
create table if not exists pulse_profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  full_name  text,
  role       pulse_role  not null default 'akquisiteur',
  is_active  boolean     not null default true,   -- Admin kann deaktivieren
  created_at timestamptz not null default now()
);

-- === Projekte / Kampagnen ===================================================
create table if not exists pulse_projects (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,                      -- z. B. "Viergrad Kaltakquise"
  client_name    text,                               -- z. B. "viergrad GmbH"
  description    text,
  steckbrief     text,                               -- KI-Kontext (optional)
  goal_per_month int         not null default 3,     -- Kampagnenziel Termine/Monat
  is_active      boolean     not null default true,  -- An/Aus-Schalter im Ueberblick
  archived_at    timestamptz,                        -- "entfernt" (Historie bleibt)
  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- === Projekt-Zugriff (Admin vergibt Zugriff + benennt Rolle) ================
create table if not exists pulse_project_members (
  project_id uuid not null references pulse_projects(id) on delete cascade,
  user_id    uuid not null references auth.users(id)     on delete cascade,
  role       pulse_role  not null default 'csm',    -- Rolle innerhalb dieses Projekts
  added_by   uuid references auth.users(id) on delete set null,
  added_at   timestamptz not null default now(),
  primary key (project_id, user_id)
);

-- === Snapshots (jeder Upload = ein vergleichbarer Report-Stand) =============
-- Das vollstaendige Kpis-Objekt liegt als jsonb -> Vergleich/Deltas gegen den
-- Vorreport laufen komplett aus diesen Snapshots. Kennzahlen zusaetzlich
-- denormalisiert, damit Listen/Sortierung ohne jsonb-Parsing funktionieren.
create table if not exists pulse_snapshots (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references pulse_projects(id) on delete cascade,
  label            text,                              -- z. B. "KW 32 / 07.08.2026"
  source_filename  text,
  taken_at         timestamptz not null default now(),
  period_from      date,                              -- Zeitraum laut Daten
  period_to        date,
  total_companies  int,
  total_activities int,
  won_companies    int,
  termin_quote     numeric,                           -- Kern-KPI (denormalisiert)
  kpis             jsonb not null,                    -- vollstaendiges Kpis-Objekt
  companies        jsonb,                             -- optional: Firmen-Aggregate
  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now()
);
create index if not exists pulse_snapshots_project_idx
  on pulse_snapshots (project_id, taken_at desc);

-- === CSM-Feedback an Akquisiteure (Phase-3-Modul, Schema schon jetzt) =======
create table if not exists pulse_feedback (
  id                  uuid primary key default gen_random_uuid(),
  project_id          uuid not null references pulse_projects(id) on delete cascade,
  snapshot_id         uuid references pulse_snapshots(id) on delete set null,
  company_name        text,                           -- betroffene Firma
  subject_akquisiteur text,                           -- Name laut Liste ("zugeordnet")
  assigned_to         uuid references auth.users(id) on delete set null,
  author_id           uuid references auth.users(id) on delete set null,
  message             text not null,
  category            text,                           -- z. B. "ap_recherche", "nachfassen"
  status              text        not null default 'offen',  -- offen | erledigt
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists pulse_feedback_project_idx
  on pulse_feedback (project_id, status);

-- === Hilfsfunktionen (SECURITY DEFINER → keine RLS-Rekursion in Policies) ===
create or replace function pulse_is_admin(uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from pulse_profiles p
    where p.id = uid and p.role = 'admin' and p.is_active
  );
$$;

create or replace function pulse_has_project_access(pid uuid, uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select pulse_is_admin(uid)
      or exists (
        select 1 from pulse_project_members m
        where m.project_id = pid and m.user_id = uid
      );
$$;

-- === Trigger: neue auth.users → pulse_profiles ==============================
create or replace function pulse_handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into pulse_profiles (id, email, full_name)
  values (new.id, new.email,
          coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists pulse_on_auth_user_created on auth.users;
create trigger pulse_on_auth_user_created
  after insert on auth.users
  for each row execute function pulse_handle_new_user();

-- === Trigger: nur Admins duerfen Rollen aendern (Eskalationsschutz) =========
create or replace function pulse_guard_role_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.role is distinct from old.role and not pulse_is_admin(auth.uid()) then
    raise exception 'Nur ein Admin darf Rollen aendern.';
  end if;
  return new;
end $$;

drop trigger if exists pulse_profiles_guard_role on pulse_profiles;
create trigger pulse_profiles_guard_role
  before update on pulse_profiles
  for each row execute function pulse_guard_role_change();

-- === Trigger: updated_at pflegen ============================================
create or replace function pulse_touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists pulse_projects_touch on pulse_projects;
create trigger pulse_projects_touch before update on pulse_projects
  for each row execute function pulse_touch_updated_at();

drop trigger if exists pulse_feedback_touch on pulse_feedback;
create trigger pulse_feedback_touch before update on pulse_feedback
  for each row execute function pulse_touch_updated_at();

-- === Backfill: bestehende auth.users bekommen ein Profil ====================
insert into pulse_profiles (id, email)
  select u.id, u.email from auth.users u
  on conflict (id) do nothing;

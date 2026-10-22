-- INTRO Pulse — Row Level Security (nach 0001_pulse_schema.sql anwenden).
--
-- Rollenmodell:
--   admin        — sieht/verwaltet alles, vergibt Zugriff, benennt Rollen
--   csm          — arbeitet mit den Listen, schreibt Feedback (nur eigene Projekte)
--   akquisiteur  — sieht die zugewiesenen Projekte + an ihn gerichtetes Feedback
-- Zugriff auf ein Projekt = Admin ODER Eintrag in pulse_project_members.

alter table pulse_profiles        enable row level security;
alter table pulse_projects        enable row level security;
alter table pulse_project_members enable row level security;
alter table pulse_snapshots       enable row level security;
alter table pulse_feedback        enable row level security;

-- --- pulse_profiles ---------------------------------------------------------
drop policy if exists pulse_profiles_select on pulse_profiles;
create policy pulse_profiles_select on pulse_profiles for select
  using (id = auth.uid() or pulse_is_admin(auth.uid()));

drop policy if exists pulse_profiles_update on pulse_profiles;
create policy pulse_profiles_update on pulse_profiles for update
  using (id = auth.uid() or pulse_is_admin(auth.uid()))
  with check (id = auth.uid() or pulse_is_admin(auth.uid()));
-- Rollenwechsel ist zusaetzlich per Trigger auf Admins beschraenkt.

drop policy if exists pulse_profiles_insert on pulse_profiles;
create policy pulse_profiles_insert on pulse_profiles for insert
  with check (pulse_is_admin(auth.uid()));

drop policy if exists pulse_profiles_delete on pulse_profiles;
create policy pulse_profiles_delete on pulse_profiles for delete
  using (pulse_is_admin(auth.uid()));

-- --- pulse_projects ---------------------------------------------------------
drop policy if exists pulse_projects_select on pulse_projects;
create policy pulse_projects_select on pulse_projects for select
  using (pulse_has_project_access(id, auth.uid()));

drop policy if exists pulse_projects_insert on pulse_projects;
create policy pulse_projects_insert on pulse_projects for insert
  with check (pulse_is_admin(auth.uid()));

drop policy if exists pulse_projects_update on pulse_projects;
create policy pulse_projects_update on pulse_projects for update
  using (pulse_has_project_access(id, auth.uid()))
  with check (pulse_has_project_access(id, auth.uid()));

drop policy if exists pulse_projects_delete on pulse_projects;
create policy pulse_projects_delete on pulse_projects for delete
  using (pulse_is_admin(auth.uid()));

-- --- pulse_project_members (nur Admin vergibt/entzieht Zugriff) --------------
drop policy if exists pulse_members_select on pulse_project_members;
create policy pulse_members_select on pulse_project_members for select
  using (pulse_is_admin(auth.uid()) or pulse_has_project_access(project_id, auth.uid()));

drop policy if exists pulse_members_write on pulse_project_members;
create policy pulse_members_write on pulse_project_members for all
  using (pulse_is_admin(auth.uid()))
  with check (pulse_is_admin(auth.uid()));

-- --- pulse_snapshots --------------------------------------------------------
drop policy if exists pulse_snapshots_select on pulse_snapshots;
create policy pulse_snapshots_select on pulse_snapshots for select
  using (pulse_has_project_access(project_id, auth.uid()));

drop policy if exists pulse_snapshots_insert on pulse_snapshots;
create policy pulse_snapshots_insert on pulse_snapshots for insert
  with check (pulse_has_project_access(project_id, auth.uid()) and created_by = auth.uid());

drop policy if exists pulse_snapshots_delete on pulse_snapshots;
create policy pulse_snapshots_delete on pulse_snapshots for delete
  using (pulse_is_admin(auth.uid()) or created_by = auth.uid());

-- --- pulse_feedback ---------------------------------------------------------
drop policy if exists pulse_feedback_select on pulse_feedback;
create policy pulse_feedback_select on pulse_feedback for select
  using (pulse_has_project_access(project_id, auth.uid()));

drop policy if exists pulse_feedback_insert on pulse_feedback;
create policy pulse_feedback_insert on pulse_feedback for insert
  with check (pulse_has_project_access(project_id, auth.uid()) and author_id = auth.uid());

drop policy if exists pulse_feedback_update on pulse_feedback;
create policy pulse_feedback_update on pulse_feedback for update
  using (author_id = auth.uid() or pulse_is_admin(auth.uid()))
  with check (author_id = auth.uid() or pulse_is_admin(auth.uid()));

drop policy if exists pulse_feedback_delete on pulse_feedback;
create policy pulse_feedback_delete on pulse_feedback for delete
  using (author_id = auth.uid() or pulse_is_admin(auth.uid()));

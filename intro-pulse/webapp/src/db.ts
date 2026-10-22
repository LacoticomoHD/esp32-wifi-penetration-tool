// Datenzugriffs-Schicht fuer INTRO Pulse (Supabase).
//
// Diese Schicht ist bewusst noch NICHT in die laufende App (main.ts) eingebunden
// — sie ist die Grundlage fuer Phase 1, Schritt 4–5 (Login/Rollen, Projekte,
// Snapshot-Vergleich) und wird im naechsten Schritt an die UI verdrahtet.
//
// Konfiguration zur Laufzeit ueber window.__PULSE_ENV (vom Server injiziert),
// damit weder URL noch (oeffentlicher) Key im gebauten Bundle fest verdrahtet
// sind. Der anon/publishable Key ist oeffentlich; geschuetzt wird ueber RLS.

import { createClient, type SupabaseClient, type Session } from '@supabase/supabase-js';
import type { Kpis } from '../../src/types';
import type {
  PulseProfile,
  PulseProject,
  PulseProjectMember,
  PulseSnapshot,
  PulseFeedback,
  PulseRole,
} from './db.types';

interface PulseEnv { url?: string; anonKey?: string }
const ENV: PulseEnv = (globalThis as unknown as { __PULSE_ENV?: PulseEnv }).__PULSE_ENV || {};

let _sb: SupabaseClient | null = null;
export function sb(): SupabaseClient {
  if (!_sb) {
    if (!ENV.url || !ENV.anonKey) throw new Error('Supabase ist nicht konfiguriert (SUPABASE_URL / SUPABASE_ANON_KEY).');
    _sb = createClient(ENV.url, ENV.anonKey, { auth: { persistSession: true, autoRefreshToken: true } });
  }
  return _sb;
}
/** Ist eine Supabase-Verbindung konfiguriert? (Sonst laeuft die App rein lokal weiter.) */
export function isConfigured(): boolean {
  return Boolean(ENV.url && ENV.anonKey);
}

// --- Auth -------------------------------------------------------------------
export async function signIn(email: string, password: string): Promise<Session> {
  const { data, error } = await sb().auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.session!;
}
export async function signOut(): Promise<void> {
  const { error } = await sb().auth.signOut();
  if (error) throw error;
}
export async function getSession(): Promise<Session | null> {
  const { data } = await sb().auth.getSession();
  return data.session;
}
export async function myProfile(): Promise<PulseProfile | null> {
  const { data: u } = await sb().auth.getUser();
  if (!u.user) return null;
  const { data, error } = await sb().from('pulse_profiles').select('*').eq('id', u.user.id).maybeSingle();
  if (error) throw error;
  return data as PulseProfile | null;
}

// --- Projekte ---------------------------------------------------------------
export async function listProjects(includeArchived = false): Promise<PulseProject[]> {
  let q = sb().from('pulse_projects').select('*').order('created_at', { ascending: false });
  if (!includeArchived) q = q.is('archived_at', null);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as PulseProject[];
}
export async function createProject(input: {
  name: string; client_name?: string; description?: string; steckbrief?: string; goal_per_month?: number;
}): Promise<PulseProject> {
  const { data: u } = await sb().auth.getUser();
  const { data, error } = await sb()
    .from('pulse_projects')
    .insert({ ...input, created_by: u.user?.id })
    .select('*')
    .single();
  if (error) throw error;
  return data as PulseProject;
}
/** An/Aus-Schalter im Ueberblick. */
export async function setProjectActive(id: string, is_active: boolean): Promise<void> {
  const { error } = await sb().from('pulse_projects').update({ is_active }).eq('id', id);
  if (error) throw error;
}
/** "Entfernen" = archivieren (Historie/Snapshots bleiben erhalten). */
export async function archiveProject(id: string): Promise<void> {
  const { error } = await sb().from('pulse_projects').update({ archived_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
}

// --- Snapshots (Report-Staende) --------------------------------------------
export async function listSnapshots(projectId: string): Promise<PulseSnapshot[]> {
  const { data, error } = await sb()
    .from('pulse_snapshots').select('*')
    .eq('project_id', projectId).order('taken_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as PulseSnapshot[];
}
/** Die zwei juengsten Staende — fuer den direkten Vorreport-Vergleich. */
export async function latestTwoSnapshots(projectId: string): Promise<[PulseSnapshot | null, PulseSnapshot | null]> {
  const { data, error } = await sb()
    .from('pulse_snapshots').select('*')
    .eq('project_id', projectId).order('taken_at', { ascending: false }).limit(2);
  if (error) throw error;
  const rows = (data ?? []) as PulseSnapshot[];
  return [rows[0] ?? null, rows[1] ?? null];
}
export async function saveSnapshot(
  projectId: string,
  kpis: Kpis,
  meta: { label?: string; source_filename?: string; companies?: unknown } = {},
): Promise<PulseSnapshot> {
  const { data: u } = await sb().auth.getUser();
  const row = {
    project_id: projectId,
    label: meta.label ?? null,
    source_filename: meta.source_filename ?? null,
    period_from: kpis.dateRange.from ? new Date(kpis.dateRange.from).toISOString().slice(0, 10) : null,
    period_to: kpis.dateRange.to ? new Date(kpis.dateRange.to).toISOString().slice(0, 10) : null,
    total_companies: kpis.totalCompanies,
    total_activities: kpis.totalActivities,
    won_companies: kpis.wonCompanies,
    termin_quote: kpis.terminQuote,
    kpis,
    companies: meta.companies ?? null,
    created_by: u.user?.id,
  };
  const { data, error } = await sb().from('pulse_snapshots').insert(row).select('*').single();
  if (error) throw error;
  return data as PulseSnapshot;
}

// --- Mitglieder / Rollen (Admin vergibt Zugriff) ----------------------------
export async function listMembers(projectId: string): Promise<PulseProjectMember[]> {
  const { data, error } = await sb().from('pulse_project_members').select('*').eq('project_id', projectId);
  if (error) throw error;
  return (data ?? []) as PulseProjectMember[];
}
export async function addMember(projectId: string, userId: string, role: PulseRole = 'csm'): Promise<void> {
  const { data: u } = await sb().auth.getUser();
  const { error } = await sb()
    .from('pulse_project_members')
    .upsert({ project_id: projectId, user_id: userId, role, added_by: u.user?.id });
  if (error) throw error;
}
export async function removeMember(projectId: string, userId: string): Promise<void> {
  const { error } = await sb().from('pulse_project_members').delete().eq('project_id', projectId).eq('user_id', userId);
  if (error) throw error;
}
/** Globale Rolle setzen (nur Admin; per DB-Trigger zusaetzlich abgesichert). */
export async function setUserRole(userId: string, role: PulseRole): Promise<void> {
  const { error } = await sb().from('pulse_profiles').update({ role }).eq('id', userId);
  if (error) throw error;
}

// --- Feedback (CSM → Akquisiteur) -------------------------------------------
export async function listFeedback(projectId: string): Promise<PulseFeedback[]> {
  const { data, error } = await sb()
    .from('pulse_feedback').select('*')
    .eq('project_id', projectId).order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as PulseFeedback[];
}
export async function addFeedback(input: {
  project_id: string; message: string; company_name?: string; subject_akquisiteur?: string;
  assigned_to?: string; snapshot_id?: string; category?: string;
}): Promise<PulseFeedback> {
  const { data: u } = await sb().auth.getUser();
  const { data, error } = await sb()
    .from('pulse_feedback')
    .insert({ ...input, author_id: u.user?.id })
    .select('*')
    .single();
  if (error) throw error;
  return data as PulseFeedback;
}
export async function setFeedbackStatus(id: string, status: 'offen' | 'erledigt'): Promise<void> {
  const { error } = await sb().from('pulse_feedback').update({ status }).eq('id', id);
  if (error) throw error;
}

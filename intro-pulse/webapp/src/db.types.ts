// Datentypen der INTRO-Pulse-Persistenz (Spiegel des SQL-Schemas).
// Die verbindliche Variante kann nach dem Einspielen aus dem Live-Schema
// generiert werden (Supabase: generate_typescript_types / `supabase gen types`).

import type { Kpis } from '../../src/types';

export type PulseRole = 'admin' | 'csm' | 'akquisiteur';

export interface PulseProfile {
  id: string;
  email: string | null;
  full_name: string | null;
  role: PulseRole;
  is_active: boolean;
  created_at: string;
}

export interface PulseProject {
  id: string;
  name: string;
  client_name: string | null;
  description: string | null;
  steckbrief: string | null;
  goal_per_month: number;
  is_active: boolean;
  archived_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface PulseProjectMember {
  project_id: string;
  user_id: string;
  role: PulseRole;
  added_by: string | null;
  added_at: string;
}

export interface PulseSnapshot {
  id: string;
  project_id: string;
  label: string | null;
  source_filename: string | null;
  taken_at: string;
  period_from: string | null;
  period_to: string | null;
  total_companies: number | null;
  total_activities: number | null;
  won_companies: number | null;
  termin_quote: number | null;
  kpis: Kpis;
  companies: unknown | null;
  created_by: string | null;
  created_at: string;
}

export interface PulseFeedback {
  id: string;
  project_id: string;
  snapshot_id: string | null;
  company_name: string | null;
  subject_akquisiteur: string | null;
  assigned_to: string | null;
  author_id: string | null;
  message: string;
  category: string | null;
  status: string; // 'offen' | 'erledigt'
  created_at: string;
  updated_at: string;
}

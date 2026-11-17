-- ============================================================
--  Studien-Tracker — einmaliges Supabase-Setup
--  Ausführen in: Supabase-Dashboard → SQL Editor → New query → Run
--  Legt eine Tabelle an, in der pro Nutzer EIN Datensatz (dein
--  kompletter App-Zustand als JSON) liegt, geschützt per Row-Level-Security.
-- ============================================================

-- 1) Tabelle: eine Zeile pro Nutzer (user_id = Supabase-Auth-Benutzer)
create table if not exists public.app_state (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,   -- kompletter App-Zustand
  updated_at timestamptz not null default now()    -- "zuletzt gespeichert gewinnt"
);

-- 2) Row-Level-Security aktivieren: jeder sieht/ändert NUR seine eigene Zeile
alter table public.app_state enable row level security;

-- 3) Zugriffsregeln (idempotent: erst löschen, dann neu anlegen)
drop policy if exists "own row select" on public.app_state;
drop policy if exists "own row insert" on public.app_state;
drop policy if exists "own row update" on public.app_state;

create policy "own row select" on public.app_state
  for select using (auth.uid() = user_id);

create policy "own row insert" on public.app_state
  for insert with check (auth.uid() = user_id);

create policy "own row update" on public.app_state
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Fertig. Danach in der App (Einstellungen → Synchronisierung) mit E-Mail anmelden.

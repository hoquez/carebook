-- Carebook: complete setup for a NEW, EMPTY Carebook.
-- This is every table, column, access rule and storage bucket the app needs, with no
-- patient data in it. Use this when setting Carebook up for a different person.
-- (The other supabase-*.sql files are the original step-by-step scripts and contain
-- Ayesha Khatun's records; do not run those for anyone else.)
--
-- Before running: create the person's login in Authentication -> Users -> Add user.
-- Run once in Supabase -> SQL Editor. Safe to run again.

-- 1. Tables ------------------------------------------------------------------

create table if not exists public.medications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  medicine text not null,
  strength text,
  brand text,
  dosage text,
  duration text,
  prescriber text,
  specialization text,
  start_date date,
  end_date date,
  notes text
);

create table if not exists public.lab_results (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  test_name text not null,
  result text,
  unit text,
  reference_range text,
  test_date date,
  provider text,
  report_note text,
  report_path text
);

create table if not exists public.visits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  visit_date date,
  provider text,
  advice text,
  symptoms text,
  bp text,
  pulse text,
  weight text,
  height text,
  notes text
);

create table if not exists public.providers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null,
  profile_url text,
  unique (user_id, name)
);

-- 2. Access rules: only the signed-in owner of a row can read or change it ----

alter table public.medications enable row level security;
alter table public.lab_results enable row level security;
alter table public.visits      enable row level security;
alter table public.providers   enable row level security;

drop policy if exists "carebook_owner_access" on public.medications;
drop policy if exists "carebook_owner_access" on public.lab_results;
drop policy if exists "carebook_owner_access" on public.visits;
drop policy if exists "carebook_owner_access" on public.providers;

create policy "carebook_owner_access" on public.medications
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "carebook_owner_access" on public.lab_results
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "carebook_owner_access" on public.visits
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "carebook_owner_access" on public.providers
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Visitors who are not signed in get no access at all.
revoke all on public.medications, public.lab_results, public.visits, public.providers from anon;
grant select, insert, update, delete
  on public.medications, public.lab_results, public.visits, public.providers
  to authenticated;

-- 3. Private storage for report files ----------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('reports', 'reports', false, 20971520, array['application/pdf', 'image/*'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Each user can only touch files inside a folder named after their own user id.
drop policy if exists "carebook_reports_owner" on storage.objects;
create policy "carebook_reports_owner" on storage.objects
  for all to authenticated
  using (bucket_id = 'reports' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'reports' and (storage.foldername(name))[1] = auth.uid()::text);

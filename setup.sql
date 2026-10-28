-- «Мой день»: таблица для всех дел, долгов, сна и настроек.
-- Supabase → SQL Editor → New query → вставить всё → Run.
create table if not exists public.docs (
  owner uuid not null default auth.uid() references auth.users on delete cascade,
  col text not null,
  id text not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (owner, col, id)
);
alter table public.docs enable row level security;
drop policy if exists "only mine" on public.docs;
create policy "only mine" on public.docs for all to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());
grant select, insert, update, delete on public.docs to authenticated;

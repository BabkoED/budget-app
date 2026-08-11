-- Бюджет-PWA — схема Supabase
-- Выполнить один раз в Supabase → SQL Editor → New query → Run

create table if not exists user_state (
  user_id    uuid primary key references auth.users on delete cascade,
  state      jsonb not null default '{}',
  updated_at timestamptz default now()
);

alter table user_state enable row level security;

-- Каждый видит и меняет только свои данные
drop policy if exists "owner_only" on user_state;
create policy "owner_only"
  on user_state for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Права для API (нужны, если при создании проекта было выключено
-- "Automatically expose new tables" — иначе будет ошибка 403)
grant usage on schema public to anon, authenticated;
grant all on table public.user_state to anon, authenticated;

-- Живая синхронизация между устройствами.
-- Без этой строки приложение работает, но правки со второго устройства
-- подтягиваются только при возврате на вкладку, а не мгновенно.
-- REPLICA IDENTITY FULL нужен, чтобы realtime отдавал user_id в фильтре.
alter table user_state replica identity full;
do $$
begin
  alter publication supabase_realtime add table user_state;
exception
  when duplicate_object then null;   -- уже добавлена, это нормально
end $$;

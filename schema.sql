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
--
-- ВАЖНО, применено на проде 06.09.2026. Раньше здесь стояло
--   grant all on table public.user_state to anon, authenticated;
-- Это давало анонимной роли полные права, включая DELETE. Пока RLS
-- включён, вреда нет — но защита держалась на одном выключателе:
-- снимешь RLS для отладки, и анонимный ключ (а он лежит в index.html
-- открыто, так и задумано у Supabase) сможет стереть данные.
-- Документация Supabase про это прямо: «Adding policies doesn't remove
-- grants» — политика не отменяет выданное право.
--
-- anon не нужен вовсе: приложение работает только после входа.
-- DELETE не нужен тоже: данные чистятся внутри JSON, строка не сносится.
grant usage on schema public to anon, authenticated;
grant select, insert, update on table public.user_state to authenticated;

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

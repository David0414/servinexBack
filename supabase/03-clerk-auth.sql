-- Actualización si ya instalaste la versión anterior con Supabase Auth.
-- Pegar completa en SQL Editor. Reejecutable; conserva UUIDs, roles e historial.
-- Los perfiles anteriores necesitan vincularse con su User ID de Clerk.
begin;
alter table public.staff_profiles add column if not exists clerk_user_id text;
create unique index if not exists staff_profiles_clerk_user_id_key on public.staff_profiles(clerk_user_id);
do $$ begin
 if exists(select 1 from information_schema.columns where table_schema='public' and table_name='staff_profiles' and column_name='auth_user_id') then
  alter table public.staff_profiles alter column auth_user_id drop not null;
  alter table public.staff_profiles drop constraint if exists staff_profiles_auth_user_id_fkey;
 end if;
 if not exists(select 1 from pg_constraint where conrelid='public.staff_profiles'::regclass and conname='staff_profiles_clerk_id_check') then
  alter table public.staff_profiles add constraint staff_profiles_clerk_id_check check(clerk_user_id is null or clerk_user_id ~ '^user_[A-Za-z0-9]+$');
 end if;
end $$;
insert into public.schema_versions(version) values('002-clerk-auth') on conflict do nothing;
commit;
-- Para vincular cada perfil anterior sin recrearlo:
-- update public.staff_profiles set clerk_user_id='user_ID_REAL_DE_CLERK' where id='UUID_DEL_PERFIL_EXISTENTE';

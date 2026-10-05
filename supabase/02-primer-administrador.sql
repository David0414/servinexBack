-- 1. Clerk Dashboard > Users: crea/invita al usuario y copia su User ID (user_...).
-- 2. Edita clerk_id y staff_name en DECLARE. Pega este SQL en Supabase > SQL Editor.
-- Si ya instalaste la versión anterior, ejecuta primero 03-clerk-auth.sql.
do $$
declare
 clerk_id text := 'user_3KFAyTCbJ43g2zCYUWDHZnsE56n';
 staff_name text := 'Administrador Servinex';
 -- Al migrar, pega el UUID del perfil existente para conservar historial y permisos.
 existing_staff_id uuid := null;
begin
 clerk_id := btrim(clerk_id);
 if clerk_id is null or clerk_id !~ '^user_[A-Za-z0-9]+$' then
  raise exception 'Crea el usuario en Clerk y reemplaza clerk_id con su User ID real';
 end if;
 if existing_staff_id is not null then
  update public.staff_profiles set clerk_user_id=clerk_id,name=staff_name,role='ADMIN',active=true where id=existing_staff_id;
  if not found then raise exception 'No existe el perfil interno indicado'; end if;
 else
  insert into public.staff_profiles(clerk_user_id,name,role,active)
  values(clerk_id,staff_name,'ADMIN',true)
  on conflict(clerk_user_id) do update set name=excluded.name,role='ADMIN',active=true;
 end if;
end $$;

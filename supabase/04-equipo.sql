-- Ejecutar UNA VEZ en Supabase > SQL Editor para administrar el equipo desde OPS.
-- Reejecutable. Conserva las cuentas y el historial existentes.
begin;
alter table public.staff_profiles add column if not exists email text;
create unique index if not exists staff_email_unique on public.staff_profiles(lower(email)) where email is not null;

create or replace function public.team_save(p_staff uuid, p_id uuid, p_data jsonb)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
 actor public.staff_profiles;
 previous public.staff_profiles;
 member public.staff_profiles;
 member_name text := btrim(p_data->>'name');
 member_role text := p_data->>'role';
 member_email text := lower(btrim(p_data->>'email'));
 member_active boolean := coalesce((p_data->>'active')::boolean,true);
begin
 -- Serializa cambios de permisos y comprueba al administrador dentro del bloqueo.
 perform pg_advisory_xact_lock(734291,1);
 select * into actor from public.staff_profiles where id=p_staff;
 if actor.id is null or not actor.active or actor.role <> 'ADMIN' then
  raise exception 'Se requiere acceso de administrador';
 end if;
 if member_name is null or length(member_name)<2 or length(member_name)>100
    or member_role is null or member_role not in ('ADMIN','OPS') then
  raise exception 'Nombre o permisos inválidos';
 end if;
 if p_id is null then
  if member_email is null or length(member_email)>254 or member_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or coalesce(p_data->>'clerk_user_id','') !~ '^user_[A-Za-z0-9]+$' then
   raise exception 'Correo o cuenta inválidos';
  end if;
  select * into member from public.staff_profiles where clerk_user_id=p_data->>'clerk_user_id';
  if member.id is not null then
   if member.id = (p_data->>'request_id')::uuid then return to_jsonb(member); end if;
   raise exception 'Esta cuenta ya forma parte del equipo';
  end if;
  insert into public.staff_profiles(id,clerk_user_id,name,email,role,active)
  values((p_data->>'request_id')::uuid,p_data->>'clerk_user_id',member_name,member_email,member_role,true)
  returning * into member;
 else
  select * into previous from public.staff_profiles where id=p_id for update;
  if previous.id is null then raise exception 'No existe esa persona en el equipo'; end if;
  if p_id=p_staff and (member_role<>'ADMIN' or not member_active) then
   raise exception 'No puedes quitarte tus permisos de administrador ni desactivar tu propia cuenta';
  end if;
  if previous.active and previous.role='ADMIN' and (member_role<>'ADMIN' or not member_active)
     and (select count(*) from public.staff_profiles where active and role='ADMIN') <= 1 then
   raise exception 'Debe quedar al menos un administrador activo';
  end if;
  update public.staff_profiles set name=member_name,role=member_role,active=member_active
  where id=p_id returning * into member;
 end if;
 insert into public.audit_logs(staff_id,action,entity_type,entity_id,before_json,after_json)
 values(p_staff,case when p_id is null then 'team_create' else 'team_update' end,'staff_profile',member.id,
   case when p_id is null then null else to_jsonb(previous) end,to_jsonb(member));
 return to_jsonb(member);
end $$;
revoke all on function public.team_save(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.team_save(uuid,uuid,jsonb) to service_role;
insert into public.schema_versions(version) values('003-equipo') on conflict do nothing;
notify pgrst, 'reload schema';
commit;

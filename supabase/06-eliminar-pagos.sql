-- Ejecutar despues de 05-eliminar-servicios.sql en Supabase > SQL Editor.
-- Elimina pagos de servicios ya borrados y actualiza futuras eliminaciones.
-- No toca pagos de servicios que no han sido eliminados. Reejecutable.
begin;
do $$ begin
 if not exists(select 1 from public.schema_versions where version='004-eliminar-servicios') then
  raise exception 'Ejecuta primero 05-eliminar-servicios.sql';
 end if;
end $$;

create or replace function public.service_delete(p_staff uuid, p_id uuid, p_folio text)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
 actor public.staff_profiles;
 previous public.service_orders;
 removed public.service_orders;
 payments_before jsonb;
begin
 -- El mismo bloqueo que team_save: una baja de permisos no puede cruzarse con el borrado.
 perform pg_advisory_xact_lock(734291,1);
 select * into actor from public.staff_profiles where id=p_staff for share;
 if actor.id is null or not actor.active or actor.role <> 'ADMIN' then
  raise exception 'Se requiere acceso de administrador' using errcode='42501';
 end if;
 -- Orden de bloqueo compartido por ops_action y partner_action.
 select * into previous from public.service_orders where id=p_id for update;
 if previous.id is null then
  raise exception 'Servicio no encontrado' using errcode='P0002';
 end if;
 if p_folio is null or btrim(p_folio) <> previous.folio then
  raise exception 'El folio de confirmación no coincide con el servicio';
 end if;
 -- Borra pagos de todas las asignaciones, incluidos PAID y asignaciones históricas.
 select coalesce(jsonb_agg(to_jsonb(p) order by p.created_at,p.id),'[]'::jsonb)
 into payments_before from public.provider_payments p
 where p.assignment_id in(select id from public.service_assignments where service_order_id=p_id);
 delete from public.provider_payments
 where assignment_id in(select id from public.service_assignments where service_order_id=p_id);
 -- Un reintento tras perder la respuesta conserva fecha, administrador y una sola auditoría.
 if previous.deleted_at is not null then
  if jsonb_array_length(payments_before)>0 then
   insert into public.audit_logs(staff_id,action,entity_type,entity_id,before_json,after_json)
   values(p_staff,'service_payments_delete','service',p_id,
     jsonb_build_object('folio',previous.folio,'provider_payments',payments_before),
     jsonb_build_object('folio',previous.folio,'provider_payments','[]'::jsonb));
  end if;
  return jsonb_build_object('id',previous.id,'folio',previous.folio,'deleted_at',previous.deleted_at);
 end if;
 update public.service_orders set deleted_at=now(),deleted_by=p_staff
 where id=p_id returning * into removed;
 update public.assignment_access_tokens set revoked_at=now()
 where assignment_id in(select id from public.service_assignments where service_order_id=p_id)
   and revoked_at is null;
 update public.service_assignments set active=false,status='CANCELLED'
 where service_order_id=p_id and active;
 insert into public.service_events(service_order_id,actor_type,actor_id,event_type,payload_json)
 values(p_id,'STAFF',p_staff,'delete',jsonb_build_object('folio',previous.folio));
 insert into public.audit_logs(staff_id,action,entity_type,entity_id,before_json,after_json)
 values(p_staff,'service_delete','service',p_id,
   to_jsonb(previous)||jsonb_build_object('provider_payments',payments_before),
   to_jsonb(removed)||jsonb_build_object('provider_payments','[]'::jsonb));
 return jsonb_build_object('id',removed.id,'folio',removed.folio,'deleted_at',removed.deleted_at);
end $$;
revoke all on function public.service_delete(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.service_delete(uuid,uuid,text) to service_role;

-- Limpia pagos retenidos por la version anterior, con snapshot de auditoria.
-- Bloquea cada servicio en el mismo orden que las operaciones de la API.
do $$
declare
 removed public.service_orders;
 payments_before jsonb;
begin
 perform pg_advisory_xact_lock(734291,1);
 for removed in
  select o.* from public.service_orders o where o.deleted_at is not null
    and exists(select 1 from public.provider_payments p join public.service_assignments a
      on a.id=p.assignment_id where a.service_order_id=o.id)
  order by o.id for update of o
 loop
  select coalesce(jsonb_agg(to_jsonb(p) order by p.created_at,p.id),'[]'::jsonb)
  into payments_before from public.provider_payments p
  where p.assignment_id in(select id from public.service_assignments where service_order_id=removed.id);
  delete from public.provider_payments
  where assignment_id in(select id from public.service_assignments where service_order_id=removed.id);
  if jsonb_array_length(payments_before)>0 then
   insert into public.audit_logs(staff_id,action,entity_type,entity_id,before_json,after_json)
   values(null,'service_payments_cleanup','service',removed.id,
     jsonb_build_object('folio',removed.folio,'provider_payments',payments_before),
     jsonb_build_object('folio',removed.folio,'provider_payments','[]'::jsonb,'migration','005-eliminar-pagos'));
  end if;
 end loop;
end $$;
insert into public.schema_versions(version) values('005-eliminar-pagos') on conflict do nothing;
notify pgrst, 'reload schema';
commit;

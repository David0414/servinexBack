-- Ejecutar una vez en Supabase > SQL Editor para eliminar servicios desde OPS.
-- Reejecutable. Elimina todos los pagos del servicio; conserva reportes, evidencias y auditoría.
begin;
alter table public.service_orders add column if not exists deleted_at timestamptz;
alter table public.service_orders add column if not exists deleted_by uuid references public.staff_profiles(id);

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

create or replace function public.ops_action(p_staff uuid,p_action text,p_id uuid default null,p_data jsonb default '{}') returns jsonb language plpgsql set search_path = public as $$
declare
 st staff_profiles; o service_orders; a service_assignments; r service_reports; pr providers;
 cid uuid; nid uuid; yr integer; seq bigint; result jsonb; old jsonb; amount numeric;
begin
 select * into st from staff_profiles where id=p_staff and active;
 if st.id is null then raise exception 'Acceso no autorizado'; end if;
 if p_action in ('pay','provider_save','edit') and st.role<>'ADMIN' then raise exception 'Solo un administrador puede realizar esta acción'; end if;
 if p_action='create' then
  insert into customers(name,phone) values(p_data->>'customer_name',p_data->>'customer_phone') returning id into cid;
  yr=extract(year from now() at time zone 'America/Mexico_City');
  insert into folio_counters(year,value) values(yr,1) on conflict(year) do update set value=folio_counters.value+1 returning value into seq;
  insert into service_orders(folio,customer_id,service_type_id,description,zone,address,scheduled_at,customer_price,additional_costs,internal_notes,created_by)
   values('SVX-'||yr||'-'||lpad(seq::text,6,'0'),cid,(p_data->>'service_type_id')::uuid,p_data->>'description',p_data->>'zone',p_data->>'address',(p_data->>'scheduled_at')::timestamptz,(p_data->>'customer_price')::numeric,coalesce((p_data->>'additional_costs')::numeric,0),coalesce(p_data->>'internal_notes',''),st.id) returning * into o;
  nid=o.id; result=to_jsonb(o);
 elsif p_action='provider_save' then
  if p_id is not null then select to_jsonb(p) into old from providers p where id=p_id for update; if old is null then raise exception 'Proveedor no encontrado'; end if; end if;
  insert into providers(id,name,phone,email,zones,notes,status) values(coalesce(p_id,gen_random_uuid()),p_data->>'name',p_data->>'phone',nullif(p_data->>'email',''),p_data->>'zones',p_data->>'notes',p_data->>'status') on conflict(id) do update set name=excluded.name,phone=excluded.phone,email=excluded.email,zones=excluded.zones,notes=excluded.notes,status=excluded.status returning * into pr;
  delete from provider_service_types where provider_id=pr.id;
  insert into provider_service_types(provider_id,service_type_id) select pr.id,value::uuid from jsonb_array_elements_text(p_data->'service_type_ids');
  insert into audit_logs(staff_id,action,entity_type,entity_id,before_json,after_json) values(st.id,p_action,'provider',pr.id,old,to_jsonb(pr));
  return to_jsonb(pr);
 else
  -- Resolver siempre el servicio antes de tomar el bloqueo; orden uniforme.
  if p_action in ('link','pay') then select * into a from service_assignments where id=p_id; nid=a.service_order_id;
  elsif p_action='approve' then select * into r from service_reports where id=p_id; select * into a from service_assignments where id=r.assignment_id; nid=a.service_order_id;
  else nid=p_id; end if;
  select * into o from service_orders where id=nid and deleted_at is null for update;
  if o.id is null then raise exception 'Servicio no encontrado'; end if;
  old=to_jsonb(o);
  if p_action='edit' then
   if o.status in ('CLOSED','CANCELLED') then raise exception 'El servicio está cerrado'; end if;
   update service_orders set description=coalesce(p_data->>'description',description),zone=coalesce(p_data->>'zone',zone),address=coalesce(p_data->>'address',address),scheduled_at=case when p_data ? 'scheduled_at' then (p_data->>'scheduled_at')::timestamptz else scheduled_at end,customer_price=coalesce((p_data->>'customer_price')::numeric,customer_price),additional_costs=coalesce((p_data->>'additional_costs')::numeric,additional_costs),internal_notes=coalesce(p_data->>'internal_notes',internal_notes) where id=o.id;
  elsif p_action='assign' then
   if o.status not in ('NEW','ASSIGNED','OFFER_SENT','REJECTED') then raise exception 'No se puede reasignar un servicio aceptado o finalizado'; end if;
   if not exists(select 1 from providers where id=(p_data->>'provider_id')::uuid and status='ACTIVE') then raise exception 'Proveedor inactivo'; end if;
   update assignment_access_tokens set revoked_at=now() where assignment_id in (select id from service_assignments where service_order_id=o.id) and revoked_at is null;
   update provider_payments set status='CANCELLED' where assignment_id in(select id from service_assignments where service_order_id=o.id and active) and status<>'PAID';
   update service_assignments set active=false,status='CANCELLED' where service_order_id=o.id and active;
   insert into service_assignments(service_order_id,provider_id,provider_payout) values(o.id,(p_data->>'provider_id')::uuid,(p_data->>'provider_payout')::numeric) returning * into a;
   insert into provider_payments(assignment_id,amount) values(a.id,a.provider_payout);
   update service_orders set status='ASSIGNED' where id=o.id;
  elsif p_action='link' then
   select * into a from service_assignments where id=p_id;
   if not a.active or o.status in ('CLOSED','CANCELLED','REJECTED') then raise exception 'Asignación no disponible'; end if;
   update assignment_access_tokens set revoked_at=now() where assignment_id=a.id and revoked_at is null;
   insert into assignment_access_tokens(assignment_id,token_hash,expires_at) values(a.id,p_data->>'token_hash',(p_data->>'expires_at')::timestamptz);
   if o.status='ASSIGNED' then update service_orders set status='OFFER_SENT' where id=o.id; update service_assignments set status='OFFER_SENT' where id=a.id; end if;
  elsif p_action='cancel' then
   if o.status in ('CLOSED','CANCELLED') then raise exception 'El servicio ya finalizó'; end if;
   update service_orders set status='CANCELLED' where id=o.id;
   update service_assignments set active=false,status='CANCELLED' where service_order_id=o.id and active;
   update assignment_access_tokens set revoked_at=now() where assignment_id in(select id from service_assignments where service_order_id=o.id) and revoked_at is null;
   update provider_payments set status='CANCELLED' where assignment_id in(select id from service_assignments where service_order_id=o.id) and status<>'PAID';
  elsif p_action='approve' then
   select * into r from service_reports where id=p_id;
   if o.status='CLOSED' and r.review_status='APPROVED' then return jsonb_build_object('id',o.id); end if;
   if o.status<>'REPORT_SUBMITTED' or not a.active then raise exception 'No hay reporte pendiente de revisión'; end if;
   update service_reports set review_status='APPROVED',reviewed_by=st.id,reviewed_at=now() where id=r.id;
   update service_orders set status='CLOSED' where id=o.id;
   update service_assignments set active=false,status='CLOSED',completed_at=now() where id=a.id;
   update assignment_access_tokens set revoked_at=now() where assignment_id=a.id and revoked_at is null;
   update provider_payments set status='APPROVED',approved_at=now() where assignment_id=a.id and status='PENDING';
  elsif p_action='pay' then
   if o.status<>'CLOSED' then raise exception 'Primero aprueba el reporte'; end if;
   if exists(select 1 from provider_payments where assignment_id=a.id and status='PAID') then return jsonb_build_object('id',o.id); end if;
   update provider_payments set status='PAID',paid_at=now(),payment_reference=p_data->>'payment_reference' where assignment_id=a.id and status='APPROVED';
   if not found then raise exception 'Pago no aprobado'; end if;
  else raise exception 'Acción desconocida'; end if;
  select to_jsonb(s) into result from service_orders s where id=o.id;
 end if;
 insert into service_events(service_order_id,actor_type,actor_id,event_type,payload_json) values(nid,'STAFF',st.id,p_action,jsonb_build_object('assignment_id',a.id));
 insert into audit_logs(staff_id,action,entity_type,entity_id,before_json,after_json) values(st.id,p_action,'service',nid,old,result || case when a.id is not null then jsonb_build_object('assignment',to_jsonb(a)) else '{}'::jsonb end);
 return result || jsonb_build_object('assignment_id',a.id);
end $$;
revoke all on function public.ops_action(uuid,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.ops_action(uuid,text,uuid,jsonb) to service_role;

create or replace function public.ops_dashboard(p_staff uuid,p_from timestamptz default null,p_to timestamptz default null) returns jsonb language plpgsql set search_path=public as $$
declare result jsonb;
begin
 if not exists(select 1 from staff_profiles where id=p_staff and active) then raise exception 'Acceso no autorizado'; end if;
 with orders as (select * from service_orders where deleted_at is null and (p_from is null or created_at>=p_from) and (p_to is null or created_at<=p_to)),
 amounts as(select o.*,coalesce((select provider_payout from service_assignments where service_order_id=o.id and status not in('CANCELLED','REJECTED') order by assigned_at desc limit 1),0) as payout from orders o)
 select jsonb_build_object('total',count(*),'new',count(*) filter(where status in('NEW','REJECTED')),'assigned',count(*) filter(where status in('ASSIGNED','OFFER_SENT')),'progress',count(*) filter(where status in('ACCEPTED','IN_ROUTE','IN_PROGRESS')),'review',count(*) filter(where status='REPORT_SUBMITTED'),'closed',count(*) filter(where status='CLOSED'),'revenue',coalesce(sum(customer_price) filter(where status<>'CANCELLED'),0),'payout',coalesce(sum(payout) filter(where status<>'CANCELLED'),0),'margin',coalesce(sum(customer_price-payout-additional_costs) filter(where status<>'CANCELLED'),0),'counts',coalesce((select jsonb_object_agg(status,n) from(select status,count(*) n from orders group by status)s),'{}'::jsonb)) into result from amounts;
 return result;
end $$;
revoke all on function public.ops_dashboard(uuid,timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.ops_dashboard(uuid,timestamptz,timestamptz) to service_role;
insert into public.schema_versions(version) values('004-eliminar-servicios') on conflict do nothing;
notify pgrst, 'reload schema';
commit;

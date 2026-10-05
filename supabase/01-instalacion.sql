-- SERVINEX MVP · Pegar completo en Supabase > SQL Editor > Run.
-- Reejecutable. No necesita Prisma, CLI ni cadena de conexión PostgreSQL.
begin;
create extension if not exists pgcrypto;
create table if not exists public.schema_versions(version text primary key, installed_at timestamptz not null default now());
create table if not exists public.staff_profiles(id uuid primary key default gen_random_uuid(), clerk_user_id text not null unique constraint staff_profiles_clerk_id_check check(clerk_user_id ~ '^user_[A-Za-z0-9]+$'), name text not null, role text not null check(role in ('ADMIN','OPS')), active boolean not null default true, created_at timestamptz not null default now());
create table if not exists public.service_types(id uuid primary key default gen_random_uuid(), name text not null, code text not null unique, active boolean not null default true);
create table if not exists public.providers(id uuid primary key default gen_random_uuid(), name text not null, phone text not null, email text, zones text not null default '', status text not null default 'ACTIVE' check(status in ('ACTIVE','INACTIVE')), notes text not null default '', created_at timestamptz not null default now());
create table if not exists public.provider_service_types(provider_id uuid references public.providers(id), service_type_id uuid references public.service_types(id), active boolean not null default true, primary key(provider_id,service_type_id));
create table if not exists public.customers(id uuid primary key default gen_random_uuid(),name text not null,phone text not null,created_at timestamptz not null default now());
create table if not exists public.folio_counters(year integer primary key, value bigint not null);
create table if not exists public.service_orders(id uuid primary key default gen_random_uuid(), folio text not null unique,customer_id uuid not null references public.customers(id),service_type_id uuid not null references public.service_types(id),description text not null,zone text not null,address text not null,scheduled_at timestamptz,customer_price numeric(14,2) not null check(customer_price>=0),additional_costs numeric(14,2) not null default 0 check(additional_costs>=0),internal_notes text not null default '',status text not null default 'NEW' check(status in ('NEW','ASSIGNED','OFFER_SENT','ACCEPTED','IN_ROUTE','IN_PROGRESS','REPORT_SUBMITTED','CLOSED','CANCELLED','REJECTED')),created_by uuid not null references public.staff_profiles(id),created_at timestamptz not null default now());
create table if not exists public.service_assignments(id uuid primary key default gen_random_uuid(),service_order_id uuid not null references public.service_orders(id),provider_id uuid not null references public.providers(id),provider_payout numeric(14,2) not null check(provider_payout>=0),status text not null default 'ASSIGNED',active boolean not null default true,assigned_at timestamptz not null default now(),accepted_at timestamptz,completed_at timestamptz);
alter table public.service_orders add column if not exists deleted_at timestamptz;
alter table public.service_orders add column if not exists deleted_by uuid references public.staff_profiles(id);
create unique index if not exists one_active_assignment on public.service_assignments(service_order_id) where active;
create table if not exists public.assignment_access_tokens(id uuid primary key default gen_random_uuid(),assignment_id uuid not null references public.service_assignments(id),token_hash text not null unique,expires_at timestamptz not null,revoked_at timestamptz,created_at timestamptz not null default now());
create unique index if not exists one_unrevoked_token on public.assignment_access_tokens(assignment_id) where revoked_at is null;
create table if not exists public.service_events(id uuid primary key default gen_random_uuid(),service_order_id uuid not null references public.service_orders(id),actor_type text not null,actor_id uuid,event_type text not null,payload_json jsonb not null default '{}',created_at timestamptz not null default now());
create table if not exists public.service_reports(id uuid primary key default gen_random_uuid(),assignment_id uuid not null unique references public.service_assignments(id),work_done text not null,materials text not null default '',observations text not null default '',submitted_at timestamptz not null default now(),review_status text not null default 'PENDING',reviewed_by uuid references public.staff_profiles(id),reviewed_at timestamptz);
-- Reservas de carga: un path solo puede pertenecer a una asignación y usarse una vez.
create table if not exists public.evidence_uploads(id uuid primary key default gen_random_uuid(),assignment_id uuid not null references public.service_assignments(id),kind text not null check(kind in ('before','after')),storage_path text not null unique,verified_path text,verified boolean not null default false,mime_type text,size_bytes integer,created_at timestamptz not null default now());
alter table public.evidence_uploads add column if not exists verified_path text;
create table if not exists public.service_evidence(id uuid primary key default gen_random_uuid(),report_id uuid not null references public.service_reports(id),upload_id uuid not null unique references public.evidence_uploads(id),kind text not null,storage_path text not null,mime_type text not null,size_bytes integer not null,created_at timestamptz not null default now());
create table if not exists public.provider_payments(id uuid primary key default gen_random_uuid(),assignment_id uuid not null unique references public.service_assignments(id),amount numeric(14,2) not null,status text not null default 'PENDING' check(status in ('PENDING','APPROVED','PAID','CANCELLED')),approved_at timestamptz,paid_at timestamptz,payment_reference text,created_at timestamptz not null default now());
create table if not exists public.audit_logs(id uuid primary key default gen_random_uuid(),staff_id uuid references public.staff_profiles(id),action text not null,entity_type text not null,entity_id uuid,before_json jsonb,after_json jsonb,created_at timestamptz not null default now());
create index if not exists orders_status_created on public.service_orders(status,created_at desc);
create index if not exists assignments_provider_status on public.service_assignments(provider_id,status);
create index if not exists events_service_created on public.service_events(service_order_id,created_at);
create index if not exists payments_status_created on public.provider_payments(status,created_at);
do $$ declare t text; begin foreach t in array array['schema_versions','staff_profiles','service_types','providers','provider_service_types','customers','folio_counters','service_orders','service_assignments','assignment_access_tokens','service_events','service_reports','evidence_uploads','service_evidence','provider_payments','audit_logs'] loop execute format('alter table public.%I enable row level security',t); execute format('revoke all on public.%I from anon, authenticated',t); execute format('grant all on public.%I to service_role',t); end loop; end $$;
insert into public.service_types(name,code) values ('Plomería','plomeria'),('Drenaje','drenaje'),('Fumigación','fumigacion'),('Electricidad','electricidad'),('Aire acondicionado','aire'),('Mantenimiento general','mantenimiento') on conflict(code) do nothing;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values ('service-evidence','service-evidence',false,8388608,array['image/jpeg','image/png','image/webp']) on conflict(id) do update set public=false,file_size_limit=8388608,allowed_mime_types=array['image/jpeg','image/png','image/webp'];

-- Todas las mutaciones relacionadas se ejecutan dentro de una transacción,
-- con bloqueo por orden. Solo la API con service_role puede invocar estas funciones.
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

create or replace function public.partner_action(p_hash text,p_action text,p_data jsonb default '{}') returns jsonb language plpgsql set search_path=public as $$
declare t assignment_access_tokens; a service_assignments; o service_orders; result jsonb; eid uuid; rid uuid; n integer;
begin
 select * into t from assignment_access_tokens where token_hash=p_hash;
 if t.id is null then raise exception 'Liga inválida o vencida'; end if;
 select * into a from service_assignments where id=t.assignment_id;
 select * into o from service_orders where id=a.service_order_id for update;
 -- Volver a leer credencial y asignación después del bloqueo para prevenir carreras.
 select * into t from assignment_access_tokens where id=t.id;
 select * into a from service_assignments where id=a.id;
 if t.revoked_at is not null or t.expires_at<=now() or not a.active or o.status in ('CLOSED','CANCELLED','REJECTED') then raise exception 'Liga inválida o vencida'; end if;
 if p_action in ('accept','reject') then
  if p_action='accept' and o.status in ('ACCEPTED','IN_ROUTE','IN_PROGRESS','REPORT_SUBMITTED') then return jsonb_build_object('status',o.status); end if;
  if o.status<>'OFFER_SENT' then raise exception 'La oferta no está disponible'; end if;
  if p_action='accept' then
   update service_orders set status='ACCEPTED' where id=o.id;
   update service_assignments set status='ACCEPTED',accepted_at=now() where id=a.id;
  else
   update service_orders set status='REJECTED' where id=o.id;
   update service_assignments set status='REJECTED',active=false where id=a.id;
   update assignment_access_tokens set revoked_at=now() where assignment_id=a.id and revoked_at is null;
   update provider_payments set status='CANCELLED' where assignment_id=a.id;
  end if;
 elsif p_action='status' then
  if o.status=p_data->>'status' then return jsonb_build_object('status',o.status); end if;
  if not ((o.status='ACCEPTED' and p_data->>'status' in ('IN_ROUTE','IN_PROGRESS')) or (o.status='IN_ROUTE' and p_data->>'status'='IN_PROGRESS')) then raise exception 'Cambio de estado no permitido'; end if;
  update service_orders set status=p_data->>'status' where id=o.id;
  update service_assignments set status=p_data->>'status' where id=a.id;
 elsif p_action='upload' then
  if o.status<>'IN_PROGRESS' then raise exception 'Primero inicia el servicio'; end if;
  select count(*) into n from evidence_uploads where assignment_id=a.id and kind=p_data->>'kind' and created_at>now()-interval '2 hours';
  if n>=20 then raise exception 'Límite de cargas alcanzado'; end if;
  eid=gen_random_uuid();
  insert into evidence_uploads(id,assignment_id,kind,storage_path) values(eid,a.id,p_data->>'kind',o.id||'/'||a.id||'/'||(p_data->>'kind')||'/'||eid||'.webp');
  return (select jsonb_build_object('id',id,'storage_path',storage_path) from evidence_uploads where id=eid);
 elsif p_action='report' then
  if o.status='REPORT_SUBMITTED' then return jsonb_build_object('status',o.status); end if;
  if o.status<>'IN_PROGRESS' then raise exception 'Primero inicia el servicio'; end if;
  if length(trim(p_data->>'work_done')) not between 10 and 1000 or p_data->>'confirmed'<>'true' then raise exception 'Reporte incompleto'; end if;
  select count(*) into n from evidence_uploads where assignment_id=a.id and verified and id in(select (value->>'id')::uuid from jsonb_array_elements(p_data->'evidence'));
  if n<>jsonb_array_length(p_data->'evidence') or n not between 2 and 10 then raise exception 'Evidencias inválidas o duplicadas'; end if;
  if not exists(select 1 from evidence_uploads where assignment_id=a.id and kind='before' and verified and id in(select(value->>'id')::uuid from jsonb_array_elements(p_data->'evidence'))) or not exists(select 1 from evidence_uploads where assignment_id=a.id and kind='after' and verified and id in(select(value->>'id')::uuid from jsonb_array_elements(p_data->'evidence'))) then raise exception 'Falta una foto antes y una después'; end if;
  insert into service_reports(assignment_id,work_done,materials,observations) values(a.id,p_data->>'work_done',coalesce(p_data->>'materials',''),coalesce(p_data->>'observations','')) returning id into rid;
  insert into service_evidence(report_id,upload_id,kind,storage_path,mime_type,size_bytes) select rid,id,kind,verified_path,mime_type,size_bytes from evidence_uploads where assignment_id=a.id and id in(select(value->>'id')::uuid from jsonb_array_elements(p_data->'evidence'));
  update service_orders set status='REPORT_SUBMITTED' where id=o.id;
  update service_assignments set status='REPORT_SUBMITTED' where id=a.id;
 elsif p_action<>'get' then raise exception 'Acción desconocida'; end if;
 if p_action<>'get' then insert into service_events(service_order_id,actor_type,actor_id,event_type) values(o.id,'PROVIDER',a.provider_id,p_action); end if;
 select * into o from service_orders where id=o.id;
 result=jsonb_build_object('folio',o.folio,'status',o.status,'serviceType',(select name from service_types where id=o.service_type_id),'description',o.description,'zone',o.zone,'scheduledAt',o.scheduled_at,'providerPayout',a.provider_payout,'currency','MXN');
 if o.status in ('ACCEPTED','IN_ROUTE','IN_PROGRESS') then result=result||jsonb_build_object('address',o.address); end if;
 return result;
end $$;
revoke all on function public.ops_action(uuid,text,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.partner_action(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.ops_action(uuid,text,uuid,jsonb) to service_role;
grant execute on function public.partner_action(text,text,jsonb) to service_role;
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
insert into schema_versions(version) values('001-mvp'),('002-clerk-auth') on conflict do nothing;
commit;

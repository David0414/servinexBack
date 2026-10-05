# Operación y despliegue

## Alta y baja del equipo desde OPS

Ejecuta una vez `supabase/04-equipo.sql` en el SQL Editor. Desde el panel, un administrador abre **Equipo → Agregar persona** y elige nombre, correo, contraseña inicial y rol. La plataforma crea la cuenta en Clerk y el perfil autorizado en Supabase. No requiere usar los dashboards para cada persona ni configurar webhooks. Para cuentas existentes, selecciona **Usar cuenta existente** con un correo verificado de la misma aplicación de Clerk.

La persona entra por `/login` con su correo y contraseña; comparte el enlace que muestra el panel y la contraseña inicial. No se envía automáticamente un correo de bienvenida. La recuperación de contraseña se gestiona con Clerk desde el formulario de acceso. No se almacenan contraseñas en Supabase ni se devuelve la contraseña en la respuesta de la API.

En **Editar acceso**, cambia nombre, permisos o estado activo. No se borran cuentas ni historial. La API comprueba el estado y el rol en cada petición; una sesión abierta no conserva los permisos anteriores. Los cambios se serializan y auditan en PostgreSQL. Un administrador no puede darse de baja ni quitarse su propio rol. Solo otro administrador puede cambiar ese acceso.

Las altas pueden reintentarse con el mismo formulario ante una falla de base de datos sin duplicar cuentas. Si se cerró el formulario después de que Clerk creó la cuenta pero antes de habilitar permisos, recupera el alta con **Usar cuenta existente**. Una cuenta sin perfil activo sigue sin acceso.

### Recuperación manual excepcional

Primero crea o invita al usuario desde **Clerk Dashboard > Users** y copia su User ID (`user_...`); después pega este SQL con el ID real:

```sql
insert into public.staff_profiles(clerk_user_id,name,role,active)
values('user_ID_REAL_DE_CLERK','Nombre del operador','OPS',true)
on conflict(clerk_user_id) do update set name=excluded.name,role=excluded.role,active=true;
```

Usa `ADMIN` únicamente para quienes controlan configuración y finanzas. Para baja inmediata:

```sql
update public.staff_profiles set active=false
where clerk_user_id='user_ID_REAL_DE_CLERK';
```

Estos comandos quedan como recuperación excepcional. Las altas cotidianas se realizan desde **Equipo**. No se conceden permisos por registro público ni por metadata del navegador.

### Migración de la versión anterior

Ejecuta `supabase/03-clerk-auth.sql` antes de desplegar la API nueva. Conserva todos los UUIDs y registros. Crea las cuentas del equipo en Clerk y vincula cada perfil existente:

```sql
select id,name,role,active,clerk_user_id from public.staff_profiles;
update public.staff_profiles set clerk_user_id='user_ID_REAL_DE_CLERK'
where id='UUID_DEL_PERFIL_EXISTENTE';
```

No crees otro perfil si quieres conservar referencias de órdenes y auditoría. La columna anterior `auth_user_id` queda como referencia histórica opcional, sin dependencia de `auth.users`; la API ya no la utiliza. Verifica cada usuario antes del cambio de frontend/API. Las cuentas y contraseñas de Supabase Auth no se importan automáticamente a Clerk. Mantén las claves y métodos de recuperación bajo control de Servinex.

## Despliegue y aceptación real

1. Configura Clerk y el proyecto Supabase y aplica los dos archivos SQL de instalación y administrador desde su editor.
2. Prueba en staging; luego despliega API en Railway y web en Vercel con las variables descritas en README.
3. Configura HTTPS y DNS; las ligas deben apuntar al dominio de web y su API debe responder en `/health`.
4. Prueba el circuito crear → asignar → WhatsApp → aceptar → ejecutar → evidencia → aprobar → pagar con datos de prueba. Abre Partner Link desde un teléfono, no solo desde la computadora.
5. Verifica Chrome Android y Safari iPhone con cámara real. HEIC no está admitido: usa fotos JPEG/PNG/WebP o la cámara del navegador.
6. Desde un cliente Supabase anónimo, intenta leer `customers` y `service_orders`: debe rechazarse. Confirma que `service-evidence` no es público y que la liga revocada deja de mostrar dirección.
7. Comprueba logs de Railway, no registra rutas/tokens ni payloads comerciales. No conectes herramientas de analítica que capturen `/p/:token`.
8. Conserva el control de repositorio, DNS y cuentas de hosting en Servinex. Revisa plan de backups y alertas.

No se incluyen dominios registrados, cuentas de hosting ni credenciales. Las pruebas locales no sustituyen la verificación de sesiones Clerk, Storage real y dispositivos. Falta publicar para cumplir el criterio de producción del PDF.

## Respaldo y recuperación

### Eliminar un servicio

Aplica `supabase/05-eliminar-servicios.sql` y luego `supabase/06-eliminar-pagos.sql` en Supabase → SQL Editor. Si ya aplicaste el 05, ejecuta solo el 06. Un administrador abre **Servicios → servicio → Eliminar servicio**, escribe el folio y confirma. OPS no ve el botón y la API y PostgreSQL rechazan sus solicitudes de eliminación.

El servicio deja de aparecer en el listado y el dashboard; sus ligas se revocan y sus asignaciones activas se desactivan. Se borran todos sus pagos de `provider_payments`, incluso los PAID y los ligados a asignaciones anteriores. Desaparecen de Pagos y de sus totales. Los reportes, fotos y estado original se conservan en la base de datos, junto con quién lo eliminó y cuándo. La auditoría guarda un snapshot de los pagos borrados; las consultas financieras no lo utilizan. La orden se elimina lógicamente y sus pagos se borran físicamente. No se borran archivos de Storage ni clientes/proveedores. No hay botón de restauración en esta versión.

La función SQL y su auditoría son atómicas. Si se pierde la respuesta, vuelve a confirmar el mismo folio: el reintento no duplica eventos. Para revisar eliminados con acceso administrativo, consulta `service_orders where deleted_at is not null` y `audit_logs where action in ('service_delete','service_payments_delete','service_payments_cleanup')`. Evita restaurar cambiando solo `deleted_at`: las asignaciones y enlaces ya se desactivaron y los pagos se borraron en la misma operación.

El 06 también limpia los pagos retenidos de órdenes eliminadas con la versión anterior, sin modificar los pagos de órdenes que siguen en la plataforma. Es reejecutable y solo añade auditoría cuando encuentra pagos pendientes de depurar. Los importes del dashboard ya excluyen órdenes eliminadas; después de aplicar la migración, recarga el panel para renovar la lista y los totales de Pagos.

Revisa en Supabase el alcance de backups/PITR del plan. Los backups PostgreSQL no contienen los archivos de Storage; respalda también objetos del bucket privado con acceso administrativo. Conserva SQL versionado y configuración de hosting sin secretos. Prueba restauración en un proyecto separado antes de depender del respaldo.

Si la API devuelve 500: revisa su estado y disponibilidad de Supabase, variables y versión instalada (`select * from public.schema_versions`). Los mensajes públicos no exponen errores internos. Después de rotar la clave backend, actualiza Railway y reinicia. Nunca copies la nueva clave al navegador.

Si se compartió una liga por error: genera una nueva en el detalle del servicio, o cancela el servicio cuando corresponda. La liga anterior se revoca de inmediato; los tickets de carga ya emitidos pueden sobrevivir hasta su vencimiento, pero no permiten leer datos ni modificar las evidencias archivadas.

Si el pago ya se realizó: antes de registrarlo confirma monto, proveedor y referencia. El sistema registra la transferencia; no mueve dinero. No permite marcar como pagado antes de la aprobación del reporte.

## Límites MVP y mantenimiento

- Reasignación disponible solo antes de aceptar; después de aceptación se cancela y se captura un nuevo servicio si hace falta.
- Un reporte enviado no se edita ni reabre desde UI en este MVP. Las aclaraciones se coordinan manualmente por WhatsApp y quedan por implementar como reapertura trazable.
- No se recopilan datos bancarios de proveedores: las transferencias se realizan fuera de la plataforma; solo se registra referencia y monto.
- Pagos y auditoría tienen límites explícitos de lectura (1,000 y 100). Ampliar con paginación cuando el volumen lo requiera.
- Las fotos reservadas y copias procesadas de intentos fallidos pueden quedar huérfanas. Programa limpieza de objetos sin referencia antes de crecer en volumen; nunca borres paths presentes en `service_evidence`.
- Rate limit en memoria y por IP de conexión. En Railway comprueba la dirección remota efectiva; antes de habilitar confianza en proxy configura exclusivamente sus saltos/IPs documentados. Múltiples instancias requieren almacén compartido.
- Se incluye un workflow de CI para GitHub, aún sin repositorio remoto ligado ni despliegue automático configurado en las cuentas del propietario. La configuración de compilación y hosting está incluida.

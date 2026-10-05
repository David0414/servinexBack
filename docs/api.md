# API MVP

Prefijo `/api/v1`. Respuestas JSON. Validación con Zod y errores `{ "message": "..." }`. OPS exige `Authorization: Bearer <Clerk session token>` más perfil activo vinculado mediante `clerk_user_id`. La API verifica firma, expiración, issuer, origen y que la sesión esté completa. Admin puede editar campos comerciales, administrar proveedores y marcar pagos. OPS puede capturar, asignar, cancelar, revisar y cerrar. Los importes visibles en OPS están permitidos para ambos roles; el proveedor nunca los recibe.

| Método       | Ruta                                                      | Función                                                                                  |
| ------------ | --------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| GET          | /me                                                       | Perfil del empleado                                                                      |
| GET          | /team?page=&search=                                       | Equipo: 25 perfiles por página y búsqueda por nombre/correo (ADMIN)                      |
| POST         | /team                                                     | `{name,email,role,password,account_mode,request_id}` crea/habilita una cuenta (ADMIN)    |
| PATCH        | /team/:id                                                 | `{name,role,active}` cambia permisos sin borrar historial (ADMIN)                        |
| GET          | /catalogs                                                 | Tipos de servicio                                                                        |
| GET          | /dashboard?from=&to=                                      | KPIs agregados del periodo                                                               |
| GET          | /services?page=&status=&search=&provider=&type=&from=&to= | 25 órdenes por página; search por folio, fechas ISO UTC                                  |
| POST         | /services                                                 | Cliente y servicio; folio automático                                                     |
| GET          | /services/:id                                             | Detalle, asignaciones, evidencias con URLs de 5 minutos y timeline                       |
| PATCH        | /services/:id                                             | Edición de campos operativos/comerciales (ADMIN)                                         |
| DELETE       | /services/:id                                             | `{folio}` confirma eliminación lógica; solo ADMIN activo, idempotente                    |
| POST         | /services/:id/assignments                                 | `{provider_id,provider_payout}`; reasignación solo antes de aceptación                   |
| POST         | /assignments/:id/access-link                              | Revoca liga previa y devuelve `{url,message,whatsappUrl}`                                |
| POST         | /services/:id/cancel                                      | Revoca accesos y cancela pagos pendientes                                                |
| GET          | /providers                                                | Proveedores, especialidades y métricas                                                   |
| POST / PATCH | /providers / /providers/:id                               | Crear/editar proveedor (ADMIN)                                                           |
| POST         | /reports/:id/approve                                      | Aprobar, cerrar y habilitar pago; idempotente                                            |
| GET          | /payments                                                 | Últimos 1,000 pagos (ADMIN)                                                              |
| POST         | /provider-payments                                        | `{assignment_id,payment_reference}` marca pago aprobado como pagado; idempotente (ADMIN) |
| GET          | /audit                                                    | Últimos 100 cambios (ADMIN)                                                              |

La generación de mensaje y de liga se combina en un endpoint para que el texto utilice la única credencial que se devuelve al generarla. El token no se recupera desde la base de datos. Cualquier generación nueva revoca la anterior.

Partner usa únicamente la credencial en `/partner/job/:token`; no acepta IDs libres de proveedor/orden. Sin caché, sin referrer. Límites por IP, 120 solicitudes/minuto por instancia; sin confiar en X-Forwarded-For arbitrario. Al escalar múltiples instancias se debe usar un almacén compartido de rate limit y configurar proxies confiables del hosting.

| Método | Sufijo   | Función                                                             |
| ------ | -------- | ------------------------------------------------------------------- |
| GET    | (vacío)  | Oferta mínima; dirección solo en ACCEPTED/IN_ROUTE/IN_PROGRESS      |
| POST   | /accept  | Aceptación idempotente                                              |
| POST   | /reject  | Rechazo y revocación                                                |
| POST   | /status  | `{status: "IN_ROUTE"                                                | "IN_PROGRESS"}`                               |
| POST   | /uploads | `{kind: "before"                                                    | "after"}`→`{id,signedUrl}` para PUT de imagen |
| POST   | /report  | `{work_done,materials,observations,confirmed:true,evidence:[{id}]}` |

Fotos: 1–5 por etapa, hasta 8 MB cada una. El servidor verifica que los IDs pertenezcan a esa asignación, descarga, decodifica y recodifica las fotos a WebP sin EXIF y con lado largo máximo de 1,800 px. Los reportes apuntan a copias privadas nuevas sin URL de carga, por lo que un ticket de carga anterior no puede modificar evidencia archivada. Antes y después son obligatorios. Repetir envío no duplica el reporte.

La regla SQL de una única asignación activa y los bloqueos por orden protegen carreras. Transiciones y auditoría se ejecutan en la misma transacción. Las funciones SQL operativas únicamente se conceden a `service_role`. No hay políticas anónimas ni autenticadas de lectura sobre datos de negocio.

`DELETE /services/:id` requiere `05-eliminar-servicios.sql` y `06-eliminar-pagos.sql`. La API toma el administrador del JWT verificado; no acepta IDs de administrador en el cuerpo. PostgreSQL vuelve a comprobar rol y estado activo dentro del bloqueo compartido con los cambios de permisos. Valida el folio, marca `deleted_at`/`deleted_by`, revoca todas las ligas, desactiva asignaciones activas y elimina todos los registros de `provider_payments` de sus asignaciones, incluidas las históricas y los pagos PAID, en una transacción con evento y auditoría. Conserva clientes, proveedores, reportes y fotos. Se permite en cualquier estado del servicio.

Los eliminados quedan fuera de listado, conteos y métricas del dashboard. Consultar su detalle devuelve 404 y las funciones operativas impiden editar, reasignar, aprobar, pagar o regenerar enlaces mediante sus IDs. Sus pagos desaparecen de `/payments` y de sus totales. La auditoría conserva un snapshot de los pagos borrados, sin incorporarlos a las consultas financieras. Un reintento con el mismo ID y folio devuelve `{id,folio,deleted_at}` sin repetir eventos ni auditoría; si quedaban pagos de una versión anterior, los elimina y audita como `service_payments_delete`. Un folio incorrecto devuelve 409 sin modificar datos; un permiso revocado devuelve 403.

La migración `06-eliminar-pagos.sql` limpia únicamente pagos ligados a órdenes con `deleted_at is not null`, registra `service_payments_cleanup` con snapshots y no duplica auditoría al reejecutarse. Conserva íntegros los pagos de otras órdenes.

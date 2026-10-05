# Servinex Back

API independiente de Fastify, Clerk y Supabase. Esta carpeta puede ser un repositorio GitHub propio. No necesita archivos ni dependencias de Front o de la carpeta superior.

## Ejecutar en su terminal

Requiere Node.js 22.16 o superior. En este equipo el arranque también puede usar el Node portátil de `.tools`, que no se sube a GitHub.

```powershell
cd D:\ServinexCore\Back
npm install
npm run dev
```

API: http://localhost:3000. Estado: http://localhost:3000/health. Esta terminal muestra únicamente los mensajes del backend. Cierra el servidor con Ctrl+C antes de iniciar otra instancia en el mismo puerto.

Tu `.env` local se conservó durante la separación. En un equipo nuevo, copia `.env.example` a `.env` y completa las credenciales:

```powershell
Copy-Item .env.example .env
```

- `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY`: proyecto Supabase y clave privada de backend.
- `CLERK_SECRET_KEY`: Secret Key (`sk_`) de la misma instancia que utiliza Front.
- `CLERK_ISSUER`: URL Frontend API de esa instancia, sin barra final.
- `CLERK_JWT_KEY`: PEM público opcional de la instancia para verificar firmas localmente. Actualízalo si rotas las claves o cambias de instancia. No uses la clave generada por `src/test-clerk.ts`.
- `CORS_ORIGINS`: orígenes exactos del panel, separados por comas. En desarrollo incluye `http://localhost:5173,http://127.0.0.1:5173`.
- `APP_BASE_URL`: dirección del frontend; se usa para generar las ligas de acceso.

El servidor vigila `src` y `.env`. Los errores de configuración indican el campo incorrecto sin imprimir sus valores.

## Base de datos

Los SQL están en [supabase](supabase). Se ejecutan copiando y pegando en Supabase → SQL Editor. No se usa Prisma ni Supabase CLI.

1. [01-instalacion.sql](supabase/01-instalacion.sql): instalación de tablas, funciones, RLS y Storage privado.
2. [02-primer-administrador.sql](supabase/02-primer-administrador.sql): vincular el primer administrador a su User ID de Clerk.
3. [03-clerk-auth.sql](supabase/03-clerk-auth.sql): migración para instalaciones anteriores con Supabase Auth.
4. [04-equipo.sql](supabase/04-equipo.sql): administración de cuentas y permisos desde Equipo.
5. [05-eliminar-servicios.sql](supabase/05-eliminar-servicios.sql): eliminación de servicios solo para administradores, revocación de enlaces y conservación del historial.
6. [06-eliminar-pagos.sql](supabase/06-eliminar-pagos.sql): elimina también pagos realizados y limpia los pagos que quedaron de servicios previamente eliminados.

La separación de carpetas no modifica la base de datos y no requiere repetir estos SQL. Clerk autentica a la persona; `staff_profiles` define si tiene acceso y su rol ADMIN/OPS. Proveedores y Partner Link conservan sus enlaces privados sin cuenta.

Para activar **Eliminar servicio**, aplica `05-eliminar-servicios.sql` y luego `06-eliminar-pagos.sql` antes de usar esta versión de Front y Back. Ambos son reejecutables. Si ya aplicaste el 05, solo necesitas el 06: este último también elimina los pagos retenidos de servicios que ya tienen `deleted_at`. Los pagos de servicios no eliminados se conservan.

Consulta [docs/runbook.md](docs/runbook.md) para administrar equipo, recuperación, respaldos y operación, y [docs/api.md](docs/api.md) para los contratos HTTP.

## Verificar y compilar

```powershell
npm run typecheck
npm test
npm run build
npm start
```

Las pruebas verifican tokens RSA, permisos HTTP, equipo y SQL con PGlite. `npm start` ejecuta `dist/server.js`; las credenciales de producción deben configurarse en el servicio de hosting.

## GitHub y Railway

La raíz del repositorio es esta carpeta. Incluye `package.json`, `package-lock.json`, `.nvmrc`, `.github/workflows/checks.yml` y `railway.json` propios. El workflow comprueba tipos, pruebas y build. Railway usa `npm run build`, `npm start` y `/health`.

En producción configura `NODE_ENV=production`, las credenciales, `APP_BASE_URL` y `CORS_ORIGINS` con el dominio HTTPS de Front. Railway proporciona `PORT`. El `.env`, `.tools`, `node_modules`, `dist` y archivos de log están excluidos de Git.

`src/shared.ts` contiene una copia de los contratos de validación. Cuando cambies un contrato HTTP, actualiza también la copia correspondiente de Front y verifica ambos repositorios.

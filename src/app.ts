import Fastify, { LogController } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z, ZodError } from "zod";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { staffAuthFailure, verifyStaffToken } from "./clerk-auth.js";
import { registerTeamRoutes, type TeamDirectory } from "./team.js";
import {
  assignmentSchema,
  serviceSchema,
  editServiceSchema,
  providerSchema,
  reportSchema,
  paymentSchema,
  uploadSchema,
  margin,
  statuses,
} from "./shared.js";
import { hashToken, newToken, whatsappMessage } from "./security.js";

const envSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  CLERK_SECRET_KEY: z
    .string()
    .regex(
      /^sk_(test|live)_/,
      "CLERK_SECRET_KEY necesita la Secret Key de Clerk (sk_test_ o sk_live_), no la Publishable Key (pk_).",
    ),
  CLERK_JWT_KEY: z.string().optional(),
  CLERK_ISSUER: z.string().url(),
  APP_BASE_URL: z.string().url(),
  CORS_ORIGINS: z.string().min(1),
  PARTNER_TOKEN_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(72),
  SERVINEX_WHATSAPP_NUMBER: z.string().regex(/^\d{8,15}$/),
});
export type Config = z.infer<typeof envSchema>;
type Staff = { id: string; name: string; role: "ADMIN" | "OPS" };
declare module "fastify" {
  interface FastifyRequest {
    staff: Staff;
  }
}
const fail = (message: string, code = 400) =>
  Object.assign(new Error(message), { statusCode: code });
export function configuration() {
  return envSchema.parse(process.env);
}
export async function buildApp(
  config: Config,
  client?: SupabaseClient,
  teamDirectory?: TeamDirectory,
) {
  const db =
    client ??
    createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  const app = Fastify({
    logger: {
      level: "info",
      redact: ["req.headers.authorization", "req.body", "req.url"],
    },
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 100 * 1024,
    trustProxy: false,
  });
  await app.register(cors, {
    origin: config.CORS_ORIGINS.split(",").map((v) => v.trim()),
    methods: ["GET", "HEAD", "POST", "PATCH", "DELETE", "OPTIONS"],
  });
  await app.register(helmet, { referrerPolicy: { policy: "no-referrer" } });
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  app.decorateRequest("staff");
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof ZodError)
      return reply
        .code(400)
        .send({ message: error.issues.map((v) => v.message).join(". ") });
    const err = error as Error & { statusCode?: number; expose?: boolean };
    const status = err.statusCode ?? 500;
    if (status >= 500)
      req.log.error(
        { errorType: err.name, requestId: req.id },
        "Error interno",
      );
    return reply.code(status).send({
      message:
        status >= 500 && !err.expose
          ? "No se pudo completar la operación. Intenta de nuevo."
          : err.message,
    });
  });
  app.get("/health", () => ({ status: "ok" }));
  async function checked<T>(
    promise: PromiseLike<{ data: T; error: { message: string } | null }>,
  ): Promise<NonNullable<T>> {
    const { data, error } = await promise;
    if (error || data == null)
      throw fail("No se pudo consultar la base de datos", 500);
    return data as NonNullable<T>;
  }
  async function rpc(name: string, args: Record<string, unknown>) {
    const { data, error } = await db.rpc(name, args);
    if (error) {
      if (error.code === "42501")
        throw fail("Se requiere acceso de administrador", 403);
      if (error.code === "P0002") throw fail("Servicio no encontrado", 404);
      if (["P0001", "23505", "23514", "23503"].includes(error.code))
        throw fail(
          error.code === "P0001"
            ? error.message
            : "La operación entra en conflicto con los datos actuales",
          409,
        );
      throw fail("Error al guardar la operación", 500);
    }
    return data;
  }
  const params = (v: unknown) => z.object({ id: z.string().uuid() }).parse(v);
  const tokenParams = (v: unknown) =>
    z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).parse(v);
  const opsAction = (
    staff: Staff,
    action: string,
    id: string | null,
    data: unknown = {},
  ) =>
    rpc("ops_action", {
      p_staff: staff.id,
      p_action: action,
      p_id: id,
      p_data: data,
    });
  const partnerAction = (token: string, action: string, data: unknown = {}) =>
    rpc("partner_action", {
      p_hash: hashToken(token),
      p_action: action,
      p_data: data,
    });
  async function staffAuth(req: import("fastify").FastifyRequest) {
    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (!token) throw fail("Inicia sesión para continuar", 401);
    let clerkUserId: string;
    try {
      clerkUserId = await verifyStaffToken(token, config);
    } catch (error) {
      const failure = staffAuthFailure(error);
      req.log.warn(
        { reason: failure.reason },
        "No se pudo validar la sesión Clerk",
      );
      throw Object.assign(fail(failure.message, failure.statusCode), {
        expose: true,
      });
    }
    const { data: profile, error: profileError } = await db
      .from("staff_profiles")
      .select("id,name,role")
      .eq("clerk_user_id", clerkUserId)
      .eq("active", true)
      .maybeSingle();
    if (profileError) {
      req.log.error(
        { databaseCode: profileError.code },
        "No se pudo consultar el perfil de acceso",
      );
      throw Object.assign(
        fail(
          "No se pudo comprobar el acceso porque la base de datos no respondió. Intenta de nuevo.",
          503,
        ),
        { expose: true },
      );
    }
    if (!profile) throw fail("Tu cuenta no tiene acceso a OPS", 403);
    req.staff = profile as Staff;
  }
  const admin = (staff: Staff) => {
    if (staff.role !== "ADMIN")
      throw fail("Se requiere acceso de administrador", 403);
  };
  await app.register(
    async (ops) => {
      ops.addHook("preHandler", staffAuth);
      ops.addHook("onResponse", async (req, reply) => {
        if (process.env.NODE_ENV === "development")
          req.log.info(
            { route: req.routeOptions.url, status: reply.statusCode },
            "Respuesta OPS",
          );
      });
      ops.addHook("onRequest", async (_req, reply) => {
        reply.header("Cache-Control", "no-store");
      });
      ops.get("/me", (req) => req.staff);
      registerTeamRoutes(ops, db, config, teamDirectory);
      ops.get("/catalogs", async () =>
        checked(
          db.from("service_types").select("*").eq("active", true).order("name"),
        ),
      );
      ops.get("/services", async (req) => {
        const q = z
          .object({
            page: z.coerce.number().int().min(1).default(1),
            status: z.enum(statuses).optional(),
            search: z.string().max(100).default(""),
            provider: z.string().uuid().optional(),
            type: z.string().uuid().optional(),
            from: z.string().datetime().optional(),
            to: z.string().datetime().optional(),
          })
          .parse(req.query);
        let query = db
          .from("service_orders")
          .select(
            "*,customers(name,phone),service_types(name),service_assignments(id,provider_id,provider_payout,status,active,providers(name))",
            { count: "exact" },
          )
          .is("deleted_at", null)
          .order("created_at", { ascending: false })
          .range((q.page - 1) * 25, q.page * 25 - 1);
        if (q.status) query = query.eq("status", q.status);
        if (q.type) query = query.eq("service_type_id", q.type);
        if (q.from) query = query.gte("created_at", q.from);
        if (q.to) query = query.lte("created_at", q.to);
        if (q.search)
          query = query.ilike("folio", `%${q.search.replace(/[%_]/g, "")}%`);
        if (q.provider) {
          const assignments = await checked(
            db
              .from("service_assignments")
              .select("service_order_id")
              .eq("provider_id", q.provider)
              .eq("active", true),
          );
          query = query.in(
            "id",
            assignments.map((a) => a.service_order_id),
          );
        }
        const { data, error, count } = await query;
        if (error) throw fail("No se pudieron cargar los servicios", 500);
        return {
          items: data?.map((o) => ({
            ...o,
            margin: margin(
              Number(o.customer_price),
              Number(
                o.service_assignments.find((a: { active: boolean }) => a.active)
                  ?.provider_payout ??
                  o.service_assignments.find(
                    (a: { status: string }) => a.status === "CLOSED",
                  )?.provider_payout ??
                  0,
              ),
              Number(o.additional_costs),
            ),
          })),
          total: count,
          page: q.page,
        };
      });
      ops.get("/dashboard", async (req) => {
        const q = z
          .object({
            from: z.string().datetime().optional(),
            to: z.string().datetime().optional(),
          })
          .parse(req.query);
        return rpc("ops_dashboard", {
          p_staff: req.staff.id,
          p_from: q.from ?? null,
          p_to: q.to ?? null,
        });
      });
      ops.post("/services", (req) =>
        opsAction(req.staff, "create", null, serviceSchema.parse(req.body)),
      );
      ops.get("/services/:id", async (req) => {
        const { id } = params(req.params);
        const { data: order, error } = await db
          .from("service_orders")
          .select(
            "*,customers(*),service_types(name),service_assignments(*,providers(name,phone),provider_payments(*),service_reports(*,service_evidence(*)))",
          )
          .eq("id", id)
          .is("deleted_at", null)
          .maybeSingle();
        if (error) throw fail("No se pudo consultar la base de datos", 500);
        if (!order) throw fail("Servicio no encontrado", 404);
        const events = await checked(
          db
            .from("service_events")
            .select("*")
            .eq("service_order_id", id)
            .order("created_at"),
        );
        for (const assignment of order.service_assignments) {
          // PostgREST devuelve objetos en relaciones 1:1 con UNIQUE.
          // La API expone arreglos uniformes para la UI y para asignaciones históricas.
          assignment.service_reports = assignment.service_reports
            ? Array.isArray(assignment.service_reports)
              ? assignment.service_reports
              : [assignment.service_reports]
            : [];
          assignment.provider_payments = assignment.provider_payments
            ? Array.isArray(assignment.provider_payments)
              ? assignment.provider_payments
              : [assignment.provider_payments]
            : [];
          for (const report of assignment.service_reports) {
            for (const photo of report.service_evidence) {
              const signed = await checked(
                db.storage
                  .from("service-evidence")
                  .createSignedUrl(photo.storage_path, 300),
              );
              photo.url = signed.signedUrl;
            }
          }
        }
        const current =
          order.service_assignments.find(
            (a: { active: boolean }) => a.active,
          ) ??
          order.service_assignments.sort(
            (a: { assigned_at: string }, b: { assigned_at: string }) =>
              b.assigned_at.localeCompare(a.assigned_at),
          )[0];
        return {
          ...order,
          events,
          margin: margin(
            Number(order.customer_price),
            Number(current?.provider_payout ?? 0),
            Number(order.additional_costs),
          ),
        };
      });
      ops.delete("/services/:id", (req) => {
        admin(req.staff);
        const { id } = params(req.params);
        const body = z
          .object({ folio: z.string().trim().min(1).max(50) })
          .strict()
          .parse(req.body);
        return rpc("service_delete", {
          p_staff: req.staff.id,
          p_id: id,
          p_folio: body.folio,
        });
      });
      ops.patch("/services/:id", (req) => {
        admin(req.staff);
        return opsAction(
          req.staff,
          "edit",
          params(req.params).id,
          editServiceSchema.parse(req.body),
        );
      });
      ops.post("/services/:id/assignments", (req) =>
        opsAction(
          req.staff,
          "assign",
          params(req.params).id,
          assignmentSchema.parse(req.body),
        ),
      );
      ops.post("/services/:id/cancel", (req) =>
        opsAction(req.staff, "cancel", params(req.params).id),
      );
      ops.post("/assignments/:id/access-link", async (req) => {
        const { id } = params(req.params);
        const token = newToken();
        await opsAction(req.staff, "link", id, {
          token_hash: hashToken(token),
          expires_at: new Date(
            Date.now() + config.PARTNER_TOKEN_TTL_HOURS * 3600000,
          ).toISOString(),
        });
        const assignment = await checked(
          db
            .from("service_assignments")
            .select(
              "provider_payout,providers(name,phone),service_orders(folio,description,zone,scheduled_at,service_types(name))",
            )
            .eq("id", id)
            .single(),
        );
        // La credencial solo se devuelve en esta respuesta; no se persiste en el navegador.
        const row = assignment as unknown as {
          provider_payout: number;
          providers: { name: string; phone: string };
          service_orders: {
            folio: string;
            description: string;
            zone: string;
            scheduled_at: string | null;
            service_types: { name: string };
          };
        };
        const url = `${config.APP_BASE_URL}/p/${token}`;
        const message = whatsappMessage(
          { ...row.service_orders, provider_payout: row.provider_payout },
          row.providers.name,
          url,
        );
        return {
          url,
          message,
          whatsappUrl: `https://wa.me/${row.providers.phone.replace(/\D/g, "")}?text=${encodeURIComponent(message)}`,
        };
      });
      ops.get("/providers", async () =>
        checked(
          db
            .from("providers")
            .select(
              "*,provider_service_types(service_type_id),service_assignments(id,status,accepted_at,assigned_at)",
            )
            .order("name"),
        ),
      );
      ops.post("/providers", (req) => {
        admin(req.staff);
        return opsAction(
          req.staff,
          "provider_save",
          null,
          providerSchema.parse(req.body),
        );
      });
      ops.patch("/providers/:id", (req) => {
        admin(req.staff);
        return opsAction(
          req.staff,
          "provider_save",
          params(req.params).id,
          providerSchema.parse(req.body),
        );
      });
      ops.post("/reports/:id/approve", (req) =>
        opsAction(req.staff, "approve", params(req.params).id),
      );
      ops.get("/payments", async (req) => {
        admin(req.staff);
        return checked(
          db
            .from("provider_payments")
            .select(
              "*,service_assignments(provider_id,providers(name),service_orders(folio,id,deleted_at))",
            )
            .order("created_at", { ascending: false })
            .limit(1000),
        );
      });
      ops.post("/provider-payments", (req) => {
        admin(req.staff);
        const body = paymentSchema.parse(req.body);
        return opsAction(req.staff, "pay", body.assignment_id, body);
      });
      ops.get("/audit", async (req) => {
        admin(req.staff);
        return checked(
          db
            .from("audit_logs")
            .select(
              "id,action,entity_type,entity_id,created_at,staff_profiles(name)",
            )
            .order("created_at", { ascending: false })
            .limit(100),
        );
      });
    },
    { prefix: "/api/v1" },
  );
  await app.register(
    async (partner) => {
      partner.addHook("onRequest", async (_req, reply) => {
        reply.header("Cache-Control", "no-store");
      });
      partner.get("/job/:token", async (req) => {
        const job = await partnerAction(tokenParams(req.params).token, "get");
        return { ...job, servinexContact: config.SERVINEX_WHATSAPP_NUMBER };
      });
      for (const action of ["accept", "reject"])
        partner.post(`/job/:token/${action}`, (req) =>
          partnerAction(tokenParams(req.params).token, action),
        );
      partner.post("/job/:token/status", (req) =>
        partnerAction(
          tokenParams(req.params).token,
          "status",
          z
            .object({ status: z.enum(["IN_ROUTE", "IN_PROGRESS"]) })
            .parse(req.body),
        ),
      );
      partner.post("/job/:token/uploads", async (req) => {
        const upload = await partnerAction(
          tokenParams(req.params).token,
          "upload",
          uploadSchema.parse(req.body),
        );
        const signed = await checked(
          db.storage
            .from("service-evidence")
            .createSignedUploadUrl(upload.storage_path),
        );
        return { id: upload.id, signedUrl: signed.signedUrl };
      });
      partner.post("/job/:token/report", async (req) => {
        const token = tokenParams(req.params).token;
        const body = reportSchema.parse(req.body);
        const job = await partnerAction(token, "get");
        if (job.status === "REPORT_SUBMITTED") return { status: job.status };
        if (job.status !== "IN_PROGRESS")
          throw fail("Primero inicia el servicio", 409);
        const credentials = await checked(
          db
            .from("assignment_access_tokens")
            .select("assignment_id")
            .eq("token_hash", hashToken(token))
            .single(),
        );
        const uploads = await checked(
          db
            .from("evidence_uploads")
            .select("*")
            .eq("assignment_id", credentials.assignment_id)
            .in(
              "id",
              body.evidence.map((e) => e.id),
            ),
        );
        if (uploads.length !== body.evidence.length)
          throw fail("Hay fotos inválidas o duplicadas");
        if (
          !uploads.some((u) => u.kind === "before") ||
          !uploads.some((u) => u.kind === "after") ||
          uploads.filter((u) => u.kind === "before").length > 5 ||
          uploads.filter((u) => u.kind === "after").length > 5
        )
          throw fail("Adjunta entre 1 y 5 fotos antes y después");
        for (const upload of uploads) {
          const { data, error } = await db.storage
            .from("service-evidence")
            .download(upload.storage_path);
          if (error || !data)
            throw fail("Una foto no terminó de subir. Vuelve a cargarla");
          if (data.size > 8388608) throw fail("La foto supera 8 MB");
          let image: Buffer;
          try {
            image = await sharp(Buffer.from(await data.arrayBuffer()), {
              limitInputPixels: 40000000,
            })
              .rotate()
              .resize(1800, 1800, { fit: "inside", withoutEnlargement: true })
              .webp({ quality: 80 })
              .toBuffer();
          } catch {
            throw fail("El archivo no es una imagen válida");
          }
          // La URL de carga nunca permite modificar la foto archivada del reporte.
          const verifiedPath = `${credentials.assignment_id}/verified/${randomUUID()}.webp`;
          const saved = await db.storage
            .from("service-evidence")
            .upload(verifiedPath, image, {
              upsert: false,
              contentType: "image/webp",
            });
          if (saved.error) throw fail("No se pudo procesar la evidencia", 500);
          await checked(
            db
              .from("evidence_uploads")
              .update({
                verified: true,
                verified_path: verifiedPath,
                mime_type: "image/webp",
                size_bytes: image.length,
              })
              .eq("id", upload.id)
              .select("id"),
          );
        }
        return partnerAction(token, "report", body);
      });
    },
    { prefix: "/api/v1/partner" },
  );
  return app;
}

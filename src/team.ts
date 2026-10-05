import { createClerkClient } from "@clerk/backend";
import type { FastifyInstance } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Config } from "./app.js";

type DirectoryUser = {
  id: string;
  externalId: string | null;
  primaryEmailAddressId?: string | null;
  emailAddresses: {
    id?: string;
    emailAddress: string;
    verification?: { status: string } | null;
  }[];
};
export interface TeamDirectory {
  getUserList(params: {
    emailAddress?: string[];
    userId?: string[];
    limit: number;
  }): Promise<{ data: DirectoryUser[] }>;
  createUser(params: {
    emailAddress: string[];
    password: string;
    externalId: string;
  }): Promise<DirectoryUser>;
}
// Solo estos mensajes redactados para el usuario se muestran ante errores externos.
const fail = (message: string, statusCode: number) =>
  Object.assign(new Error(message), { statusCode, expose: true });
const installation = () =>
  fail(
    "Para habilitar Equipo, ejecuta supabase/04-equipo.sql en el SQL Editor de Supabase.",
    503,
  );
const editable = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Escribe un nombre de al menos 2 caracteres")
    .max(100),
  role: z.enum(["ADMIN", "OPS"]),
});
const createSchema = editable
  .extend({
    email: z
      .string()
      .trim()
      .email("Escribe un correo válido")
      .max(254)
      .transform((s) => s.toLowerCase()),
    password: z
      .string()
      .min(8, "La contraseña debe tener al menos 8 caracteres")
      .max(128)
      .optional(),
    account_mode: z.enum(["new", "existing"]).default("new"),
    request_id: z.string().uuid(),
  })
  .superRefine((data, ctx) => {
    if (data.account_mode === "new" && !data.password)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["password"],
        message: "Escribe una contraseña inicial para la nueva cuenta",
      });
  });

function clerkFailure(error: unknown): never {
  const err = error as { status?: number; errors?: { code: string }[] };
  const codes = err.errors?.map((e) => e.code) ?? [];
  if (
    codes.some(
      (c) => c === "form_password_pwned" || c === "form_password_compromised",
    )
  )
    throw fail(
      "Esa contraseña aparece en una filtración. Elige una diferente.",
      400,
    );
  if (codes.some((c) => c.startsWith("form_password")))
    throw fail(
      "La contraseña no cumple los requisitos. Usa una contraseña más larga y difícil de adivinar.",
      400,
    );
  if (codes.includes("form_identifier_exists"))
    throw fail(
      "Ese correo ya tiene una cuenta. Selecciona «Usar cuenta existente».",
      409,
    );
  if (err.status === 422 || err.status === 400)
    throw fail(
      "No se pudo crear la cuenta. Revisa el correo y los requisitos de acceso configurados para tu equipo.",
      400,
    );
  throw fail(
    "El servicio de cuentas no está disponible. Intenta de nuevo en unos minutos.",
    503,
  );
}

export function registerTeamRoutes(
  ops: FastifyInstance,
  db: SupabaseClient,
  config: Config,
  directory: TeamDirectory = createClerkClient({
    secretKey: config.CLERK_SECRET_KEY,
  }).users,
) {
  const requireAdmin = (req: { staff: { role: string } }) => {
    if (req.staff.role !== "ADMIN")
      throw fail("Se requiere acceso de administrador", 403);
  };
  const checkDbError = (error: { code?: string } | null) => {
    if (!error) return;
    if (["42703", "PGRST204", "PGRST202"].includes(error.code ?? ""))
      throw installation();
    throw fail("No se pudo consultar el equipo", 503);
  };
  const save = async (
    staffId: string,
    id: string | null,
    data: Record<string, unknown>,
  ) => {
    const result = await db.rpc("team_save", {
      p_staff: staffId,
      p_id: id,
      p_data: data,
    });
    if (result.error?.code === "P0001") throw fail(result.error.message, 409);
    if (result.error?.code === "23505")
      throw fail("Esta cuenta o correo ya forma parte del equipo", 409);
    checkDbError(result.error);
    if (!result.data)
      throw fail("No se pudieron guardar los permisos. Intenta de nuevo.", 503);
    return result.data;
  };

  ops.get("/team", async (req) => {
    requireAdmin(req);
    const q = z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        search: z.string().trim().max(80).default(""),
      })
      .parse(req.query);
    let query = db
      .from("staff_profiles")
      .select("id,name,email,role,active,clerk_user_id,created_at", {
        count: "exact",
      })
      .order("created_at", { ascending: false })
      .range((q.page - 1) * 25, q.page * 25 - 1);
    const search = q.search.replace(/[,_%()\\"]/g, "");
    if (search)
      query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%`);
    const { data, error, count } = await query;
    checkDbError(error);
    const items = data ?? [];
    const legacyIds = items
      .filter((s) => !s.email && s.clerk_user_id)
      .map((s) => s.clerk_user_id);
    let directoryWarning = false;
    if (legacyIds.length) {
      try {
        const users = await directory.getUserList({
          userId: legacyIds,
          limit: 100,
        });
        for (const item of items) {
          const user = users.data.find((u) => u.id === item.clerk_user_id);
          if (!item.email && user)
            item.email =
              user.emailAddresses.find(
                (e) => e.id === user.primaryEmailAddressId,
              )?.emailAddress ??
              user.emailAddresses[0]?.emailAddress ??
              null;
        }
      } catch {
        directoryWarning = true;
      }
    }
    return { items, total: count ?? 0, page: q.page, directoryWarning };
  });

  ops.post(
    "/team",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      requireAdmin(req);
      const data = createSchema.parse(req.body);
      // Detecta la actualización pendiente ANTES de crear una cuenta externa.
      const readiness = await db
        .from("staff_profiles")
        .select("id,email")
        .limit(1);
      checkDbError(readiness.error);
      let user: DirectoryUser | undefined;
      const externalId = `servinex:${data.request_id}`;
      try {
        const result = await directory.getUserList({
          emailAddress: [data.email],
          limit: 10,
        });
        user = result.data.find((u) =>
          u.emailAddresses.some(
            (e) => e.emailAddress.toLowerCase() === data.email,
          ),
        );
        if (data.account_mode === "new") {
          if (user && user.externalId !== externalId)
            throw fail(
              "Ese correo ya tiene una cuenta. Selecciona «Usar cuenta existente» para habilitarla sin cambiar su contraseña.",
              409,
            );
          if (!user)
            user = await directory.createUser({
              emailAddress: [data.email],
              password: data.password!,
              externalId,
            });
        } else {
          if (!user)
            throw fail(
              "No existe una cuenta con ese correo. Selecciona «Crear cuenta nueva».",
              409,
            );
          if (
            !user.emailAddresses.some(
              (e) =>
                e.emailAddress.toLowerCase() === data.email &&
                e.verification?.status === "verified",
            )
          )
            throw fail(
              "La persona debe verificar ese correo antes de habilitar su cuenta existente.",
              409,
            );
        }
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode) throw error;
        clerkFailure(error);
      }
      // La misma solicitud puede reintentarse si Clerk respondió pero Supabase falló.
      // Nunca se cambia la contraseña ni se borra una cuenta existente durante un reintento.
      const member = await save(req.staff.id, null, {
        request_id: data.request_id,
        clerk_user_id: user!.id,
        name: data.name,
        email: data.email,
        role: data.role,
      });
      return reply.code(201).send({
        member,
        loginUrl: `${config.APP_BASE_URL.replace(/\/$/, "")}/login`,
      });
    },
  );

  ops.patch("/team/:id", async (req) => {
    requireAdmin(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const data = editable
      .extend({ active: z.boolean() })
      .strict()
      .parse(req.body);
    return save(req.staff.id, id, data);
  });
}

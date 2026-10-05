import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildApp } from "./app.js";
import type { TeamDirectory } from "./team.js";
import { clerkTestConfig, clerkTestToken } from "./test-clerk.js";

const config = {
  ...clerkTestConfig,
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-backend-key-not-real",
  APP_BASE_URL: "https://app.example.test",
  CORS_ORIGINS: "https://app.example.test",
  PARTNER_TOKEN_TTL_HOURS: 72,
  SERVINEX_WHATSAPP_NUMBER: "525512345678",
};
const headers = { authorization: `Bearer ${clerkTestToken()}` };
function fixture() {
  const state = {
    role: "ADMIN",
    dbError: null as null | { code: string; message: string },
    rpcError: null as null | { code: string; message: string },
    clerkError: null as unknown,
    created: 0,
    calls: [] as any[],
    users: [] as Awaited<ReturnType<TeamDirectory["getUserList"]>>["data"],
    members: [] as any[],
  };
  const client = {
    from: () => {
      const chain = {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        or() {
          return this;
        },
        order() {
          return this;
        },
        range() {
          return this;
        },
        limit: async () => ({ data: [], error: state.dbError }),
        maybeSingle: async () => ({
          data: { id: "admin-id", name: "Admin", role: state.role },
          error: null,
        }),
        then(resolve: (v: unknown) => unknown) {
          return Promise.resolve({
            data: state.members,
            count: state.members.length,
            error: state.dbError,
          }).then(resolve);
        },
      };
      return chain;
    },
    rpc: async (name: string, args: any) => {
      assert.equal(name, "team_save");
      assert.equal(args.p_staff, "admin-id");
      assert.ok(!JSON.stringify(args).includes("password"));
      state.calls.push(args);
      const data = {
        ...args.p_data,
        id: args.p_id ?? args.p_data.request_id,
        active: args.p_data.active ?? true,
      };
      return { data: state.rpcError ? null : data, error: state.rpcError };
    },
  } as unknown as SupabaseClient;
  const directory: TeamDirectory = {
    getUserList: async (params) => ({
      data: state.users.filter((u) =>
        params.emailAddress
          ? u.emailAddresses.some((e) =>
              params.emailAddress!.includes(e.emailAddress),
            )
          : params.userId!.includes(u.id),
      ),
    }),
    createUser: async (params) => {
      if (state.clerkError) throw state.clerkError;
      state.created++;
      const user = {
        id: "user_NewMember123",
        externalId: params.externalId,
        emailAddresses: [
          {
            emailAddress: params.emailAddress[0],
            verification: { status: "verified" },
          },
        ],
      };
      state.users.push(user);
      return user;
    },
  };
  return { state, client, directory };
}
const payload = () => ({
  request_id: randomUUID(),
  name: "Ana Operación",
  email: "ana@example.test",
  role: "OPS",
  password: "Test-only-random-password!83",
});

test("Equipo: únicamente ADMIN puede listar, crear o cambiar permisos", async () => {
  const { state, client, directory } = fixture();
  state.role = "OPS";
  const app = await buildApp(config, client, directory);
  try {
    for (const request of [
      { method: "GET" as const, url: "/api/v1/team" },
      { method: "POST" as const, url: "/api/v1/team", payload: payload() },
      {
        method: "PATCH" as const,
        url: `/api/v1/team/${randomUUID()}`,
        payload: { name: "Ana", role: "ADMIN", active: true },
      },
    ]) {
      assert.equal((await app.inject(request)).statusCode, 401);
      assert.equal((await app.inject({ ...request, headers })).statusCode, 403);
    }
    assert.equal(state.created, 0);
    assert.equal(state.calls.length, 0);
  } finally {
    await app.close();
  }
});

test("Equipo: alta real de flujo Clerk → permisos; reintento no duplica ni cambia contraseña", async () => {
  const { state, client, directory } = fixture();
  const app = await buildApp(config, client, directory);
  const body = payload();
  try {
    state.rpcError = { code: "08006", message: "private database failure" };
    const failed = await app.inject({
      method: "POST",
      url: "/api/v1/team",
      headers,
      payload: body,
    });
    assert.equal(failed.statusCode, 503);
    assert.ok(!failed.body.includes("private database"));
    assert.equal(state.created, 1);
    state.rpcError = null;
    const saved = await app.inject({
      method: "POST",
      url: "/api/v1/team",
      headers,
      payload: body,
    });
    assert.equal(saved.statusCode, 201);
    assert.equal(saved.json().member.clerk_user_id, "user_NewMember123");
    assert.equal(saved.json().member.role, "OPS");
    assert.equal(saved.json().loginUrl, "https://app.example.test/login");
    assert.equal(saved.headers["cache-control"], "no-store");
    assert.ok(!saved.body.includes(body.password));
    assert.equal(state.created, 1);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/team",
          headers,
          payload: payload(),
        })
      ).statusCode,
      409,
    );
    assert.equal(state.created, 1);
  } finally {
    await app.close();
  }
});

test("Equipo: valida contraseña y migración antes del alta; comunica bloqueo de Clerk", async () => {
  const { state, client, directory } = fixture();
  const app = await buildApp(config, client, directory);
  try {
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/team",
          headers,
          payload: { ...payload(), password: "short" },
        })
      ).statusCode,
      400,
    );
    state.dbError = { code: "42703", message: "email missing" };
    const notReady = await app.inject({
      method: "POST",
      url: "/api/v1/team",
      headers,
      payload: payload(),
    });
    assert.equal(notReady.statusCode, 503);
    assert.match(notReady.json().message, /04-equipo.sql/);
    assert.equal(state.created, 0);
    state.dbError = null;
    state.clerkError = {
      status: 422,
      errors: [{ code: "form_password_pwned" }],
    };
    const blocked = await app.inject({
      method: "POST",
      url: "/api/v1/team",
      headers,
      payload: payload(),
    });
    assert.equal(blocked.statusCode, 400);
    assert.match(blocked.json().message, /filtración/);
    assert.equal(state.calls.length, 0);
  } finally {
    await app.close();
  }
});

test("Equipo: habilita cuentas existentes solo con correo verificado y nunca cambia su contraseña", async () => {
  const { state, client, directory } = fixture();
  state.users.push({
    id: "user_Existing123",
    externalId: null,
    emailAddresses: [
      {
        emailAddress: "ana@example.test",
        verification: { status: "unverified" },
      },
    ],
  });
  const app = await buildApp(config, client, directory);
  const { password, ...data } = payload();
  try {
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/team",
          headers,
          payload: { ...data, account_mode: "existing" },
        })
      ).statusCode,
      409,
    );
    state.users[0].emailAddresses[0].verification!.status = "verified";
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/team",
          headers,
          payload: { ...data, account_mode: "existing" },
        })
      ).statusCode,
      201,
    );
    assert.equal(state.created, 0);
    assert.equal(state.calls[0].p_data.clerk_user_id, "user_Existing123");
    state.rpcError = {
      code: "P0001",
      message: "No puedes desactivar tu propia cuenta",
    };
    const edit = await app.inject({
      method: "PATCH",
      url: `/api/v1/team/${randomUUID()}`,
      headers,
      payload: { name: "Admin", role: "OPS", active: false },
    });
    assert.equal(edit.statusCode, 409);
    assert.match(edit.json().message, /propia cuenta/);
  } finally {
    await app.close();
  }
});

test("Equipo: lista perfiles históricos y consulta únicamente sus correos en Clerk", async () => {
  const { state, client, directory } = fixture();
  state.members.push({
    id: randomUUID(),
    clerk_user_id: "user_Legacy123",
    name: "Admin",
    email: null,
    role: "ADMIN",
    active: true,
  });
  state.users.push({
    id: "user_Legacy123",
    externalId: null,
    primaryEmailAddressId: "primary",
    emailAddresses: [{ id: "primary", emailAddress: "admin@example.test" }],
  });
  const app = await buildApp(config, client, directory);
  try {
    const response = await app.inject({ url: "/api/v1/team", headers });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().items[0].email, "admin@example.test");
    assert.equal(response.headers["cache-control"], "no-store");
  } finally {
    await app.close();
  }
});

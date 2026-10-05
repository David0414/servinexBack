import { test } from "node:test";
import assert from "node:assert/strict";
import { type SupabaseClient } from "@supabase/supabase-js";
import { buildApp } from "./app.js";
import { clerkTestConfig, clerkTestToken } from "./test-clerk.js";
import { staffAuthFailure, verifyStaffToken } from "./clerk-auth.js";
const config = {
  ...clerkTestConfig,
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-backend-key-not-real",
  APP_BASE_URL: "https://app.example.test",
  CORS_ORIGINS: "https://app.example.test",
  PARTNER_TOKEN_TTL_HOURS: 72,
  SERVINEX_WHATSAPP_NUMBER: "525512345678",
};
test("Un fallo de base de datos devuelve 503 sin invalidar la sesión ni exponer detalles", async () => {
  const client = {
    from: () => ({
      select() {
        return this;
      },
      eq() {
        return this;
      },
      maybeSingle: async () => ({
        data: null,
        error: { code: "PGRST000", message: "sensitive database details" },
      }),
    }),
  } as unknown as SupabaseClient;
  const app = await buildApp(config, client);
  try {
    const response = await app.inject({
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${clerkTestToken()}` },
    });
    assert.equal(response.statusCode, 503);
    assert.ok(response.json().message.includes("base de datos"));
    assert.ok(!response.body.includes("sensitive database details"));
  } finally {
    await app.close();
  }
});

test("Clerk: small clock drift and local origins are accepted", async () => {
  const localConfig = {
    ...config,
    CORS_ORIGINS: "http://localhost:5173,http://127.0.0.1:5173",
  };
  const now = Math.floor(Date.now() / 1000);
  for (const azp of localConfig.CORS_ORIGINS.split(",")) {
    assert.equal(
      await verifyStaffToken(
        clerkTestToken({ azp, iat: now + 2, nbf: now + 2 }),
        localConfig,
      ),
      "user_TestStaff123",
    );
  }
  await assert.rejects(() =>
    verifyStaffToken(clerkTestToken({ iat: now + 60 }), localConfig),
  );
});

test("Clerk: verification service failures are distinct from invalid sessions", () => {
  for (const reason of [
    "secret-key-invalid",
    "jwk-kid-mismatch",
    "jwk-remote-failed-to-load",
  ]) {
    const failure = staffAuthFailure({
      reason,
      message: "sensitive SDK details",
    });
    assert.equal(failure.statusCode, 503);
    assert.equal(failure.reason, reason);
    assert.ok(!failure.message.includes("sensitive SDK details"));
  }
  assert.equal(staffAuthFailure({ reason: "token-expired" }).statusCode, 401);
  assert.equal(
    staffAuthFailure(new Error("sensitive")).reason,
    "invalid-session",
  );
  assert.equal(staffAuthFailure({ reason: "__proto__" }).statusCode, 401);
  assert.equal(staffAuthFailure({ cause: { code: "EACCES" } }).statusCode, 503);
  assert.equal(
    staffAuthFailure({ reason: "token-invalid-signature" }).reason,
    "token-invalid-signature",
  );
});

test("OPS: auth errors identify the cause without exposing the token", async () => {
  const app = await buildApp(config, {} as SupabaseClient);
  try {
    for (const claims of [
      { exp: 1 },
      { azp: "https://foreign.example.test" },
      { iss: "https://another.clerk.accounts.dev" },
      { sts: "pending" },
    ]) {
      const token = clerkTestToken(claims);
      let failure;
      try {
        await verifyStaffToken(token, config);
        assert.fail("Invalid session was accepted");
      } catch (error) {
        failure = staffAuthFailure(error);
      }
      const response = await app.inject({
        url: "/api/v1/me",
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(response.statusCode, 401);
      assert.equal(response.json().message, failure.message);
      assert.ok(!response.body.includes(token));
    }
  } finally {
    await app.close();
  }
});

test("API: OPS exige JWT verificado; errores y Partner sin caché", async () => {
  const client = {
    rpc: async () => ({
      data: null,
      error: { code: "P0001", message: "Liga inválida o vencida" },
    }),
  } as unknown as SupabaseClient;
  const app = await buildApp(config, client);
  try {
    assert.equal((await app.inject({ url: "/health" })).statusCode, 200);
    assert.equal(
      (await app.inject({ url: "/api/v1/services" })).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/v1/services",
          headers: { authorization: "Bearer forged" },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (await app.inject({ url: "/api/v1/partner/job/invalid" })).statusCode,
      400,
    );
    const res = await app.inject({
      url: "/api/v1/partner/job/" + "a".repeat(43),
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.headers["cache-control"], "no-store");
    assert.ok(!res.body.includes("service_role"));
  } finally {
    await app.close();
  }
});
test("Detalle OPS normaliza relaciones 1:1 de PostgREST y firma fotos privadas", async () => {
  let role = "ADMIN";
  const orderId = "46fbf3d5-4c1a-4f78-ae90-c2e27d6d16cd";
  const client = {
    from: (table: string) => {
      const rows: Record<string, unknown> = {
        staff_profiles: { id: "staff-id", name: "Admin", role },
        service_orders: {
          id: orderId,
          customer_price: 1500,
          additional_costs: 50,
          service_assignments: [
            {
              id: "assignment-id",
              active: true,
              provider_payout: 650,
              assigned_at: new Date().toISOString(),
              service_reports: {
                id: "report-id",
                service_evidence: [{ storage_path: "private/photo.webp" }],
              },
              provider_payments: { id: "payment-id", status: "PENDING" },
            },
          ],
        },
        service_events: [],
      };
      const chain = {
        select() {
          return this;
        },
        eq(column: string, value: unknown) {
          if (table === "staff_profiles" && column === "clerk_user_id")
            assert.equal(value, "user_TestStaff123");
          return this;
        },
        is(column: string, value: unknown) {
          assert.equal(column, "deleted_at");
          assert.equal(value, null);
          return this;
        },
        maybeSingle: async () => ({ data: rows[table], error: null }),
        order: async () => ({ data: rows[table], error: null }),
      };
      return chain;
    },
    storage: {
      from: () => ({
        createSignedUrl: async () => ({
          data: { signedUrl: "https://private.example.test/signed" },
          error: null,
        }),
      }),
    },
  } as unknown as SupabaseClient;
  const app = await buildApp(config, client);
  try {
    const response = await app.inject({
      url: `/api/v1/services/${orderId}`,
      headers: { authorization: `Bearer ${clerkTestToken()}` },
    });
    assert.equal(response.statusCode, 200);
    const data = response.json();
    assert.equal(data.margin, 800);
    assert.equal(data.service_assignments[0].service_reports.length, 1);
    assert.equal(data.service_assignments[0].provider_payments.length, 1);
    assert.equal(
      data.service_assignments[0].service_reports[0].service_evidence[0].url,
      "https://private.example.test/signed",
    );
    assert.equal(response.headers["cache-control"], "no-store");
    role = "OPS";
    assert.equal(
      (
        await app.inject({
          url: "/api/v1/payments",
          headers: { authorization: `Bearer ${clerkTestToken()}` },
        })
      ).statusCode,
      403,
    );
  } finally {
    await app.close();
  }
});
test("Clerk verifica firma RSA, vencimiento, instancia, origen y sesión completa", async () => {
  assert.equal(
    await verifyStaffToken(clerkTestToken(), config),
    "user_TestStaff123",
  );
  for (const claims of [
    { exp: 1 },
    { nbf: Math.floor(Date.now() / 1000) + 3600 },
    { azp: "https://foreign.example.test" },
    { azp: undefined },
    { iss: "https://another.clerk.accounts.dev" },
    { sts: "pending" },
    { sid: undefined },
    { sub: "not-a-clerk-user" },
  ]) {
    await assert.rejects(() =>
      verifyStaffToken(clerkTestToken(claims), config),
    );
  }
  const token = clerkTestToken();
  await assert.rejects(() =>
    verifyStaffToken(`${token.slice(0, -10)}tamperedAA`, config),
  );
});
test("Una cuenta válida de Clerk sin perfil activo no accede a OPS", async () => {
  const client = {
    from: () => {
      const chain = {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        maybeSingle: async () => ({ data: null, error: null }),
      };
      return chain;
    },
  } as unknown as SupabaseClient;
  const app = await buildApp(config, client);
  try {
    const response = await app.inject({
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${clerkTestToken()}` },
    });
    assert.equal(response.statusCode, 403);
  } finally {
    await app.close();
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildApp } from "./app.js";
import { clerkTestConfig, clerkTestToken } from "./test-clerk.js";
import { hashToken, newToken } from "./security.js";
import { statuses } from "./shared.js";

const config = {
  ...clerkTestConfig,
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-backend-key-not-real",
  APP_BASE_URL: "https://app.example.test",
  CORS_ORIGINS: "https://app.example.test",
  PARTNER_TOKEN_TTL_HOURS: 72,
  SERVINEX_WHATSAPP_NUMBER: "525512345678",
};

test("Eliminar HTTP: solo ADMIN activo, confirmación validada y CORS DELETE", async () => {
  const staffId = randomUUID();
  const serviceId = randomUUID();
  let role = "OPS";
  let active = true;
  let rpcError: { code: string; message: string } | null = null;
  const calls: unknown[] = [];
  const client = {
    from: () => ({
      select() {
        return this;
      },
      eq() {
        return this;
      },
      maybeSingle: async () => ({
        data: active ? { id: staffId, name: "Admin", role } : null,
        error: null,
      }),
    }),
    rpc: async (name: string, args: unknown) => {
      assert.equal(name, "service_delete");
      calls.push(args);
      return {
        data: rpcError
          ? null
          : {
              id: serviceId,
              folio: "SVX-2026-000001",
              deleted_at: new Date().toISOString(),
            },
        error: rpcError,
      };
    },
  } as unknown as SupabaseClient;
  const app = await buildApp(config, client);
  const remove = (
    payload: Record<string, unknown> = { folio: "SVX-2026-000001" },
    authorization = `Bearer ${clerkTestToken()}`,
    id: string = serviceId,
  ) =>
    app.inject({
      method: "DELETE",
      url: `/api/v1/services/${id}`,
      headers: { authorization },
      payload,
    });
  try {
    assert.equal((await remove(undefined, "")).statusCode, 401);
    assert.equal((await remove()).statusCode, 403);
    role = "ADMIN";
    active = false;
    assert.equal((await remove()).statusCode, 403);
    active = true;
    for (const body of [
      {},
      { folio: "" },
      { folio: "x".repeat(51) },
      { folio: "SVX-2026-000001", p_staff: "forged" },
    ])
      assert.equal((await remove(body)).statusCode, 400);
    assert.equal(
      (await remove(undefined, undefined, "bad-id")).statusCode,
      400,
    );
    assert.equal(calls.length, 0);
    const preflight = await app.inject({
      method: "OPTIONS",
      url: `/api/v1/services/${serviceId}`,
      headers: {
        origin: config.APP_BASE_URL,
        "access-control-request-method": "DELETE",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    assert.equal(preflight.statusCode, 204);
    assert.equal(
      preflight.headers["access-control-allow-origin"],
      config.APP_BASE_URL,
    );
    assert.ok(
      String(preflight.headers["access-control-allow-methods"]).includes(
        "DELETE",
      ),
    );
    assert.equal(calls.length, 0);
    const result = await remove({ folio: " SVX-2026-000001 " });
    assert.equal(result.statusCode, 200);
    assert.equal(result.headers["cache-control"], "no-store");
    assert.deepEqual(calls[0], {
      p_staff: staffId,
      p_id: serviceId,
      p_folio: "SVX-2026-000001",
    });
    for (const [code, statusCode] of [
      ["42501", 403],
      ["P0002", 404],
      ["P0001", 409],
    ] as const) {
      rpcError = {
        code,
        message: "El folio de confirmación no coincide con el servicio",
      };
      assert.equal((await remove()).statusCode, statusCode);
    }
  } finally {
    await app.close();
  }
});

test("Servicios HTTP: listado y detalle excluyen eliminados; pagos exige ADMIN", async () => {
  const filters: unknown[] = [];
  const selects: string[] = [];
  const client = {
    from: (table: string) => {
      const chain = {
        select(columns: string) {
          selects.push(columns);
          return this;
        },
        eq() {
          return this;
        },
        is(column: string, value: unknown) {
          filters.push([table, column, value]);
          return this;
        },
        order() {
          return this;
        },
        range() {
          return this;
        },
        limit() {
          return this;
        },
        maybeSingle: async () => ({
          data:
            table === "staff_profiles"
              ? { id: randomUUID(), role: "ADMIN" }
              : null,
          error: null,
        }),
        then(resolve: (result: unknown) => unknown) {
          return Promise.resolve({ data: [], error: null, count: 0 }).then(
            resolve,
          );
        },
      };
      return chain;
    },
  } as unknown as SupabaseClient;
  const app = await buildApp(config, client);
  const headers = { authorization: `Bearer ${clerkTestToken()}` };
  try {
    const list = await app.inject({ url: "/api/v1/services", headers });
    assert.equal(list.statusCode, 200);
    assert.deepEqual(list.json().items, []);
    const missing = await app.inject({
      url: `/api/v1/services/${randomUUID()}`,
      headers,
    });
    assert.equal(missing.statusCode, 404);
    assert.deepEqual(filters, [
      ["service_orders", "deleted_at", null],
      ["service_orders", "deleted_at", null],
    ]);
    assert.equal(
      (await app.inject({ url: "/api/v1/payments", headers })).statusCode,
      200,
    );
    assert.ok(
      selects.some((value) =>
        value.includes("service_orders(folio,id,deleted_at)"),
      ),
    );
  } finally {
    await app.close();
  }
});

test("Eliminar SQL: migración, todos los estados, permisos, enlaces, pagos y reintentos", async () => {
  const db = new PGlite();
  try {
    await db.exec(
      "create role anon;create role authenticated;create role service_role bypassrls;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
    );
    const installation = readFileSync(
      new URL("../supabase/01-instalacion.sql", import.meta.url),
      "utf8",
    ).replace("create extension if not exists pgcrypto;", "");
    await db.exec(installation);
    // Reproduce una instalación anterior: la migración debe agregar las columnas.
    await db.exec(
      "alter table service_orders drop column deleted_at;alter table service_orders drop column deleted_by;",
    );
    const migration = readFileSync(
      new URL("../supabase/05-eliminar-servicios.sql", import.meta.url),
      "utf8",
    );
    await db.exec(migration);
    await db.exec(migration);
    const staff = (
      await db.query<{ id: string; role: string }>(
        "insert into staff_profiles(clerk_user_id,name,role) values('user_DeleteAdmin','Admin','ADMIN'),('user_DeleteOps','OPS','OPS') returning id,role",
      )
    ).rows;
    const admin = staff.find((s) => s.role === "ADMIN")!.id;
    const ops = staff.find((s) => s.role === "OPS")!.id;
    const type = (
      await db.query<{ id: string }>("select id from service_types limit 1")
    ).rows[0].id;
    await db.exec("set role service_role");
    const action = async (
      verb: string,
      id: string | null,
      data: unknown = {},
    ) =>
      (
        await db.query<{ r: any }>("select ops_action($1,$2,$3,$4::jsonb) r", [
          admin,
          verb,
          id,
          JSON.stringify(data),
        ])
      ).rows[0].r;
    const remove = async (id: string, folio: string | null, actor = admin) =>
      (
        await db.query<{ r: any }>("select service_delete($1,$2,$3) r", [
          actor,
          id,
          folio,
        ])
      ).rows[0].r;
    const provider = await action("provider_save", null, {
      name: "Proveedor",
      phone: "+525512345678",
      email: "",
      zones: "Centro",
      notes: "",
      status: "ACTIVE",
      service_type_ids: [type],
    });
    const create = () =>
      action("create", null, {
        customer_name: "Cliente",
        customer_phone: "+525587654321",
        service_type_id: type,
        description: "Reparar una fuga de agua",
        zone: "Centro",
        address: "Calle 100",
        customer_price: 1500,
        additional_costs: 50,
        scheduled_at: null,
      });
    const untouched = await create();
    const untouchedAssignment = (
      await action("assign", untouched.id, {
        provider_id: provider.id,
        provider_payout: 125,
      })
    ).assignment_id;
    await db.query("update service_orders set status='CLOSED' where id=$1", [
      untouched.id,
    ]);
    await db.query(
      "update service_assignments set active=false,status='CLOSED' where id=$1",
      [untouchedAssignment],
    );
    await db.query(
      "update provider_payments set status='PAID',paid_at=now(),payment_reference='OTRO-PAGO' where assignment_id=$1",
      [untouchedAssignment],
    );
    // Simula pagos conservados por la versión anterior de la eliminación.
    const legacyOrders: string[] = [];
    for (const state of ["CLOSED", "CANCELLED"]) {
      const legacy = await create();
      await action("assign", legacy.id, {
        provider_id: provider.id,
        provider_payout: 80,
      });
      const assignment = (
        await action("assign", legacy.id, {
          provider_id: provider.id,
          provider_payout: 650,
        })
      ).assignment_id;
      await db.query(
        "update service_orders set status=$2,deleted_at=now(),deleted_by=$3 where id=$1",
        [legacy.id, state, admin],
      );
      await db.query(
        "update service_assignments set active=false,status=$2 where service_order_id=$1",
        [legacy.id, state],
      );
      await db.query(
        "update provider_payments set status=$2 where assignment_id=$1",
        [assignment, state === "CLOSED" ? "PAID" : "CANCELLED"],
      );
      legacyOrders.push(legacy.id);
    }
    const paymentMigration = readFileSync(
      new URL("../supabase/06-eliminar-pagos.sql", import.meta.url),
      "utf8",
    );
    await db.exec("reset role");
    await db.exec(paymentMigration);
    await db.exec(paymentMigration);
    await db.exec("set role service_role");
    assert.equal(
      (
        await db.query<{ n: number }>(
          "select count(*)::int n from provider_payments",
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await db.query<{ n: number }>(
          "select count(*)::int n from audit_logs where action='service_payments_cleanup'",
        )
      ).rows[0].n,
      2,
    );
    for (const legacyId of legacyOrders) {
      const snapshot = (
        await db.query<{ before_json: any; after_json: any }>(
          "select before_json,after_json from audit_logs where action='service_payments_cleanup' and entity_id=$1",
          [legacyId],
        )
      ).rows[0];
      assert.equal(snapshot.before_json.provider_payments.length, 2);
      assert.deepEqual(snapshot.after_json.provider_payments, []);
    }
    await assert.rejects(
      () => remove(randomUUID(), "SVX-2026-000001"),
      /Servicio no encontrado/,
    );
    for (const status of statuses) {
      const order = await create();
      const assignment = (
        await action("assign", order.id, {
          provider_id: provider.id,
          provider_payout: 650,
        })
      ).assignment_id;
      const token = newToken();
      await action("link", assignment, {
        token_hash: hashToken(token),
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      });
      await db.query("update service_orders set status=$2 where id=$1", [
        order.id,
        status,
      ]);
      if (status === "CLOSED") {
        await db.query(
          "update service_assignments set active=false,status='CLOSED' where id=$1",
          [assignment],
        );
        await db.query(
          "update provider_payments set status='PAID',paid_at=now(),payment_reference='REAL-REF' where assignment_id=$1",
          [assignment],
        );
        const report = (
          await db.query<{ id: string }>(
            "insert into service_reports(assignment_id,work_done,review_status) values($1,'Trabajo terminado y verificado','APPROVED') returning id",
            [assignment],
          )
        ).rows[0].id;
        const upload = (
          await db.query<{ id: string }>(
            "insert into evidence_uploads(assignment_id,kind,storage_path,verified,verified_path) values($1,'before',$2,true,$2||'.verified') returning id",
            [assignment, `${order.id}/${assignment}/before/photo.webp`],
          )
        ).rows[0].id;
        await db.query(
          "insert into service_evidence(report_id,upload_id,kind,storage_path,mime_type,size_bytes) values($1,$2,'before',$3,'image/webp',100)",
          [report, upload, `${order.id}/verified.webp`],
        );
      }
      await assert.rejects(
        () => remove(order.id, order.folio, ops),
        /administrador/,
      );
      await db.query("update staff_profiles set active=false where id=$1", [
        admin,
      ]);
      await assert.rejects(
        () => remove(order.id, order.folio),
        /administrador/,
      );
      await db.query("update staff_profiles set active=true where id=$1", [
        admin,
      ]);
      await assert.rejects(
        () => remove(order.id, "OTRO-FOLIO"),
        /folio de confirmación/,
      );
      await assert.rejects(
        () => remove(order.id, null),
        /folio de confirmación/,
      );
      assert.equal(
        (
          await db.query<{ deleted_at: unknown }>(
            "select deleted_at from service_orders where id=$1",
            [order.id],
          )
        ).rows[0].deleted_at,
        null,
      );
      assert.equal(
        (
          await db.query<{ revoked_at: unknown }>(
            "select revoked_at from assignment_access_tokens where assignment_id=$1",
            [assignment],
          )
        ).rows[0].revoked_at,
        null,
      );
      const removed = await remove(order.id, order.folio);
      assert.ok(removed.deleted_at);
      assert.deepEqual(await remove(order.id, order.folio, admin), removed);
      const saved = (
        await db.query<{ deleted_by: string; status: string }>(
          "select deleted_by,status from service_orders where id=$1",
          [order.id],
        )
      ).rows[0];
      assert.equal(saved.deleted_by, admin);
      assert.equal(saved.status, status);
      assert.equal(
        (
          await db.query<{ active: boolean }>(
            "select active from service_assignments where id=$1",
            [assignment],
          )
        ).rows[0].active,
        false,
      );
      const payments = (
        await db.query<{ status: string; payment_reference: string }>(
          "select status,payment_reference from provider_payments where assignment_id=$1",
          [assignment],
        )
      ).rows;
      assert.deepEqual(payments, []);
      if (status === "CLOSED") {
        assert.equal(
          (
            await db.query<{ n: number }>(
              "select count(*)::int n from service_evidence",
            )
          ).rows[0].n,
          1,
        );
      }
      for (const verb of ["get", "accept", "status", "upload", "report"])
        await assert.rejects(
          () =>
            db.query("select partner_action($1,$2,'{}'::jsonb)", [
              hashToken(token),
              verb,
            ]),
          /inválida o vencida/,
        );
      for (const [verb, id] of [
        ["edit", order.id],
        ["assign", order.id],
        ["cancel", order.id],
        ["link", assignment],
        ["pay", assignment],
      ])
        await assert.rejects(() => action(verb, id), /Servicio no encontrado/);
      const audit = (
        await db.query<{ n: number; by: string }>(
          "select count(*)::int n,min(staff_id::text) as by from audit_logs where entity_id=$1 and action='service_delete'",
          [order.id],
        )
      ).rows[0];
      assert.equal(audit.n, 1);
      assert.equal(audit.by, admin);
      const snapshot = (
        await db.query<{ before_json: any; after_json: any }>(
          "select before_json,after_json from audit_logs where entity_id=$1 and action='service_delete'",
          [order.id],
        )
      ).rows[0];
      assert.equal(snapshot.before_json.provider_payments.length, 1);
      assert.equal(
        snapshot.before_json.provider_payments[0].status,
        status === "CLOSED" ? "PAID" : "PENDING",
      );
      assert.deepEqual(snapshot.after_json.provider_payments, []);
      assert.equal(
        (
          await db.query<{ n: number }>(
            "select count(*)::int n from service_events where service_order_id=$1 and event_type='delete'",
            [order.id],
          )
        ).rows[0].n,
        1,
      );
    }
    // Volver a instalar no permite operar sobre eliminados ni incluirlos en KPIs.
    await db.exec("reset role");
    await db.exec(installation);
    await db.exec("set role service_role");
    const dashboard = (
      await db.query<{ r: any }>("select ops_dashboard($1,null,null) r", [
        admin,
      ])
    ).rows[0].r;
    assert.equal(dashboard.total, 1);
    assert.equal(dashboard.revenue, 1500);
    assert.equal(dashboard.payout, 125);
    const paymentsLeft = (
      await db.query<{ amount: string; payment_reference: string }>(
        "select amount,payment_reference from provider_payments",
      )
    ).rows;
    assert.equal(paymentsLeft.length, 1);
    assert.equal(Number(paymentsLeft[0].amount), 125);
    assert.equal(paymentsLeft[0].payment_reference, "OTRO-PAGO");
    assert.equal(
      (
        await db.query<{ deleted_at: unknown }>(
          "select deleted_at from service_orders where id=$1",
          [untouched.id],
        )
      ).rows[0].deleted_at,
      null,
    );
    await db.query("update staff_profiles set role='OPS' where id=$1", [admin]);
    await assert.rejects(
      () => remove(untouched.id, untouched.folio),
      /administrador/,
    );
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`reset role;set role ${role}`);
      await assert.rejects(
        () => remove(untouched.id, untouched.folio),
        /permission denied/,
      );
    }
  } finally {
    await db.close();
  }
});

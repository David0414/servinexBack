import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { hashToken, newToken } from "./security.js";

test("Equipo SQL: permisos, auditoría, bajas, reintentos y protección del administrador", async () => {
  const db = new PGlite();
  try {
    await db.exec(
      "create role anon; create role authenticated; create role service_role bypassrls; create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
    );
    await db.exec(
      readFileSync(
        new URL("../supabase/01-instalacion.sql", import.meta.url),
        "utf8",
      ).replace("create extension if not exists pgcrypto;", ""),
    );
    const migration = readFileSync(
      new URL("../supabase/04-equipo.sql", import.meta.url),
      "utf8",
    );
    await db.exec(migration);
    await db.exec(migration);
    const owner = (
      await db.query<{ id: string }>(
        "insert into staff_profiles(clerk_user_id,name,role) values('user_Owner123','Owner','ADMIN') returning id",
      )
    ).rows[0].id;
    await db.exec("set role service_role");
    const save = async (id: string | null, data: object, actor = owner) =>
      (
        await db.query<{ result: any }>(
          "select team_save($1,$2,$3::jsonb) result",
          [actor, id, JSON.stringify(data)],
        )
      ).rows[0].result;
    const createData = {
      request_id: randomUUID(),
      clerk_user_id: "user_Operator123",
      name: "Ana",
      email: "ANA@example.test",
      role: "OPS",
    };
    const operator = await save(null, createData);
    assert.equal(operator.email, "ana@example.test");
    assert.equal(operator.id, createData.request_id);
    assert.equal(operator.active, true);
    assert.equal((await save(null, createData)).id, operator.id);
    assert.equal(
      (
        await db.query<{ n: number }>(
          "select count(*)::int n from audit_logs where action='team_create'",
        )
      ).rows[0].n,
      1,
    );
    await assert.rejects(
      () => save(null, { ...createData, request_id: randomUUID() }),
      /ya forma parte/,
    );
    await assert.rejects(
      () => save(owner, { name: "Owner", role: "OPS", active: true }),
      /propia cuenta/,
    );
    await assert.rejects(
      () => save(owner, { name: "Owner", role: "ADMIN", active: false }),
      /propia cuenta/,
    );
    await assert.rejects(
      () =>
        save(owner, { name: "Owner", role: "OPS", active: true }, operator.id),
      /administrador/,
    );
    await save(operator.id, { name: "Ana Nueva", role: "ADMIN", active: true });
    await save(operator.id, { name: "Ana Nueva", role: "OPS", active: false });
    await assert.rejects(
      () =>
        save(
          null,
          {
            ...createData,
            request_id: randomUUID(),
            clerk_user_id: "user_Another123",
            email: "another@example.test",
          },
          operator.id,
        ),
      /administrador/,
    );
    assert.equal(
      (
        await db.query<{ n: number }>(
          "select count(*)::int n from staff_profiles where active and role='ADMIN'",
        )
      ).rows[0].n,
      1,
    );
    const log = (
      await db.query<{ before_json: any; after_json: any }>(
        "select before_json,after_json from audit_logs where action='team_update' order by created_at desc limit 1",
      )
    ).rows[0];
    assert.equal(log.before_json.active, true);
    assert.equal(log.after_json.active, false);
    assert.equal(log.after_json.clerk_user_id, "user_Operator123");
    assert.ok(!("password" in log.after_json));
    await save(operator.id, { name: "Ana", role: "OPS", active: true });
    assert.equal(
      (
        await db.query<{ clerk_user_id: string }>(
          "select clerk_user_id from staff_profiles where id=$1",
          [operator.id],
        )
      ).rows[0].clerk_user_id,
      "user_Operator123",
    );
    await db.exec("set role anon");
    await assert.rejects(() => save(null, createData), /permission denied/);
    await assert.rejects(
      () => db.query("select * from staff_profiles"),
      /permission denied/,
    );
  } finally {
    await db.close();
  }
});

test("SQL real: flujo completo, privacidad, revocación, permisos y evidencia", async () => {
  const db = new PGlite();
  try {
    await db.exec(
      `create role anon; create role authenticated; create role service_role bypassrls; create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`,
    );
    const sql = readFileSync(
      new URL("../supabase/01-instalacion.sql", import.meta.url),
      "utf8",
    ).replace("create extension if not exists pgcrypto;", "");
    await db.exec(sql);
    await db.exec(sql); // Script reejecutable.
    const user = "user_TestAdmin123";
    const operatorUser = "user_TestOperator123";
    const staff = (
      await db.query<{ id: string }>(
        "insert into staff_profiles(clerk_user_id,name,role) values($1,'Admin','ADMIN') returning id",
        [user],
      )
    ).rows[0].id;
    const ops = (
      await db.query<{ id: string }>(
        "insert into staff_profiles(clerk_user_id,name,role) values($1,'Ops','OPS') returning id",
        [operatorUser],
      )
    ).rows[0].id;
    await db.exec("set role service_role");
    const action = async (
      verb: string,
      id: string | null,
      data: unknown = {},
      actor = staff,
    ) =>
      (
        await db.query<{ result: any }>(
          "select ops_action($1,$2,$3,$4::jsonb) result",
          [actor, verb, id, JSON.stringify(data)],
        )
      ).rows[0].result;
    const partner = async (token: string, verb: string, data: unknown = {}) =>
      (
        await db.query<{ result: any }>(
          "select partner_action($1,$2,$3::jsonb) result",
          [hashToken(token), verb, JSON.stringify(data)],
        )
      ).rows[0].result;
    const type = (
      await db.query<{ id: string }>("select id from service_types limit 1")
    ).rows[0].id;
    const provider = await action("provider_save", null, {
      name: "Carlos",
      phone: "+525512345678",
      email: "",
      zones: "Centro",
      notes: "",
      status: "ACTIVE",
      service_type_ids: [type],
    });
    const makeOrder = () =>
      action("create", null, {
        customer_name: "Cliente privado",
        customer_phone: "+525587654321",
        service_type_id: type,
        description: "Reparar fuga en lavabo",
        zone: "Centro",
        address: "Calle Privada 100",
        customer_price: 1500,
        additional_costs: 50,
        internal_notes: "Nota comercial confidencial",
        scheduled_at: null,
      });
    const o = await makeOrder();
    assert.match(o.folio, /^SVX-\d{4}-\d{6}$/);
    const assigned = await action("assign", o.id, {
      provider_id: provider.id,
      provider_payout: 650,
    });
    const assignment = assigned.assignment_id;
    let token = newToken();
    const makeLink = (
      value: string,
      expires = new Date(Date.now() + 3600000).toISOString(),
    ) =>
      action("link", assignment, {
        token_hash: hashToken(value),
        expires_at: expires,
      });
    await makeLink(token);
    const offer = await partner(token, "get");
    assert.equal(offer.status, "OFFER_SENT");
    assert.ok(!("address" in offer));
    for (const key of [
      "customer_price",
      "margin",
      "customer_phone",
      "internal_notes",
      "customers",
      "provider_id",
    ])
      assert.ok(!(key in offer));
    await assert.rejects(
      () => partner(token, "status", { status: "IN_PROGRESS" }),
      /no permitido/,
    );
    const original = token;
    token = newToken();
    await makeLink(token);
    await assert.rejects(() => partner(original, "get"), /inválida/);
    await partner(token, "accept");
    await partner(token, "accept");
    const accepted = await partner(token, "get");
    assert.equal(accepted.address, "Calle Privada 100");
    assert.equal(
      (
        await db.query<{ n: number }>(
          "select count(*)::int n from service_events where service_order_id=$1 and event_type='accept'",
          [o.id],
        )
      ).rows[0].n,
      1,
    );
    await assert.rejects(
      () =>
        action("assign", o.id, {
          provider_id: provider.id,
          provider_payout: 600,
        }),
      /No se puede/,
    );
    await partner(token, "status", { status: "IN_ROUTE" });
    await partner(token, "status", { status: "IN_PROGRESS" });
    await assert.rejects(
      () =>
        partner(token, "report", {
          work_done: "Fuga reparada correctamente",
          confirmed: true,
          evidence: [],
        }),
      /inválidas/,
    );
    const before = await partner(token, "upload", { kind: "before" });
    const after = await partner(token, "upload", { kind: "after" });
    await db.query(
      "update evidence_uploads set verified=true,verified_path=storage_path||'.verified',mime_type='image/webp',size_bytes=100 where id=any($1::uuid[])",
      [[before.id, after.id]],
    );
    const report = {
      work_done: "Fuga reparada correctamente",
      materials: "Sellador",
      observations: "",
      confirmed: true,
      evidence: [{ id: before.id }, { id: after.id }],
    };
    await partner(token, "report", report);
    await partner(token, "report", report);
    assert.equal(
      (
        await db.query<{ n: number }>(
          "select count(*)::int n from service_reports where assignment_id=$1",
          [assignment],
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await db.query<{ n: number }>(
          "select count(*)::int n from service_evidence",
        )
      ).rows[0].n,
      2,
    );
    const rid = (
      await db.query<{ id: string }>(
        "select id from service_reports where assignment_id=$1",
        [assignment],
      )
    ).rows[0].id;
    await assert.rejects(
      () => action("pay", assignment, { payment_reference: "TEST123" }),
      /Primero aprueba/,
    );
    await action("approve", rid);
    await action("approve", rid);
    await assert.rejects(() => partner(token, "get"), /inválida/);
    await assert.rejects(
      () => action("pay", assignment, { payment_reference: "TEST123" }, ops),
      /Solo un administrador/,
    );
    await action("pay", assignment, { payment_reference: "TEST123" });
    await action("pay", assignment, { payment_reference: "TEST123" });
    assert.equal(
      (
        await db.query<{ status: string }>(
          "select status from provider_payments where assignment_id=$1",
          [assignment],
        )
      ).rows[0].status,
      "PAID",
    );
    const dashboard = (
      await db.query<{ r: any }>("select ops_dashboard($1,null,null) r", [
        staff,
      ])
    ).rows[0].r;
    assert.equal(Number(dashboard.margin), 800);
    assert.equal(dashboard.closed, 1);
    await db.exec("set role anon");
    await assert.rejects(
      () => db.query("select * from customers"),
      /permission denied/,
    );
    await assert.rejects(() => partner(token, "get"), /permission denied/);
    await db.exec("reset role");
    const o2 = await makeOrder();
    const a2 = await action("assign", o2.id, {
      provider_id: provider.id,
      provider_payout: 500,
    });
    const t2 = newToken();
    await action("link", a2.assignment_id, {
      token_hash: hashToken(t2),
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    });
    await partner(t2, "reject");
    await assert.rejects(() => partner(t2, "get"), /inválida/);
    const reassigned = await action("assign", o2.id, {
      provider_id: provider.id,
      provider_payout: 550,
    });
    const t3 = newToken();
    await action("link", reassigned.assignment_id, {
      token_hash: hashToken(t3),
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    await assert.rejects(() => partner(t3, "get"), /inválida/);
    const t4 = newToken();
    await action("link", reassigned.assignment_id, {
      token_hash: hashToken(t4),
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    });
    await action("cancel", o2.id);
    await assert.rejects(() => partner(t4, "accept"), /inválida/);
  } finally {
    await db.close();
  }
});
test("Actualizar perfiles de Supabase Auth a Clerk conserva IDs, roles e historial", async () => {
  const db = new PGlite();
  try {
    await db.exec(
      `create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`,
    );
    const base = readFileSync(
      new URL("../supabase/01-instalacion.sql", import.meta.url),
      "utf8",
    ).replace("create extension if not exists pgcrypto;", "");
    const newProfile = base
      .split("\n")
      .find((line) =>
        line.startsWith("create table if not exists public.staff_profiles"),
      )!;
    const legacyProfile =
      "create table if not exists public.staff_profiles(id uuid primary key default gen_random_uuid(),auth_user_id uuid not null unique references auth.users(id),name text not null,role text not null check(role in('ADMIN','OPS')),active boolean not null default true,created_at timestamptz not null default now());";
    await db.exec(base.replace(newProfile, legacyProfile));
    const oldAuthId = randomUUID();
    await db.query("insert into auth.users(id) values($1)", [oldAuthId]);
    const profile = (
      await db.query<{ id: string }>(
        "insert into staff_profiles(auth_user_id,name,role) values($1,'Operador existente','OPS') returning id",
        [oldAuthId],
      )
    ).rows[0];
    const type = (
      await db.query<{ id: string }>("select id from service_types limit 1")
    ).rows[0].id;
    const order = (
      await db.query<{ r: any }>(
        "select ops_action($1,'create',null,$2::jsonb) r",
        [
          profile.id,
          JSON.stringify({
            customer_name: "Cliente previo",
            customer_phone: "+525512345678",
            service_type_id: type,
            description: "Trabajo pendiente de realizar",
            zone: "Centro",
            address: "Calle 123",
            customer_price: 1000,
            additional_costs: 0,
          }),
        ],
      )
    ).rows[0].r;
    const migration = readFileSync(
      new URL("../supabase/03-clerk-auth.sql", import.meta.url),
      "utf8",
    );
    await db.exec(migration);
    await db.exec(migration);
    const preserved = (
      await db.query<{
        id: string;
        role: string;
        clerk_user_id: string | null;
      }>("select id,role,clerk_user_id from staff_profiles where id=$1", [
        profile.id,
      ])
    ).rows[0];
    assert.equal(preserved.id, profile.id);
    assert.equal(preserved.role, "OPS");
    assert.equal(preserved.clerk_user_id, null);
    await db.query("update staff_profiles set clerk_user_id=$1 where id=$2", [
      "user_Migrated123",
      profile.id,
    ]);
    assert.equal(
      (
        await db.query<{ created_by: string }>(
          "select created_by from service_orders where id=$1",
          [order.id],
        )
      ).rows[0].created_by,
      profile.id,
    );
    await assert.rejects(
      () =>
        db.query(
          "insert into staff_profiles(clerk_user_id,name,role) values('user_Migrated123','Duplicado','ADMIN')",
        ),
      /unique/,
    );
    const adminScript = readFileSync(
      new URL("../supabase/02-primer-administrador.sql", import.meta.url),
      "utf8",
    );
    // El archivo puede tener el ID real del propietario: sustituir solo DECLARE.
    const withClerkId = (value: string) =>
      adminScript.replace(
        /clerk_id text := '[^']*';/,
        `clerk_id text := '${value}';`,
      );
    await assert.rejects(
      () => db.exec(withClerkId("user_REEMPLAZA_CON_EL_ID_DE_CLERK")),
      /reemplaza clerk_id/,
    );
    await db.exec(withClerkId(" user_NewAdmin123 "));
    await db.exec(withClerkId("user_NewAdmin123"));
    assert.equal(
      (
        await db.query<{ n: number }>(
          "select count(*)::int n from staff_profiles where clerk_user_id='user_NewAdmin123' and role='ADMIN'",
        )
      ).rows[0].n,
      1,
    );
  } finally {
    await db.close();
  }
});

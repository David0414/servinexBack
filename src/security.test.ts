import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canTransition,
  margin,
  reportSchema,
  serviceSchema,
} from "./shared.js";
import { hashToken, newToken, whatsappMessage } from "./security.js";
test("Tokens criptográficos: 32 bytes y solo SHA-256 persistido", () => {
  const a = newToken(),
    b = newToken();
  assert.equal(Buffer.from(a, "base64url").length, 32);
  assert.notEqual(a, b);
  assert.equal(hashToken(a).length, 64);
  assert.notEqual(hashToken(a), a);
  assert.equal(hashToken(a), hashToken(a));
});
test("Transiciones no permiten saltar la aceptación ni cerrar desde proveedor", () => {
  assert.equal(canTransition("OFFER_SENT", "ACCEPTED"), true);
  assert.equal(canTransition("NEW", "IN_PROGRESS"), false);
  assert.equal(canTransition("IN_ROUTE", "IN_PROGRESS"), true);
  assert.equal(canTransition("IN_PROGRESS", "CLOSED"), false);
});
test("Margen descuenta payout y costos con precisión monetaria", () => {
  assert.equal(margin(1600, 650, 100), 850);
  assert.equal(margin(0.3, 0.1, 0.1), 0.1);
});
test("Reporte requiere evidencia, confirmación y descripción", () => {
  assert.equal(
    reportSchema.safeParse({
      work_done: "Fuga reparada",
      evidence: [],
      confirmed: true,
    }).success,
    false,
  );
  assert.equal(
    reportSchema.safeParse({
      work_done: "ok",
      evidence: [{ id: "not-id" }],
      confirmed: false,
    }).success,
    false,
  );
});
test("Captura rechaza montos negativos y teléfono sin formato internacional", () => {
  assert.equal(
    serviceSchema.safeParse({ customer_price: -1, customer_phone: "555" })
      .success,
    false,
  );
});
test("WhatsApp solo usa la proyección operativa", () => {
  const message = whatsappMessage(
    {
      folio: "SVX-2026-000001",
      description: "Reparar fuga",
      zone: "Centro",
      scheduled_at: null,
      service_types: { name: "Plomería" },
      provider_payout: 650,
    },
    "Carlos",
    "https://app.servinex.mx/p/token",
  );
  assert.match(message, /650/);
  assert.match(message, /Lo antes posible/);
  assert.ok(!message.includes("customer_price"));
});

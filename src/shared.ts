import { z } from "zod";
export const statuses = [
  "NEW",
  "ASSIGNED",
  "OFFER_SENT",
  "ACCEPTED",
  "IN_ROUTE",
  "IN_PROGRESS",
  "REPORT_SUBMITTED",
  "CLOSED",
  "CANCELLED",
  "REJECTED",
] as const;
export const labels: Record<string, string> = {
  NEW: "Sin asignar",
  ASSIGNED: "Asignado",
  OFFER_SENT: "Oferta enviada",
  ACCEPTED: "Aceptado",
  IN_ROUTE: "En camino",
  IN_PROGRESS: "En servicio",
  REPORT_SUBMITTED: "Por revisar",
  CLOSED: "Cerrado",
  CANCELLED: "Cancelado",
  REJECTED: "Rechazado",
  PENDING: "Pendiente",
  APPROVED: "Aprobado",
  PAID: "Pagado",
};
const money = z.coerce.number().finite().min(0).max(10000000);
const phone = z
  .string()
  .regex(
    /^\+[1-9]\d{7,14}$/,
    "Usa formato internacional, por ejemplo +525512345678",
  );
export const serviceSchema = z.object({
  customer_name: z.string().trim().min(2).max(150),
  customer_phone: phone,
  service_type_id: z.string().uuid(),
  description: z.string().trim().min(10).max(1000),
  zone: z.string().trim().min(2).max(150),
  address: z.string().trim().min(5).max(500),
  scheduled_at: z.string().datetime().nullable(),
  customer_price: money,
  additional_costs: money.default(0),
  internal_notes: z.string().max(2000).default(""),
});
export const editServiceSchema = serviceSchema
  .pick({
    description: true,
    zone: true,
    address: true,
    scheduled_at: true,
    customer_price: true,
    additional_costs: true,
    internal_notes: true,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0);
export const providerSchema = z.object({
  name: z.string().trim().min(2).max(150),
  phone,
  email: z.union([z.string().email(), z.literal("")]).default(""),
  zones: z.string().max(500).default(""),
  notes: z.string().max(2000).default(""),
  status: z.enum(["ACTIVE", "INACTIVE"]).default("ACTIVE"),
  service_type_ids: z.array(z.string().uuid()).max(20).default([]),
});
export const assignmentSchema = z.object({
  provider_id: z.string().uuid(),
  provider_payout: money,
});
export const reportSchema = z.object({
  work_done: z.string().trim().min(10).max(1000),
  materials: z.string().max(1000).default(""),
  observations: z.string().max(1000).default(""),
  confirmed: z.literal(true),
  evidence: z
    .array(z.object({ id: z.string().uuid() }))
    .min(2)
    .max(10),
});
export const paymentSchema = z.object({
  assignment_id: z.string().uuid(),
  payment_reference: z.string().trim().min(3).max(150),
});
export const uploadSchema = z.object({ kind: z.enum(["before", "after"]) });
export function margin(price: number, payout: number, costs: number) {
  return Math.round((price - payout - costs) * 100) / 100;
}
export function canTransition(from: string, to: string) {
  return (
    (
      {
        OFFER_SENT: ["ACCEPTED", "REJECTED"],
        ACCEPTED: ["IN_ROUTE", "IN_PROGRESS"],
        IN_ROUTE: ["IN_PROGRESS"],
        IN_PROGRESS: ["REPORT_SUBMITTED"],
      } as Record<string, string[]>
    )[from]?.includes(to) ?? false
  );
}

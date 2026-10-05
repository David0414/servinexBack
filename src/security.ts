import { createHash, randomBytes } from "node:crypto";
export const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");
export function whatsappMessage(
  job: {
    folio: string;
    description: string;
    zone: string;
    scheduled_at: string | null;
    service_types: { name: string };
    provider_payout: number;
  },
  name: string,
  url: string,
) {
  return `SERVINEX | NUEVO SERVICIO\n\nHola, ${name}. Tienes un nuevo servicio disponible.\nFolio: ${job.folio}\nServicio: ${job.service_types.name} — ${job.description}\nZona: ${job.zone}\nFecha / hora: ${job.scheduled_at ? new Date(job.scheduled_at).toLocaleString("es-MX", { timeZone: "America/Mexico_City" }) : "Lo antes posible"}\nPago por servicio: ${Number(job.provider_payout).toLocaleString("es-MX", { style: "currency", currency: "MXN" })} MXN\n\nRevisa y acepta aquí:\n${url}\n\nDentro de la liga podrás aceptar, consultar los datos operativos y entregar tu evidencia al finalizar.\nPor seguridad, no compartas esta liga.`;
}

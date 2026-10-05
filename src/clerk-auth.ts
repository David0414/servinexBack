import { verifyToken } from "@clerk/backend";
import type { Config } from "./app.js";

const authFailures: Record<string, { statusCode: number; message: string }> = {
  "token-invalid": {
    statusCode: 401,
    message:
      "La credencial enviada no tiene el formato de una sesión Clerk. Cierra sesión e inicia sesión de nuevo.",
  },
  "token-invalid-signature": {
    statusCode: 401,
    message:
      "La firma de la sesión no coincide con la clave de Clerk configurada en la API. Contacta al administrador.",
  },
  "token-verification-failed": {
    statusCode: 401,
    message:
      "No se pudo comprobar la firma o los datos de la sesión Clerk. Contacta al administrador.",
  },
  "invalid-user-id": {
    statusCode: 401,
    message:
      "La sesión Clerk no incluye un usuario válido. Cierra sesión e inicia sesión de nuevo.",
  },
  "invalid-session-id": {
    statusCode: 401,
    message:
      "La credencial no corresponde a una sesión de Clerk. Cierra sesión e inicia sesión de nuevo.",
  },
  "token-expired": {
    statusCode: 401,
    message: "La sesión expiró. Cierra sesión e inicia sesión de nuevo.",
  },
  "token-not-active-yet": {
    statusCode: 401,
    message:
      "El reloj del servidor está desincronizado. Ajusta la fecha y hora e intenta de nuevo.",
  },
  "token-iat-in-the-future": {
    statusCode: 401,
    message:
      "El reloj del servidor está desincronizado. Ajusta la fecha y hora e intenta de nuevo.",
  },
  "token-invalid-authorized-parties": {
    statusCode: 401,
    message:
      "El origen del panel no está autorizado. Contacta al administrador.",
  },
  "issuer-mismatch": {
    statusCode: 401,
    message:
      "El panel y la API no usan la misma instancia de Clerk. Contacta al administrador.",
  },
  "session-pending": {
    statusCode: 401,
    message:
      "Tu sesión tiene pasos pendientes. Cierra sesión e inicia sesión de nuevo para completarlos.",
  },
  "secret-key-invalid": {
    statusCode: 503,
    message:
      "La API no tiene una clave válida de Clerk. Contacta al administrador.",
  },
  "jwk-kid-mismatch": {
    statusCode: 503,
    message:
      "Las claves del panel y la API no corresponden a la misma instancia de Clerk. Contacta al administrador.",
  },
};
for (const reason of [
  "jwk-local-missing",
  "jwk-remote-failed-to-load",
  "jwk-remote-invalid",
  "jwk-remote-missing",
  "jwk-failed-to-resolve",
]) {
  authFailures[reason] = {
    statusCode: 503,
    message:
      "La API no pudo obtener la clave de verificación de Clerk. Intenta de nuevo; si persiste, contacta al administrador.",
  };
}
export function staffAuthFailure(error: unknown) {
  const details = error as {
    reason?: unknown;
    cause?: { code?: unknown };
  } | null;
  const networkCodes = [
    "EACCES",
    "EPERM",
    "ENOTFOUND",
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "UND_ERR_CONNECT_TIMEOUT",
  ];
  const candidate =
    typeof details?.cause?.code === "string" &&
    networkCodes.includes(details.cause.code)
      ? "jwk-remote-failed-to-load"
      : details?.reason;
  const reason =
    typeof candidate === "string" && Object.hasOwn(authFailures, candidate)
      ? candidate
      : "invalid-session";
  return {
    reason,
    ...(authFailures[reason] ?? {
      statusCode: 401,
      message:
        "La sesión no es válida. Cierra sesión e inicia sesión de nuevo.",
    }),
  };
}

export async function verifyStaffToken(
  token: string,
  config: Config,
): Promise<string> {
  const origins = config.CORS_ORIGINS.split(",").map((v) => v.trim());
  const payload = await verifyToken(token, {
    secretKey: config.CLERK_SECRET_KEY,
    jwtKey: config.CLERK_JWT_KEY?.replace(/\\n/g, "\n"),
    authorizedParties: origins,
    clockSkewInMs: 5000,
  });
  // Los permisos se leen en staff_profiles, nunca en metadata del navegador.
  const reject = (reason: string): never => {
    throw Object.assign(new Error("Sesión Clerk no autorizada"), { reason });
  };
  if (payload.iss !== config.CLERK_ISSUER) reject("issuer-mismatch");
  if (!origins.includes(payload.azp ?? ""))
    reject("token-invalid-authorized-parties");
  if (payload.sts === "pending") reject("session-pending");
  if (!/^user_[A-Za-z0-9]+$/.test(payload.sub ?? "")) reject("invalid-user-id");
  if (!/^sess_[A-Za-z0-9]+$/.test(payload.sid ?? ""))
    reject("invalid-session-id");
  return payload.sub;
}

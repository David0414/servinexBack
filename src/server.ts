import { buildApp, configuration } from "./app.js";
import { ZodError } from "zod";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

try {
  // Se carga en el proceso de la API, no en el watcher: cada reinicio lee el archivo actual.
  if (existsSync(".env")) loadEnvFile(".env");
  const app = await buildApp(configuration());
  await app.listen({ port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, async () => {
      await app.close();
      process.exit(0);
    });
} catch (error) {
  if (error instanceof ZodError) {
    console.error("[API] No puede iniciar: revisa Back/.env.");
    for (const issue of error.issues) {
      const field = issue.path.join(".");
      console.error(
        `[API] ${field}: ${field === "CLERK_SECRET_KEY" ? "Copia la Secret Key de Clerk (sk_test_ o sk_live_). Una clave pk_ es pública y va en Front/.env." : "Falta el valor o su formato no es válido."}`,
      );
    }
    console.error(
      "[API] Guarda el archivo. Si el servidor no reinicia automáticamente, vuelve a ejecutar npm run dev.",
    );
  } else if ((error as { code?: string }).code === "EADDRINUSE") {
    console.error(
      "[API] El puerto está ocupado. Cierra la otra instancia de la API antes de iniciar esta.",
    );
  } else {
    console.error(
      "[API] No pudo iniciar. Revisa la configuración y que estés usando Node 22.16 o superior.",
    );
  }
  process.exitCode = 1;
}

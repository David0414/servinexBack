import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  symlinkSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

test(
  "Dev: el watcher vuelve a leer el .env al reiniciar la API",
  { timeout: 45000 },
  async () => {
    const root = fileURLToPath(new URL("../", import.meta.url));
    const fixture = mkdtempSync(join(tmpdir(), "servinex-back-dev-"));
    // El directorio temporal es el único objetivo de la limpieza recursiva.
    assert.ok(resolve(fixture).startsWith(resolve(tmpdir()) + sep));
    const freePort = () =>
      new Promise<number>((accept, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          const port =
            typeof address === "object" && address ? address.port : 0;
          server.close(() => accept(port));
        });
      });
    const firstPort = await freePort();
    const secondPort = await freePort();
    const environment = (port: number) =>
      [
        "NODE_ENV=development",
        `PORT=${port}`,
        "SUPABASE_URL=https://example.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY=test-backend-key-not-real",
        "CLERK_SECRET_KEY=sk_test_not_a_real_key",
        "CLERK_ISSUER=https://test-instance.clerk.accounts.dev",
        "APP_BASE_URL=http://localhost:5173",
        "CORS_ORIGINS=http://localhost:5173",
        "SERVINEX_WHATSAPP_NUMBER=525512345678",
      ].join("\n") + "\n";
    mkdirSync(join(fixture, "scripts"));
    for (const file of ["run.mjs", "runtime.mjs"])
      copyFileSync(join(root, "scripts", file), join(fixture, "scripts", file));
    for (const folder of ["src", "node_modules"])
      symlinkSync(
        join(root, folder),
        join(fixture, folder),
        process.platform === "win32" ? "junction" : "dir",
      );
    writeFileSync(join(fixture, ".env"), environment(firstPort));
    const env = { ...process.env };
    for (const variable of [
      "NODE_ENV",
      "PORT",
      "SUPABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
      "CLERK_SECRET_KEY",
      "CLERK_ISSUER",
      "CLERK_JWT_KEY",
      "APP_BASE_URL",
      "CORS_ORIGINS",
      "SERVINEX_WHATSAPP_NUMBER",
    ])
      delete env[variable];
    const child = spawn(process.execPath, ["scripts/run.mjs", "dev"], {
      cwd: fixture,
      env,
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    let childClosed = false;
    child.once("close", () => {
      childClosed = true;
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output = (output + chunk).slice(-4000);
    });
    child.stderr.on("data", (chunk) => {
      output = (output + chunk).slice(-4000);
    });
    const waitForHealth = async (port: number) => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/health`, {
            signal: AbortSignal.timeout(1000),
          });
          if (response.ok && (await response.json()).status === "ok") return;
        } catch {}
        await new Promise((accept) => setTimeout(accept, 200));
      }
      assert.fail(`API did not listen on the configured port: ${output}`);
    };
    try {
      await waitForHealth(firstPort);
      writeFileSync(join(fixture, ".env"), environment(secondPort));
      await waitForHealth(secondPort);
      await assert.rejects(() => fetch(`http://127.0.0.1:${firstPort}/health`));
    } finally {
      if (child.pid && child.exitCode === null) {
        if (process.platform === "win32")
          spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            windowsHide: true,
          });
        else process.kill(-child.pid, "SIGTERM");
      }
      // Procesa el cierre de handles antes de intentar quitar su directorio.
      if (!childClosed)
        await once(child, "close", { signal: AbortSignal.timeout(5000) });
      // Windows puede retener el directorio unos instantes tras taskkill.
      rmSync(fixture, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    }
  },
);

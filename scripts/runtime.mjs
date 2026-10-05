import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, delimiter, join } from "node:path";

export async function run(root, commands) {
  const supported = (version) => {
    const [major, minor] = version.replace(/^v/, "").split(".").map(Number);
    return major > 22 || (major === 22 && minor >= 16);
  };
  let runtime = process.execPath;
  if (!supported(process.version)) {
    const portable = join(
      root,
      ".tools",
      process.platform === "win32" ? "node.exe" : "node",
    );
    const version = existsSync(portable)
      ? spawnSync(portable, ["--version"], {
          encoding: "utf8",
          windowsHide: true,
        })
      : null;
    if (!version || version.status !== 0 || !supported(version.stdout.trim())) {
      console.error(
        "Instala Node.js 22.16 o superior y vuelve a ejecutar el comando.",
      );
      process.exitCode = 1;
      return;
    }
    runtime = portable;
    console.log("Usando el Node 22 local de esta carpeta.");
  }
  let child;
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => child?.kill(signal));
  for (const args of commands) {
    const code = await new Promise((resolve) => {
      child = spawn(runtime, args, {
        cwd: root,
        stdio: "inherit",
        windowsHide: true,
        env: {
          ...process.env,
          PATH: `${dirname(runtime)}${delimiter}${process.env.PATH ?? ""}`,
        },
      });
      child.once("error", () => {
        console.error(
          "No se pudo iniciar el comando. Ejecuta npm install en esta carpeta.",
        );
        resolve(1);
      });
      child.once("exit", (status) => resolve(status ?? 1));
    });
    child = null;
    if (code !== 0) {
      process.exitCode = code;
      return;
    }
  }
}

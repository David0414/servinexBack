import { fileURLToPath } from "node:url";
import { run } from "./runtime.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const mode = process.argv[2];
const extra = process.argv.slice(3);
const tsc = "node_modules/typescript/bin/tsc";
const api = ["--import", "tsx", "src/server.ts"];
const dev =
  process.platform === "win32" || process.platform === "darwin"
    ? ["--watch", "--watch-path=src", "--watch-path=.env", ...api]
    : [
        "node_modules/tsx/dist/cli.mjs",
        "watch",
        "--clear-screen=false",
        "src/server.ts",
      ];
const tasks = {
  dev: [[...dev, ...extra]],
  build: [
    [tsc, "--noEmit"],
    ["node_modules/tsup/dist/cli-default.js", ...extra],
  ],
  start: [["--env-file-if-exists=.env", "dist/server.js", ...extra]],
  typecheck: [[tsc, "--noEmit", ...extra]],
  test: [
    [
      "--import",
      "tsx",
      "--test",
      ...extra,
      "src/security.test.ts",
      "src/database.test.ts",
      "src/api.test.ts",
      "src/service-delete.test.ts",
      "src/team.test.ts",
      "src/dev.test.ts",
    ],
  ],
};
if (!Object.hasOwn(tasks, mode)) {
  console.error("Comando desconocido para Back.");
  process.exitCode = 1;
} else {
  await run(root, tasks[mode], {
    watchEnv:
      mode === "dev" &&
      process.platform !== "win32" &&
      process.platform !== "darwin",
  });
}

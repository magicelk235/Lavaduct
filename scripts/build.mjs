// Compile with tsc, then copy the plain-JS runtime assets beside the output.
import { chmodSync, cpSync, existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
rmSync("dist", { recursive: true, force: true });

const tsc = require.resolve("typescript/bin/tsc");
const res = spawnSync(process.execPath, [tsc], { stdio: "inherit" });
if (res.status !== 0) process.exit(res.status ?? 1);

for (const dir of ["runtime", "templates"]) {
  if (existsSync(`src/${dir}`)) {
    cpSync(`src/${dir}`, `dist/${dir}`, {
      recursive: true,
      filter: (src) => !src.endsWith(".ts"),
    });
  }
}
if (existsSync("dist/cli.js")) chmodSync("dist/cli.js", 0o755);

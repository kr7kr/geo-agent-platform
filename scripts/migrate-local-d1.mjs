import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const stateDirectory = path.join(projectRoot, ".wrangler", "state");
const xdgDirectory = path.join(projectRoot, ".wrangler", "xdg");
const configPath = path.join(projectRoot, "wrangler.local.json");
const wranglerCli = path.join(projectRoot, "node_modules", "wrangler", "bin", "wrangler.js");

mkdirSync(stateDirectory, { recursive: true });
mkdirSync(xdgDirectory, { recursive: true });

const result = spawnSync(process.execPath, [
  wranglerCli,
  "d1", "migrations", "apply", "DB",
  "--config", configPath,
  "--local",
  "--persist-to", stateDirectory,
], {
  cwd: projectRoot,
  env: {
    ...process.env,
    CI: "1",
    XDG_CONFIG_HOME: xdgDirectory,
    WRANGLER_WRITE_LOGS: "false",
  },
  stdio: "inherit",
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

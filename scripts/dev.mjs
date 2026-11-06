// Runs the server (node --watch, straight from TypeScript) and the admin's Vite
// dev server together. Open http://localhost:3000/admin/setup: the server sends
// /admin/* to Vite, and Vite sends /api back to the server.
// Zero dependencies on purpose.
import { spawn } from "node:child_process";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const port = process.env.PORT || "3000";
const adminUrl = "http://localhost:5173";

const children = [
  spawn(process.execPath, ["--watch", join(root, "packages/tendcms/src/cli.ts"), "start"], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      PORT: port,
      TEND_DATA_DIR: process.env.TEND_DATA_DIR || join(root, "data"),
      TEND_ADMIN_DEV_URL: adminUrl,
    },
  }),
  spawn("pnpm", ["--filter", "@tendcms/admin", "dev"], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, TEND_API_URL: `http://127.0.0.1:${port}` },
  }),
];

let stopping = false;
function stopAll(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  process.exitCode = code;
}

for (const child of children) {
  child.on("exit", (code) => stopAll(code ?? 0));
}
process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));

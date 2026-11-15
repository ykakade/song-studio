// `npm run dev`: the API server (restarting on change) + the Vite dev server.
// Open the Vite URL (default http://127.0.0.1:5173); it proxies /api to the server.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const children = [
  spawn(process.execPath, ["--watch-path=server", "server/index.ts"], { cwd: root, stdio: "inherit" }),
  spawn(process.execPath, [path.join(root, "node_modules", "vite", "bin", "vite.js")], { cwd: root, stdio: "inherit" }),
];

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill("SIGINT");
  setTimeout(() => process.exit(code), 1500).unref();
}
for (const c of children) c.on("exit", (code) => stop(code ?? 0));
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

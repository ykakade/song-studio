import { createApp } from "./app.ts";
import { loadConfig, loadDotEnv } from "./config.ts";

loadDotEnv();
const config = loadConfig();
const app = createApp(config);
const { url } = await app.start();

console.log(`Song Studio is running at ${url}`);
console.log(`  listening on  ${config.host}:${config.port}${config.host === "0.0.0.0" ? "  (reachable from other devices on the network)" : "  (this machine only)"}`);
console.log(`  music model   ${config.acestepUrl}`);
console.log(`  chat model    ${app.llm.provider === "fake" ? "scripted fake (no API key needed)" : app.llm.model}`);
const problem = app.llm.problem();
if (problem) console.log(`  ! ${problem}`);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  if (app.queue.isBusy()) console.log("A job is in progress; it will be marked as failed on the next start.");
  await app.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

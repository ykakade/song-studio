// End-to-end check of the real UI in a real browser (Playwright + Chromium),
// against the BUILT app (`npm run build` first), the mock ACE-Step server and
// the scripted fake LLM. Run with: npm run test:e2e
//
// It walks the main flow: create a project, generate a song by chat, play it,
// drag-select a range, repaint it by chat, inspect the splice check, A/B,
// switch takes, download, and see the "model server is down" banner.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createMockAceStep } from "../../server/mock-acestep.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const APP_PORT = Number(process.env.E2E_APP_PORT ?? 18787);
const MOCK_PORT = Number(process.env.E2E_MOCK_PORT ?? 18001);
const APP_URL = `http://127.0.0.1:${APP_PORT}`;
const SHOTS = path.join(ROOT, "test-results");

if (!existsSync(path.join(ROOT, "dist", "index.html"))) {
  console.error("dist/ is missing. Run `npm run build` first.");
  process.exit(2);
}

const steps = [];
function ok(name, detail = "") {
  steps.push(name);
  console.log(`  ✓ ${name}${detail ? `  (${detail})` : ""}`);
}
function assert(cond, message) {
  if (!cond) throw new Error(`Assertion failed: ${message}`);
}

const dataDir = await mkdtemp(path.join(os.tmpdir(), "song-studio-e2e-"));
await mkdir(SHOTS, { recursive: true });
const mock = createMockAceStep({ delayMs: 2500 });
const mockServer = await mock.listen(MOCK_PORT);
let mockUp = true;

const server = spawn(process.execPath, ["server/index.ts"], {
  cwd: ROOT,
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(APP_PORT),
    ACESTEP_URL: mockServer.url,
    SONG_STUDIO_LLM: "fake",
    SONG_STUDIO_DATA_DIR: dataDir,
    SONG_STUDIO_POLL_MS: "300",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${APP_URL}/api/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the app did not start:\n${serverLog}`);
}

let browser;
let failed = null;
try {
  await waitForServer();
  browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") pageErrors.push(m.text());
  });
  page.setDefaultTimeout(20_000);
  const t = (id) => page.getByTestId(id);
  const seconds = async () => Number(await t("time").getAttribute("data-seconds"));

  // --- project list ---------------------------------------------------------------
  await page.goto(APP_URL);
  await page.getByText("No projects yet").waitFor();
  assert((await t("model-banner").count()) === 0, "no model banner while the model server is up");
  await page.getByText("Scripted demo assistant").first().waitFor();
  await page.screenshot({ path: path.join(SHOTS, "01-project-list.png") });
  await t("new-project").click();
  await page.getByText("What should we write?").waitFor();
  await page.getByText("No song yet").waitFor();
  ok("create a project from the project list");

  // --- generate by chat -----------------------------------------------------------
  await t("chat-input").fill("Write a 20 second folk song about paper boats");
  await t("chat-send").click();
  await page.locator('[data-testid="tool-call"][data-tool="generate_song"][data-state="ok"]').waitFor();
  await page.getByText("I've started generating “Paper Boats”").waitFor();
  ok("chat message streams an answer and shows the generate_song tool call");
  await t("job-card").first().waitFor();
  await page.screenshot({ path: path.join(SHOTS, "02-generating.png") });
  ok("job progress is visible while the song is being made");
  await page.locator('[data-testid="current-take"][data-seq="1"]').waitFor();
  await page.locator('[data-testid="play"]:not([disabled])').waitFor();
  await page.locator('[data-testid="note"][data-kind="take_ready"]').first().waitFor();
  assert((await t("job-card").count()) === 0, "the job card goes away when the take is ready");
  assert((await t("project-title").innerText()) === "Paper Boats", "the project took the song's title");
  assert((await t("lyrics").innerText()).includes("Paper boats along the gutter stream"), "lyrics panel shows the take's lyrics");
  assert((await t("take").count()) === 1, "one take in the history");
  await page.waitForFunction(() => (document.querySelector('[data-testid="waveform"] > div')?.shadowRoot?.querySelectorAll("canvas").length ?? 0) > 0);
  ok("take 1 appears with waveform, lyrics and history entry");

  // --- playback and seek ----------------------------------------------------------
  await t("play").click();
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="time"]').dataset.seconds) > 0.6);
  await t("play").click();
  await page.locator('[data-testid="play"][data-playing="false"]').waitFor();
  const paused = await seconds();
  await page.waitForTimeout(400);
  assert(Math.abs((await seconds()) - paused) < 0.05, "pause stops the playhead");
  const box = await t("waveform").boundingBox();
  await page.mouse.click(box.x + box.width * 0.8, box.y + box.height / 2);
  await page.waitForFunction(() => Math.abs(Number(document.querySelector('[data-testid="time"]').dataset.seconds) - 16) < 0.5);
  ok("play, pause and click-to-seek work", `paused at ${paused.toFixed(2)} s, sought to ${(await seconds()).toFixed(2)} s`);

  // --- an edit without a selection must be refused, not guessed ---------------------
  await t("chat-input").fill("Rewrite the lyrics of the second half");
  await t("chat-send").click();
  await page.getByText("Which part should I change? Drag across it on the waveform").waitFor();
  await t("draft").waitFor({ state: "detached" }); // the turn is over
  assert((await t("take").count()) === 1, "no take was created for an edit without a range");
  ok("asking for a change without a selection: the assistant asks for a selection and starts nothing");

  // --- select a range by dragging ---------------------------------------------------
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.3, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.4, y, { steps: 6 });
  await page.mouse.move(box.x + box.width * 0.6, y, { steps: 10 });
  await page.mouse.up();
  await t("selection").waitFor();
  const selText = await t("selection").innerText();
  const m = /(\d+\.\d+)–(\d+\.\d+) s/.exec(selText);
  assert(m, `selection readout has a range: ${selText}`);
  const [selStart, selEnd] = [Number(m[1]), Number(m[2])];
  assert(Math.abs(selStart - 6) < 0.4 && Math.abs(selEnd - 12) < 0.4, `dragging 30%..60% of a 20 s song selects about 6–12 s (got ${selStart}–${selEnd})`);
  assert((await t("attached-selection").innerText()).includes(`${m[1]}–${m[2]} s`), "the selection is attached to the next chat message");
  await page.screenshot({ path: path.join(SHOTS, "03-selection.png") });
  ok("drag on the waveform selects a range, shown in seconds and attached to the chat box", `${selStart}–${selEnd} s`);

  // --- repaint by chat --------------------------------------------------------------
  await t("chat-input").fill("Rewrite the lyrics in the part I selected");
  await t("chat-send").click();
  await page.locator('[data-testid="tool-call"][data-tool="repaint_section"][data-state="ok"]').waitFor();
  assert((await page.locator('[data-testid="msg-user"]').last().innerText()).includes(`with selection ${m[1]}–${m[2]} s`), "the sent message records its selection");
  await page.locator('[data-testid="job-card"]').first().waitFor();
  await page.locator('[data-testid="current-take"][data-seq="2"]').waitFor();
  await page.locator('[data-testid="play"]:not([disabled])').waitFor();
  assert((await t("take").count()) === 2, "a second take is in the history");
  const child = page.locator('[data-testid="take"][data-seq="2"]');
  assert((await child.getAttribute("data-current")) === "true", "the new take is current");
  assert((await child.innerText()).includes("of take 1"), "the history shows the parent");
  assert((await child.innerText()).includes("Rewrote the lyrics in the selected part"), "the history shows what the take changed");
  assert((await child.getByTestId("check-badge").getAttribute("data-status")) === "verified", "the child take's splice check is 'verified'");
  assert((await t("lyrics").innerText()).includes("New words for the part you picked"), "the lyrics panel shows the new lyrics");
  assert((await page.locator(".lyric-changed").count()) >= 2, "changed lyric lines are highlighted");
  await page.getByText(/Take 2 is ready\. Verified: everything outside/).waitFor();
  await child.getByTestId("take-details-toggle").click();
  const details = await t("check-details").innerText();
  assert(/samples compared with the parent, 0 differ/.test(details), `splice details report 0 differing samples: ${details}`);
  assert(/-0\.\d+ dB on the whole file/.test(details), "splice details report the model's gain change");
  await page.screenshot({ path: path.join(SHOTS, "04-repainted.png") });
  ok("repaint by chat creates a child take with a verified splice check", details.split("\n").slice(0, 4).join(" | "));

  // --- A/B with the parent, keeping the playhead ---------------------------------------
  await t("play").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="play"]').dataset.playing === "true");
  await page.waitForTimeout(700);
  const beforeSwitch = await seconds();
  await t("ab-parent").click();
  await page.locator('[data-testid="ab"][data-listening="parent"]').waitFor();
  await page.locator('[data-testid="play"]:not([disabled])').waitFor();
  const afterSwitch = await seconds();
  assert(afterSwitch >= beforeSwitch - 0.3 && afterSwitch < beforeSwitch + 2.5, `the playhead is kept across A/B (${beforeSwitch.toFixed(2)} -> ${afterSwitch.toFixed(2)})`);
  await page.waitForFunction((t0) => Number(document.querySelector('[data-testid="time"]').dataset.seconds) > t0 + 0.3, afterSwitch);
  assert((await t("lyrics").innerText()).includes("Hold on, hold on, the morning's on its way"), "B shows the parent's lyrics");
  await t("ab-take").click();
  await page.locator('[data-testid="ab"][data-listening="take"]').waitFor();
  await page.locator('[data-testid="play"]:not([disabled])').waitFor();
  await t("play").click();
  ok("A/B switches between the take and its parent, keeps the playhead and keeps playing", `${beforeSwitch.toFixed(2)} s -> ${afterSwitch.toFixed(2)} s`);

  // --- switch takes from the history ---------------------------------------------------
  await page.locator('[data-testid="take"][data-seq="1"] .take-select').click();
  await page.locator('[data-testid="current-take"][data-seq="1"]').waitFor();
  assert((await t("ab").count()) === 0, "take 1 has no parent, so no A/B");
  assert(!(await t("lyrics").innerText()).includes("New words"), "take 1 shows its own lyrics");
  await page.locator('[data-testid="take"][data-seq="2"] .take-select').click();
  await page.locator('[data-testid="current-take"][data-seq="2"]').waitFor();
  ok("clicking a take in the history loads it");

  // --- download ----------------------------------------------------------------------
  const href = await t("download").getAttribute("href");
  const dl = await page.request.get(APP_URL + href);
  assert(dl.status() === 200, "download answers 200");
  assert(/attachment; filename="Paper Boats - take 2\.wav"/.test(dl.headers()["content-disposition"] ?? ""), "download has a file name");
  assert((await dl.body()).length === 44 + 20 * 48000 * 4, "download is the full 20 s WAV");
  ok("the download button serves the take's WAV");

  // --- project list shows the project ---------------------------------------------------
  await page.goto(APP_URL + "/#/");
  const card = t("project-card").first();
  await card.waitFor();
  assert((await card.innerText()).includes("Paper Boats") && (await card.innerText()).includes("2 takes"), "the project card shows title and take count");
  await page.screenshot({ path: path.join(SHOTS, "06-project-list-recent.png") });
  await card.click();
  await page.locator('[data-testid="current-take"][data-seq="2"]').waitFor();
  assert((await t("msg-user").count()) === 3, "the chat history is restored when the project is reopened");
  ok("the project is listed and reopens with its chat and takes");

  // --- model server down --------------------------------------------------------------
  await mockServer.close();
  mockUp = false;
  await t("model-banner").waitFor({ timeout: 25_000 });
  const banner = await t("model-banner").innerText();
  assert(banner.includes("scripts/start-model-server.sh"), "the banner shows the command to start the model server");
  await page.screenshot({ path: path.join(SHOTS, "05-model-server-down.png") });
  ok("a banner with the start command appears when the model server is unreachable");

  const realErrors = pageErrors.filter((e) => !/Failed to load resource/.test(e));
  assert(realErrors.length === 0, `no errors in the browser console: ${realErrors.join(" | ")}`);
  ok("no errors in the browser console");
} catch (err) {
  failed = err;
  try {
    const pages = browser?.contexts().flatMap((c) => c.pages()) ?? [];
    if (pages[0]) await pages[0].screenshot({ path: path.join(SHOTS, "failure.png") });
  } catch {
    /* ignore */
  }
} finally {
  await browser?.close();
  server.kill("SIGINT");
  await new Promise((r) => server.once("exit", r));
  if (mockUp) await mockServer.close();
  await rm(dataDir, { recursive: true, force: true });
}

if (failed) {
  console.error(`\nE2E FAILED after ${steps.length} step(s): ${failed.message}`);
  console.error(`Screenshot: ${path.join(SHOTS, "failure.png")}`);
  if (serverLog.trim()) console.error(`--- server log ---\n${serverLog.trim()}`);
  process.exit(1);
}
console.log(`\nE2E passed: ${steps.length} steps. Screenshots in ${SHOTS}`);

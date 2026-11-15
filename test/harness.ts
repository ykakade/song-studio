// Spins up the real app against the mock ACE-Step server and a temp data dir.

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp, type SongStudioApp } from "../server/app.ts";
import { loadConfig, type Config } from "../server/config.ts";
import type { LlmClient } from "../server/llm/types.ts";
import { FakeLlm, type ScriptedTurn } from "../server/llm/fake.ts";
import { createMockAceStep, type MockAceStep } from "../server/mock-acestep.ts";
import type { ChatMessage, Take } from "../server/types.ts";
import { sungLines } from "../server/lyrics.ts";
import { evenlySpaced, FakeTranscriber, type Transcriber } from "../server/transcribe.ts";
import { waitFor } from "./helpers.ts";

export interface Harness {
  app: SongStudioApp;
  mock: MockAceStep;
  mockUrl: string;
  /** Closes the mock ACE-Step server (stop() does this unless keepMock is set). */
  closeMock(): Promise<void>;
  dataDir: string;
  config: Config;
  url: string;
  /** Wait for every queued job and the project's chat turn to finish. */
  settle(projectId?: string): Promise<void>;
  /** Send a chat message and wait until the turn AND any job it started are finished. */
  say(projectId: string, text: string, selection?: { startSec: number; endSec: number } | null): Promise<ChatMessage[]>;
  takes(projectId: string): Take[];
  stop(opts?: { keepData?: boolean; keepMock?: boolean }): Promise<void>;
}

export interface HarnessOptions {
  mockDelayMs?: number;
  script?: ScriptedTurn[];
  llm?: LlmClient;
  /** Reuse a data dir / mock from an earlier harness (restart tests). */
  dataDir?: string;
  mock?: { mock: MockAceStep; url: string; close(): Promise<void> };
  /** Point at a dead port instead of the mock. */
  modelServerDown?: boolean;
  listen?: boolean;
  /** Speech recognition for finished takes. Default: a fake that hears every lyric word, evenly spread. null = off. */
  transcriber?: Transcriber | null;
}

/** Hears the take's sung lines word by word, spread evenly from 2 s to 1 s before the end. */
export function hearsTheLyrics(): FakeTranscriber {
  return new FakeTranscriber((_file, hint) => evenlySpaced(sungLines(hint.lyrics).join(" "), 2, Math.max(3, hint.durationSec - 1)));
}

export async function startHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const dataDir = opts.dataDir ?? (await mkdtemp(path.join(os.tmpdir(), "song-studio-data-")));
  let mock: MockAceStep;
  let mockServer: { url: string; close(): Promise<void> };
  if (opts.mock) {
    mock = opts.mock.mock;
    mockServer = opts.mock;
  } else {
    mock = createMockAceStep({ delayMs: opts.mockDelayMs ?? 60 });
    mockServer = await mock.listen(0);
  }
  const config: Config = {
    ...loadConfig({}),
    host: "127.0.0.1",
    port: 0,
    dataDir,
    acestepUrl: opts.modelServerDown ? "http://127.0.0.1:9" : mockServer.url,
    pollIntervalMs: 20,
    llm: "fake",
  };
  const llm = opts.llm ?? new FakeLlm({ wordDelayMs: 0, script: opts.script });
  const app = createApp(config, { llm, transcriber: opts.transcriber !== undefined ? opts.transcriber : hearsTheLyrics() });
  let url = "";
  if (opts.listen !== false) url = (await app.start()).url;

  const settle = async (projectId?: string) => {
    for (let i = 0; i < 3; i++) {
      if (projectId) await app.agent.whenIdle(projectId);
      await app.queue.whenIdle();
    }
  };

  return {
    app,
    mock,
    mockUrl: mockServer.url,
    closeMock: () => mockServer.close(),
    dataDir,
    config,
    url,
    settle,
    async say(projectId, text, selection = null) {
      app.agent.send(projectId, text, selection);
      await settle(projectId);
      await waitFor(() => !app.agent.isBusy(projectId) && !app.queue.isBusy());
      return app.store.listMessages(projectId);
    },
    takes: (projectId) => app.store.listTakes(projectId),
    async stop(o = {}) {
      await app.close();
      if (!o.keepMock) await mockServer.close();
      if (!o.keepData) await rm(dataDir, { recursive: true, force: true });
    },
  };
}

export const SONG = {
  title: "Paper Boats",
  stylePrompt: "warm indie folk, fingerpicked acoustic guitar, soft vocal",
  lyrics: "[verse]\nPaper boats along the gutter stream\n\n[chorus]\nHold on, hold on\n\n[outro]\nHold on",
  bpm: 96,
  key: "G Major",
  durationSec: 12,
};

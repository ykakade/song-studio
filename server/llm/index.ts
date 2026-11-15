import type { Config } from "../config.ts";
import { AnthropicLlm } from "./anthropic.ts";
import { FakeLlm } from "./fake.ts";
import type { LlmClient } from "./types.ts";

export function createLlm(config: Config): LlmClient {
  return config.llm === "fake" ? new FakeLlm() : new AnthropicLlm(config);
}

export * from "./types.ts";

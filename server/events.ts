import { EventEmitter } from "node:events";
import type { StudioEvent } from "./types.ts";

/** Per-project fan-out of live events to whoever has the project open (SSE). */
export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  emit(projectId: string, event: StudioEvent): void {
    this.emitter.emit(projectId, event);
  }

  subscribe(projectId: string, listener: (event: StudioEvent) => void): () => void {
    this.emitter.on(projectId, listener);
    return () => this.emitter.off(projectId, listener);
  }
}

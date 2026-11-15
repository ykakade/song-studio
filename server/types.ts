// Shapes shared by the server and the web client (type-only; no runtime code).

// --- splice verification (produced by splice.ts, stored on repaint takes) -----------

export interface BoundaryCheck {
  /** Which edge of the repainted range this is. */
  edge: "start" | "end";
  timeSec: number;
  /** RMS level (dBFS) of the 100 ms on the kept side of the boundary. */
  keptDb: number | null;
  /** RMS level (dBFS) of the 100 ms on the repainted side, crossfade included. */
  newDb: number | null;
  /** newDb - keptDb: the level step a listener crosses at this join. */
  stepDb: number | null;
  /** The same step measured in the parent at the same spot, for comparison. */
  parentStepDb: number | null;
  /** Quietest 5 ms inside the +-50 ms around the join, relative to the quieter side. Strongly negative = a dip. */
  dipDb: number | null;
  /** The same dip measurement on the parent at this spot. Music dips between beats anyway; compare against this. */
  parentDipDb: number | null;
}

export interface SpliceChecks {
  /**
   * verified:   spliced by the app; outside the range the take is bit-identical to its parent.
   * fallback:   the server's file was used as-is; the guarantee was NOT verified (see `reason`).
   * failed:     spliced by the app, but the comparison found differences outside the range.
   *             This should be impossible; it means a bug, and the take must not be trusted.
   */
  status: "verified" | "fallback" | "failed";
  reason: string | null;
  startSec: number;
  endSec: number;
  startFrame: number;
  endFrame: number;
  crossfadeMs: number;
  /** Gain the server applied to the untouched audio (linear), least-squares estimate. null if it could not be estimated. */
  gain: number | null;
  gainDb: number | null;
  /** Correlation between parent and server output outside the range (should be ~1). */
  correlation: number | null;
  /** Largest |server - gain * parent| outside the range, in 16-bit steps (expected about 1). */
  residualLsb: number | null;
  /** Gain actually applied to the new audio inside the range (1/gain, reduced if that would clip). */
  appliedGain: number;
  /** True when appliedGain had to stay more than 0.01 dB below 1/gain to keep the new audio under full scale. */
  gainLimitedToAvoidClipping: boolean;
  /** Number of samples outside the range compared against the parent, and how many differ. */
  outsideSamples: number;
  outsideMismatches: number;
  bitIdenticalOutside: boolean;
  boundaries: BoundaryCheck[];
}

export interface Selection {
  startSec: number;
  endSec: number;
}

export interface Marker {
  label: string;
  startSec: number;
  endSec: number;
}

// --- timing (produced by align.ts from a Whisper transcription) ---------------------------

export interface HeardWord {
  w: string;
  t0: number;
  t1: number;
  /** Whisper's confidence, 0..1. */
  p: number;
}

export interface DetectedLine {
  /** Label of the section the line is in ("chorus 2"). */
  section: string;
  text: string;
  /** null when none of the line's words were heard. */
  startSec: number | null;
  endSec: number | null;
  wordsHeard: number;
  words: number;
}

export interface DetectedSection {
  label: string;
  startSec: number;
  endSec: number;
  /** "sung": placed by its heard words. "instrumental": a tagged part without lines, placed in the gap between sung parts. */
  kind: "sung" | "instrumental";
  wordsHeard: number;
  words: number;
}

/** Where the lyrics are in one take's audio. Stored as takes/take-NNN.timing.json. */
export interface TakeTiming {
  /** The transcriber that produced the words. */
  model: string;
  heardText: string;
  words: HeardWord[];
  lines: DetectedLine[];
  sections: DetectedSection[];
  lyricWords: number;
  lyricWordsHeard: number;
}

/** Everything that went into making a take. Recorded once, never changed. */
export interface TakeParams {
  title: string;
  stylePrompt: string;
  /** The complete lyrics of the song as of this take. */
  lyrics: string;
  bpm: number;
  key: string;
  timeSignature: string;
  vocalLanguage: string;
  durationSec: number;
  seed: number;
  /** Present on repaint takes: the range that was regenerated. */
  repaint: Selection | null;
}

export type TakeStatus = "queued" | "running" | "done" | "failed";

export interface Take {
  id: string;
  projectId: string;
  /** 1, 2, 3... within the project, in creation order ("Take 3"). */
  seq: number;
  /** null for a first generation. */
  parentTakeId: string | null;
  /** The first take of this take's lineage (itself if it has no parent). Markers hang off this. */
  rootTakeId: string;
  kind: "generate" | "repaint";
  status: TakeStatus;
  params: TakeParams;
  /** One line: what this take changed, as described by whoever asked for it. */
  changeSummary: string;
  /** Actual length of the audio file. */
  durationSec: number | null;
  sampleRate: number | null;
  /** Splice verification, repaint takes only. */
  checks: SpliceChecks | null;
  error: string | null;
  jobId: string | null;
  createdAt: number;
  finishedAt: number | null;
}

export type JobStatus = "queued" | "running" | "done" | "failed";

export interface JobTimings {
  /** Waiting in the app's queue before submission. */
  queuedMs?: number;
  /** From submitting to ACE-Step until it reported done. */
  modelMs?: number;
  downloadMs?: number;
  /** Decode + splice + verify + write (repaint) or decode + peaks (generate). */
  finaliseMs?: number;
  totalMs?: number;
}

export interface Job {
  id: string;
  projectId: string;
  takeId: string;
  kind: "generate" | "repaint";
  status: JobStatus;
  /** 0..1 */
  progress: number;
  stage: string | null;
  progressText: string | null;
  error: string | null;
  timings: JobTimings;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface Project {
  /** The project folder's name. */
  id: string;
  title: string;
  /** Absolute path of the project folder. */
  path: string;
  currentTakeId: string | null;
  /** The waveform selection that came with the latest chat message. */
  selection: Selection | null;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectSummary extends Project {
  takeCount: number;
  currentTakeTitle: string | null;
}

// --- chat -------------------------------------------------------------------

export type ChatBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

export interface ToolResultRecord {
  toolUseId: string;
  name: string;
  /** JSON text handed back to the model. */
  content: string;
  isError: boolean;
}

export type ChatContent =
  | { role: "user"; text: string; selection: Selection | null }
  | { role: "assistant"; blocks: ChatBlock[]; stopReason: string }
  | { role: "tool"; results: ToolResultRecord[] }
  | { role: "event"; kind: "take_ready" | "take_failed" | "error" | "info"; text: string; takeId?: string };

export type ChatMessage = ChatContent & { id: number; projectId: string; createdAt: number };

export interface ProjectState {
  project: Project;
  takes: Take[];
  /** Where the lyrics are in the current take, if it has been analysed. */
  timing: TakeTiming | null;
  /** The current take is still being analysed (Whisper). */
  analysing: boolean;
  /** Markers of the current take's song (lineage). */
  markers: Marker[];
  /** Jobs that are queued or running. */
  activeJobs: Job[];
  messages: ChatMessage[];
  chatBusy: boolean;
  /** lyrics.md when it has been edited outside the studio and differs from the current take; else null. */
  lyricsDraft: string | null;
}

export interface Health {
  modelServer: { reachable: boolean; url: string; error: string | null; busy: boolean };
  llm: { provider: "anthropic" | "fake"; model: string; ready: boolean; problem: string | null };
}

/** Server-sent events on /api/projects/:id/events */
export type StudioEvent =
  | { type: "chat.turn"; state: "started" | "ended"; error?: string }
  | { type: "chat.delta"; text: string }
  | { type: "chat.message"; message: ChatMessage }
  | { type: "job"; job: Job }
  | { type: "state" };

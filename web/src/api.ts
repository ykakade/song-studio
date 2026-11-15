import type { Health, Job, Marker, Project, ProjectState, ProjectSummary, Selection, StudioEvent, Take } from "../../server/types.ts";

export type {
  ChatMessage,
  DetectedLine,
  DetectedSection,
  Health,
  Job,
  Marker,
  Project,
  ProjectState,
  ProjectSummary,
  Selection,
  SpliceChecks,
  StudioEvent,
  Take,
  TakeTiming,
} from "../../server/types.ts";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "offline", "Cannot reach the Song Studio server. Is it still running?");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.code ?? "error", data?.error ?? `Request failed (${res.status})`);
  return data as T;
}

export const api = {
  health: () => request<Health>("GET", "/api/health"),
  listProjects: () => request<{ projects: ProjectSummary[] }>("GET", "/api/projects").then((r) => r.projects),
  createProject: (title?: string) => request<{ project: Project }>("POST", "/api/projects", { title }).then((r) => r.project),
  renameProject: (id: string, title: string) => request<{ project: Project }>("PATCH", `/api/projects/${id}`, { title }).then((r) => r.project),
  deleteProject: (id: string) => request<{ deleted: boolean }>("DELETE", `/api/projects/${id}`),
  project: (id: string) => request<ProjectState>("GET", `/api/projects/${id}`),
  chat: (id: string, text: string, selection: Selection | null) => request<unknown>("POST", `/api/projects/${id}/chat`, { text, selection }),
  setCurrentTake: (id: string, takeId: string) => request<{ take: Take }>("POST", `/api/projects/${id}/current-take`, { takeId }),
  setSelection: (id: string, selection: Selection | null) => request<{ selection: Selection | null }>("PUT", `/api/projects/${id}/selection`, { selection }),
  analyse: (id: string, takeId: string) => request<{ queued: boolean }>("POST", `/api/projects/${id}/takes/${takeId}/analyse`),
  setMarkers: (id: string, markers: Marker[]) => request<{ markers: Marker[] }>("PUT", `/api/projects/${id}/markers`, { markers }).then((r) => r.markers),
  peaks: (takeId: string) => request<{ peaks: number[]; durationSec: number }>("GET", `/api/takes/${takeId}/peaks`),
  audioUrl: (takeId: string) => `/api/takes/${takeId}/audio`,
  downloadUrl: (takeId: string) => `/api/takes/${takeId}/audio?download`,
};

/** Subscribe to a project's live events. Returns a function that closes the stream. */
export function subscribe(projectId: string, onEvent: (e: StudioEvent) => void, onOpen: () => void): () => void {
  const source = new EventSource(`/api/projects/${projectId}/events`);
  source.onopen = onOpen;
  source.onmessage = (m) => {
    try {
      onEvent(JSON.parse(m.data) as StudioEvent);
    } catch {
      /* ignore malformed frames */
    }
  };
  return () => source.close();
}

export function fmtTime(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

export function fmtRange(sel: Selection): string {
  return `${sel.startSec.toFixed(2)}–${sel.endSec.toFixed(2)} s`;
}

export function timeAgo(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

export type { Job as JobT };

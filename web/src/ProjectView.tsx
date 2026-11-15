import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, subscribe, type Health, type Job, type Marker, type ProjectState, type Selection, type StudioEvent } from "./api.ts";
import { Bookmark, ChevronRight, Download, PanelLeft, PanelRight } from "lucide-react";
import { Chat, JobCard } from "./Chat.tsx";
import { CheckBadge, Lyrics, Outline, TakeDetails, TakeHistory } from "./Panels.tsx";
import { Waveform } from "./Waveform.tsx";

const icon = { size: 16, strokeWidth: 1.5 } as const;

/** A panel's open/closed state, remembered in this browser. */
function usePanel(name: string): [boolean, () => void] {
  const key = `song-studio.panel.${name}`;
  const [open, setOpen] = useState(() => {
    try {
      return window.localStorage.getItem(key) !== "closed";
    } catch {
      return true;
    }
  });
  const toggle = () =>
    setOpen((v) => {
      try {
        window.localStorage.setItem(key, v ? "closed" : "open");
      } catch {
        /* private window: the choice just is not remembered */
      }
      return !v;
    });
  return [open, toggle];
}

interface Props {
  projectId: string;
  llm: Health["llm"] | null;
  /** What the project is busy with, for the status bar. */
  onActivity: (text: string | null) => void;
}

export function ProjectView({ projectId, llm, onActivity }: Props) {
  const [state, setState] = useState<ProjectState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [turnActive, setTurnActive] = useState(false);
  const [liveJobs, setLiveJobs] = useState<Record<string, Job>>({});
  const [selection, setSelection] = useState<Selection | null>(null);
  const [listenParent, setListenParent] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const [sideOpen, toggleSide] = usePanel("takes");
  const [chatOpen, toggleChat] = usePanel("agent");

  // --- loading and live updates ---------------------------------------------------------

  const refreshing = useRef(false);
  const refreshAgain = useRef(false);
  const refresh = useCallback(async () => {
    if (refreshing.current) {
      refreshAgain.current = true;
      return;
    }
    refreshing.current = true;
    try {
      do {
        refreshAgain.current = false;
        const next = await api.project(projectId);
        setState(next);
        setTurnActive(next.chatBusy);
        setLiveJobs((jobs) => {
          // Only what the server reports as active; keep a fresher live progress value if we have one.
          const out: Record<string, Job> = {};
          for (const j of next.activeJobs) out[j.id] = jobs[j.id] && jobs[j.id].progress > j.progress ? jobs[j.id] : j;
          return out;
        });
        setError(null);
      } while (refreshAgain.current);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      refreshing.current = false;
    }
  }, [projectId]);

  useEffect(() => {
    const onEvent = (e: StudioEvent) => {
      switch (e.type) {
        case "chat.turn":
          setTurnActive(e.state === "started");
          setDraft("");
          break;
        case "chat.delta":
          setDraft((d) => d + e.text);
          break;
        case "chat.message":
          setState((s) => (s && !s.messages.some((m) => m.id === e.message.id) ? { ...s, messages: [...s.messages, e.message] } : s));
          if (e.message.role === "assistant") setDraft("");
          break;
        case "job":
          setLiveJobs((jobs) => {
            if (e.job.status === "queued" || e.job.status === "running") return { ...jobs, [e.job.id]: e.job };
            const { [e.job.id]: _done, ...rest } = jobs;
            return rest;
          });
          break;
        case "state":
          void refresh();
          break;
      }
    };
    // (Re)connecting always starts with a full refresh, so nothing is missed while offline.
    return subscribe(projectId, onEvent, () => void refresh());
  }, [projectId, refresh]);

  // --- derived state --------------------------------------------------------------------

  const takes = state?.takes ?? [];
  const current = useMemo(() => takes.find((t) => t.id === state?.project.currentTakeId) ?? null, [takes, state?.project.currentTakeId]);
  const parent = useMemo(() => (current?.parentTakeId ? (takes.find((t) => t.id === current.parentTakeId && t.status === "done") ?? null) : null), [takes, current]);
  const jobs = useMemo(() => Object.values(liveJobs).sort((a, b) => a.createdAt - b.createdAt), [liveJobs]);
  const markers = state?.markers ?? [];

  // The server keeps the live selection, so that outside agents (MCP) see what the person selected.
  useEffect(() => {
    const t = setTimeout(() => void api.setSelection(projectId, current ? selection : null).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [projectId, selection, current?.id]);

  const timing = state?.timing ?? null;
  const heard = timing?.sections ?? [];

  // A/B always starts on the take itself.
  useEffect(() => setListenParent(false), [current?.id]);
  // A selection that no longer fits the song is dropped.
  useEffect(() => {
    if (selection && current?.durationSec && selection.endSec > current.durationSec + 0.01) setSelection(null);
  }, [current?.id, current?.durationSec, selection]);

  const activity = useMemo(() => {
    const running = jobs.find((j) => j.status === "running") ?? jobs[0];
    if (!running) return null;
    const take = takes.find((t) => t.id === running.takeId);
    const r = take?.params.repaint;
    const what = running.kind === "generate" ? "Generating" : `Repainting${r ? ` ${r.startSec.toFixed(1)}–${r.endSec.toFixed(1)} s` : ""}`;
    return `${what}, take ${take?.seq ?? "…"}${jobs.length > 1 ? ` · ${jobs.length - 1} queued` : ""}`;
  }, [jobs, takes]);
  useEffect(() => {
    onActivity(activity);
    return () => onActivity(null);
  }, [activity, onActivity]);

  // --- actions --------------------------------------------------------------------------

  const guard = async (fn: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await fn();
    } catch (e) {
      setActionError((e as Error).message);
    }
  };

  const send = async (text: string) => {
    await api.chat(projectId, text, current ? selection : null);
    setTurnActive(true);
  };

  const saveMarker = () => {
    if (!selection) return;
    const label = window.prompt("Name this part (for example: chorus, verse 2, bridge)")?.trim();
    if (!label) return;
    const next: Marker[] = [...markers.filter((m) => m.label.toLowerCase() !== label.toLowerCase()), { label, ...selection }];
    void guard(() => api.setMarkers(projectId, next));
  };

  const rename = () => {
    const title = window.prompt("Project name", state?.project.title)?.trim();
    if (title) void guard(() => api.renameProject(projectId, title));
  };

  // --- render ---------------------------------------------------------------------------

  if (!state) {
    return (
      <div className="center-page">
        {error ? (
          <>
            <p className="inline-error">{error}</p>
            <a className="btn" href="#/">
              Back to projects
            </a>
          </>
        ) : (
          <p className="muted">Loading</p>
        )}
      </div>
    );
  }

  const shown = listenParent && parent ? parent : current;
  const details = detailsId ? (takes.find((t) => t.id === detailsId) ?? null) : null;
  const selectTake = (id: string) => void guard(() => api.setCurrentTake(projectId, id));

  return (
    <div className="project">
      <header className="titlebar">
        <button className="icon-btn" onClick={toggleSide} aria-pressed={sideOpen} aria-label="Takes and sections" title="Takes and sections">
          <PanelLeft {...icon} />
        </button>
        <nav className="crumbs" aria-label="Project">
          <a href="#/" aria-label="All projects">
            Projects
          </a>
          <ChevronRight size={12} strokeWidth={1.5} />
          <button className="title-btn" onClick={rename} title="Rename project" data-testid="project-title">
            {state.project.title}
          </button>
        </nav>
        <button
          className="folder-path"
          title="The project folder. Click to copy the path"
          onClick={() => void navigator.clipboard?.writeText(state.project.path).catch(() => {})}
          data-testid="project-folder"
        >
          <bdi>{state.project.path}</bdi>
        </button>
        <span className="spacer" />
        <button className="icon-btn" onClick={toggleChat} aria-pressed={chatOpen} aria-label="Agent" title="Agent">
          <PanelRight {...icon} />
        </button>
      </header>

      <div className={`workbench ${sideOpen ? "" : "no-side"} ${chatOpen ? "" : "no-chat"}`}>
        <aside className="sidebar">
          <TakeHistory takes={takes} currentTakeId={current?.id ?? null} onSelect={selectTake} detailsId={detailsId} onDetails={setDetailsId} />
          {current && (
            <Outline
              markers={markers}
              heard={heard}
              timing={timing}
              analysing={state.analysing}
              onSelect={setSelection}
              onDeleteMarker={(label) => void guard(() => api.setMarkers(projectId, markers.filter((x) => x.label !== label)))}
              onAnalyse={() => void guard(() => api.analyse(projectId, current.id))}
            />
          )}
        </aside>

        <main className="editor">
          {actionError && <div className="inline-error">{actionError}</div>}
          {error && <div className="inline-error">{error}</div>}
          {state.lyricsDraft && (
            <div className="notice" data-testid="lyrics-draft">
              lyrics.md was edited outside the studio and differs from this take. Ask the agent to sing your edits
            </div>
          )}

          {current && shown ? (
            <>
              <header className="editor-head">
                <div className="wave-title">
                  <h2 data-testid="current-take" data-take-id={current.id} data-seq={current.seq}>
                    {current.params.title} <span className="muted">· take {current.seq}</span>
                  </h2>
                  <span className="muted small">{current.kind === "generate" ? "New song" : `Repaint of take ${parent?.seq ?? "?"}: ${current.changeSummary}`}</span>
                </div>
                <div className="editor-actions">
                  {current.checks && <CheckBadge checks={current.checks} />}
                  {parent && (
                    <div className="ab" role="group" aria-label="Compare with the parent take" data-testid="ab" data-listening={listenParent ? "parent" : "take"}>
                      <button className={`ab-btn ${!listenParent ? "ab-on" : ""}`} onClick={() => setListenParent(false)} aria-pressed={!listenParent} data-testid="ab-take">
                        Take {current.seq}
                      </button>
                      <button className={`ab-btn ${listenParent ? "ab-on" : ""}`} onClick={() => setListenParent(true)} aria-pressed={listenParent} data-testid="ab-parent">
                        Take {parent.seq}
                      </button>
                    </div>
                  )}
                  <a className="btn btn-small" href={api.downloadUrl(shown.id)} download data-testid="download" title={`Download take ${shown.seq} as WAV`}>
                    <Download size={12} strokeWidth={1.5} />
                    WAV
                  </a>
                </div>
              </header>

              <Waveform
                takeId={shown.id}
                songKey={current.rootTakeId}
                selection={selection}
                onSelection={setSelection}
                markers={markers}
                changedRange={!listenParent ? current.params.repaint : null}
                heard={!listenParent ? heard : []}
                selectionActions={
                  <button className="btn btn-small" onClick={saveMarker} data-testid="save-marker">
                    <Bookmark size={12} strokeWidth={1.5} />
                    Name it
                  </button>
                }
              />

              <Lyrics take={shown} parent={shown === current ? parent : null} timing={shown === current ? timing : null} onSelectLine={setSelection} />
            </>
          ) : (
            <div className="stage-empty">
              <div className="stage-art" aria-hidden="true" />
              {jobs.length > 0 ? (
                <>
                  <h2>Your song is being made</h2>
                  <div className="stage-wait">
                    {jobs.map((j) => (
                      <JobCard key={j.id} job={j} take={takes.find((t) => t.id === j.takeId)} />
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <h2>No song yet</h2>
                  <p>Tell the agent what you want to hear. The waveform, lyrics and takes appear here</p>
                </>
              )}
            </div>
          )}

          {details && <TakeDetails take={details} onClose={() => setDetailsId(null)} />}
        </main>

        <Chat
          messages={state.messages}
          draft={draft}
          busy={turnActive}
          jobs={jobs}
          takes={takes}
          selection={current ? selection : null}
          onClearSelection={() => setSelection(null)}
          onSend={send}
          hasTake={current !== null}
          llm={llm}
        />
      </div>
    </div>
  );
}

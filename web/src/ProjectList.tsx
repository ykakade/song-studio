import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api, timeAgo, type Health, type ProjectSummary } from "./api.ts";
import { openProject } from "./App.tsx";

export function llmLabel(llm: Health["llm"]): string {
  return llm.provider === "fake" ? "Scripted demo assistant" : llm.model;
}

export function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}

export function ProjectList() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = () =>
    api
      .listProjects()
      .then((p) => {
        setProjects(p);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    void load();
  }, []);

  const create = async () => {
    setCreating(true);
    try {
      const p = await api.createProject();
      openProject(p.id);
    } catch (e) {
      setError((e as Error).message);
      setCreating(false);
    }
  };

  const remove = async (p: ProjectSummary) => {
    if (!window.confirm(`Delete “${p.title}” and all of its takes? This cannot be undone.`)) return;
    try {
      await api.deleteProject(p.id);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="welcome">
      <div className="welcome-art" aria-hidden="true" />
      <div className="welcome-col">
        <div className="brand">
          <BrandMark />
          Song Studio
        </div>
        <h1 className="welcome-title">Describe a song, hear it, then change only the part you point at</h1>
        <p className="welcome-sub">An agent writes the lyrics and runs the music model on this machine. Every change is a new take, and the rest of the song stays bit-identical.</p>
        <div className="welcome-actions">
          <button className="btn btn-primary" onClick={create} disabled={creating} data-testid="new-project">
            <Plus size={16} strokeWidth={1.5} />
            New project
          </button>
        </div>

        {error && (
          <div className="inline-error" style={{ marginTop: 24 }}>
            {error}
          </div>
        )}

        {projects === null ? (
          !error && <p className="muted recent">Loading</p>
        ) : projects.length === 0 ? (
          <div className="empty">
            <h2>No projects yet</h2>
            <p>A project is a folder with one song and every take you make of it</p>
          </div>
        ) : (
          <div className="recent">
            <div className="recent-head">
              <span>Recent projects</span>
              <span className="mono">{projects.length}</span>
            </div>
            <ul className="project-grid">
              {projects.map((p) => (
                <li key={p.id} className="project-card">
                  <a href={`#/p/${p.id}`} className="project-link" data-testid="project-card">
                    <span className="project-title">{p.title}</span>
                    <span className="project-meta">
                      {p.takeCount === 0 ? "no takes" : `${p.takeCount} take${p.takeCount === 1 ? "" : "s"}`} · {timeAgo(p.updatedAt)}
                    </span>
                  </a>
                  <button className="icon-btn project-delete" title="Delete project" aria-label={`Delete ${p.title}`} onClick={() => void remove(p)}>
                    <Trash2 size={14} strokeWidth={1.5} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

import { CircleX, Copy, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type Health } from "./api.ts";
import { llmLabel, ProjectList } from "./ProjectList.tsx";
import { ProjectView } from "./ProjectView.tsx";

/** "#/p/<id>" opens a project; anything else is the project list. */
function useRoute(): { projectId: string | null } {
  const read = () => /^#\/p\/([\w-]+)/.exec(window.location.hash)?.[1] ?? null;
  const [projectId, setProjectId] = useState(read);
  useEffect(() => {
    const onChange = () => setProjectId(read());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return { projectId };
}

export function openProject(id: string | null): void {
  window.location.hash = id ? `#/p/${id}` : "#/";
}

function useHealth(): Health | "offline" | null {
  const [health, setHealth] = useState<Health | "offline" | null>(null);
  useEffect(() => {
    let stop = false;
    let timer: number | undefined;
    const tick = async () => {
      let next: Health | "offline";
      try {
        next = await api.health();
      } catch {
        next = "offline";
      }
      if (stop) return;
      setHealth(next);
      const ok = next !== "offline" && next.modelServer.reachable;
      timer = window.setTimeout(tick, ok ? 10_000 : 4_000);
    };
    void tick();
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, []);
  return health;
}

const START_COMMAND = "scripts/start-model-server.sh";

function Banners({ health }: { health: Health | "offline" | null }) {
  const [copied, setCopied] = useState(false);
  if (health === null) return null;
  if (health === "offline") {
    return (
      <div className="banner banner-error" role="alert">
        <CircleX size={16} strokeWidth={1.5} />
        <span>
          <strong>Song Studio's own server is not answering.</strong> Start it again with <code>npm start</code> in the app folder
        </span>
      </div>
    );
  }
  return (
    <>
      {!health.modelServer.reachable && (
        <div className="banner banner-warn" role="alert" data-testid="model-banner">
          <TriangleAlert size={16} strokeWidth={1.5} />
          <span>
            <strong>The music model server is not running</strong> at <code>{health.modelServer.url}</code>, so songs cannot be generated or edited. Start it in a
            terminal from the app folder; it takes about 80 seconds to load
          </span>
          <div className="banner-cmd">
            <code>{START_COMMAND}</code>
            <button
              className="btn btn-small"
              onClick={() => {
                void navigator.clipboard?.writeText(START_COMMAND).then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              <Copy size={12} strokeWidth={1.5} />
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}
      {!health.llm.ready && (
        <div className="banner banner-warn" role="alert">
          <TriangleAlert size={16} strokeWidth={1.5} />
          <span>
            <strong>The chat assistant is not configured.</strong> {health.llm.problem}
          </span>
        </div>
      )}
    </>
  );
}

function StatusBar({ health, activity }: { health: Health | "offline" | null; activity: string | null }) {
  const up = health !== null && health !== "offline";
  const model = up ? health.modelServer : null;
  return (
    <footer className="statusbar">
      <span className="status-item" title={model?.url}>
        <i className={`dot ${model ? (model.reachable ? (model.busy ? "dot-busy" : "dot-ok") : "dot-bad") : ""}`} />
        {health === null ? "Connecting" : !model ? "Server offline" : !model.reachable ? "ACE-Step offline" : model.busy ? "ACE-Step working" : "ACE-Step ready"}
      </span>
      {activity && <span className="status-item">{activity}</span>}
      <span className="spacer" />
      {up && (
        <span className="status-item" title="The chat model the assistant runs on">
          {llmLabel(health.llm)}
        </span>
      )}
    </footer>
  );
}

export function App() {
  const { projectId } = useRoute();
  const health = useHealth();
  const [activity, setActivity] = useState<string | null>(null);
  const llm = health && health !== "offline" ? health.llm : null;
  useEffect(() => {
    if (!projectId) setActivity(null);
  }, [projectId]);
  return (
    <div className="app">
      <div className="banners">
        <Banners health={health} />
      </div>
      {projectId ? <ProjectView key={projectId} projectId={projectId} llm={llm} onActivity={setActivity} /> : <ProjectList />}
      <StatusBar health={health} activity={activity} />
    </div>
  );
}

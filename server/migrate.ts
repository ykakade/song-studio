// One-time move from the old SQLite storage (<dataDir>/studio.db + <dataDir>/audio/)
// to project folders. Runs at startup when studio.db exists and has not been
// migrated yet. Nothing old is deleted: studio.db is renamed to studio.db.migrated
// and the old audio files are copied, not moved.

import { copyFileSync, existsSync, renameSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ProjectStore, slugify } from "./store.ts";
import type { ChatContent, Marker, Take } from "./types.ts";

function parse<T>(json: unknown, fallback: T): T {
  return typeof json === "string" && json ? (JSON.parse(json) as T) : fallback;
}

export function migrateFromSqlite(dataDir: string, store: ProjectStore): { projects: number; takes: number } | null {
  const dbFile = path.join(dataDir, "studio.db");
  if (!existsSync(dbFile)) return null;
  const db = new DatabaseSync(dbFile, { readOnly: true });
  let projects = 0;
  let takes = 0;
  try {
    for (const p of db.prepare("SELECT * FROM projects ORDER BY created_at").all() as any[]) {
      let id = `${slugify(p.title)}-${String(p.id).replace(/^p_/, "").slice(0, 4)}`;
      if (store.getProject(id)) continue; // already migrated
      store.importProject(id, { title: p.title, createdAt: p.created_at, updatedAt: p.updated_at });
      projects++;
      for (const r of db.prepare("SELECT * FROM takes WHERE project_id = ? ORDER BY seq").all(p.id) as any[]) {
        // A take that was unfinished in the old app can never finish now.
        const unfinished = r.status === "queued" || r.status === "running";
        const take: Take = {
          id: r.id,
          projectId: id,
          seq: r.seq,
          parentTakeId: r.parent_take_id ?? null,
          rootTakeId: r.root_take_id,
          kind: r.kind,
          status: unfinished ? "failed" : r.status,
          params: parse(r.params_json, {} as Take["params"]),
          changeSummary: r.change_summary ?? "",
          durationSec: r.duration_sec ?? null,
          sampleRate: r.sample_rate ?? null,
          checks: parse(r.checks_json, null),
          error: unfinished ? "This take was unfinished when the project was moved to a folder." : (r.error ?? null),
          jobId: r.job_id ?? null,
          createdAt: r.created_at,
          finishedAt: r.finished_at ?? null,
        };
        let audioName: string | null = null;
        if (r.audio_file && take.status === "done") {
          const src = path.join(dataDir, "audio", r.audio_file);
          if (existsSync(src)) {
            audioName = path.basename(store.takePath(take, ".wav"));
            copyFileSync(src, store.takePath(take, ".wav"));
            const peaks = src.replace(/\.wav$/, ".peaks.json");
            if (existsSync(peaks)) copyFileSync(peaks, store.takePath(take, ".peaks.json"));
            const raw = src.replace(/\.wav$/, ".model-output.wav");
            if (existsSync(raw)) copyFileSync(raw, store.takePath(take, ".model-output.wav"));
          } else {
            take.status = "failed";
            take.error = "The audio file of this take was missing when the project was moved to a folder.";
          }
        }
        store.importTake(take, audioName);
        takes++;
      }
      const roots = new Map<string, Marker[]>();
      for (const m of db.prepare("SELECT * FROM markers WHERE project_id = ? ORDER BY root_take_id, position").all(p.id) as any[]) {
        const list = roots.get(m.root_take_id) ?? [];
        list.push({ label: m.label, startSec: m.start_sec, endSec: m.end_sec });
        roots.set(m.root_take_id, list);
      }
      for (const [root, list] of roots) store.replaceMarkers(id, root, list);
      for (const m of db.prepare("SELECT * FROM messages WHERE project_id = ? ORDER BY id").all(p.id) as any[]) {
        store.importMessage(id, { id: m.id, createdAt: m.created_at, content: JSON.parse(m.content_json) as ChatContent, llm: parse(m.llm_json, null) });
      }
      const current = p.current_take_id && store.getTake(p.current_take_id)?.status === "done" ? p.current_take_id : null;
      store.updateProject(id, { currentTakeId: current, selection: parse(p.selection_json, null) });
      store.log(id, "migrated", { from: "studio.db", oldId: p.id });
    }
  } finally {
    db.close();
  }
  renameSync(dbFile, `${dbFile}.migrated`);
  for (const ext of ["-wal", "-shm"]) if (existsSync(dbFile + ext)) renameSync(dbFile + ext, `${dbFile}.migrated${ext}`);
  return { projects, takes };
}

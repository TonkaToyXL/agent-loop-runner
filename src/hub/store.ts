import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { EditableAgentFields, RateInfo, Task, UsageEvent } from "./types.js";

const MAX_TASKS = 1000;
const USAGE_DAYS = 62;

export interface PersistedState {
  version: 1;
  lead?: string;
  overrides: Record<string, Partial<EditableAgentFields>>;
  tasks: Task[];
  usage: UsageEvent[];
  rates: Record<string, RateInfo>;
}

export function defaultStatePath(): string {
  return process.env.RELAY_STATE ?? join(homedir(), ".local/share/agent-relay/hub/state.json");
}

/** Small JSON store with debounced, atomic writes. Fine for one user and thousands of tasks. */
export class Store {
  state: PersistedState;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly path = defaultStatePath()) {
    this.state = this.read();
  }

  private read(): PersistedState {
    const empty: PersistedState = { version: 1, overrides: {}, tasks: [], usage: [], rates: {} };
    if (!existsSync(this.path)) return empty;
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<PersistedState>;
      const tasks = (raw.tasks ?? []).map((t) =>
        // A hub restart orphans anything that was in flight.
        t.status === "running" || t.status === "queued"
          ? { ...t, status: "failed" as const, error: "Hub restarted before this finished.", finishedAt: new Date().toISOString() }
          : t,
      );
      return { ...empty, ...raw, tasks, version: 1 };
    } catch (err) {
      console.error(`[store] could not read ${this.path}, starting fresh:`, err);
      return empty;
    }
  }

  save(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 250);
  }

  flush(): void {
    const cutoff = Date.now() - USAGE_DAYS * 86_400_000;
    this.state.usage = this.state.usage.filter((e) => Date.parse(e.at) >= cutoff);
    if (this.state.tasks.length > MAX_TASKS) this.state.tasks = this.state.tasks.slice(-MAX_TASKS);
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, this.path);
  }
}

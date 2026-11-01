import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Workspace, WorkspaceSettings } from "../shared/api";

/** One ordered writer for default workspace snapshots and automatic preferences. */
export class WorkspaceStore {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly directory: () => string, private readonly parse: (value: unknown) => Workspace) {}

  async load(): Promise<Workspace | null> {
    await this.tail;
    const snapshot = await this.read("workspace.json");
    const preferences = await this.read("preferences.json");
    if (!preferences) return snapshot;
    return { ...preferences, slave: { servers: preferences.slave.servers, data: snapshot?.slave.data ?? [] } };
  }

  remember(settings: WorkspaceSettings): Promise<void> {
    const parsed = this.parse({ ...settings, slave: { servers: settings.slave?.servers, data: [] } });
    return this.enqueue(() => this.write("preferences.json", parsed));
  }

  save(workspace: Workspace): Promise<void> {
    const parsed = this.parse(workspace);
    return this.enqueue(async () => {
      await this.write("workspace.json", parsed);
      await this.write("preferences.json", { ...parsed, slave: { servers: parsed.slave.servers, data: [] } });
    });
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.tail.then(operation);
    // Keep later saves usable after failure; the current caller still receives the rejection.
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async read(name: string): Promise<Workspace | null> {
    try {
      return this.parse(JSON.parse(await fs.readFile(path.join(this.directory(), name), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw error;
    }
  }

  private async write(name: string, workspace: Workspace): Promise<void> {
    await writeWorkspaceFile(path.join(this.directory(), name), workspace);
  }
}

export async function writeWorkspaceFile(target: string, workspace: Workspace): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(workspace, null, 2)}\n`, "utf8");
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

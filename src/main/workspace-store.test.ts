import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../shared/api";
import { WorkspaceStore } from "./workspace-store";

let directory: string;
const example = (): Workspace => ({
  version: 2, connection: { kind: "tcp", host: "192.0.2.188", port: 502, timeoutMs: 1000 },
  draftRequest: { unitId: 1, functionCode: 3, address: 200, quantity: 1, valuesText: "" }, watches: [],
  slave: { servers: { tcp: { kind: "tcp", host: "192.0.2.20", port: 502 }, rtu: { kind: "rtu", path: "", baudRate: 9600, dataBits: 8, parity: "none", stopBits: 1 } },
    data: [{ unitId: 1, area: "holdingRegisters", address: 200, values: [2004] }] }
});
// Storage tests own ordering and disk semantics; IPC tests own schema validation.
const parse = (value: unknown): Workspace => JSON.parse(JSON.stringify(value)) as Workspace;
beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), "modbus-preferences-")); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }); });

describe("WorkspaceStore", () => {
  it("loads an existing manual workspace and overlays remembered parameters without erasing its data", async () => {
    const store = new WorkspaceStore(() => directory, parse);
    expect(await store.load()).toBeNull();
    await fs.writeFile(path.join(directory, "workspace.json"), JSON.stringify(example()));
    expect((await store.load())!.slave.data[0].values).toEqual([2004]);
    const next = example(); next.connection = { kind: "tcp", host: "192.0.2.99", port: 1502, timeoutMs: 2000 };
    await store.remember(next);
    const restarted = new WorkspaceStore(() => directory, parse);
    expect((await restarted.load())!.connection).toEqual(next.connection);
    expect((await restarted.load())!.slave.data[0].values).toEqual([2004]);
    expect(JSON.parse(await fs.readFile(path.join(directory, "preferences.json"), "utf8")).slave.data).toEqual([]);
  });

  it("serializes rapid automatic and manual saves, preserving the latest parameters and snapshot", async () => {
    const store = new WorkspaceStore(() => directory, parse);
    const earlier = example(), manual = example(), latest = example();
    earlier.draftRequest.address = 10; manual.draftRequest.address = 20; latest.draftRequest.address = 30;
    manual.slave.data[0].values = [1234];
    await Promise.all([store.remember(earlier), store.save(manual), store.remember(latest)]);
    const saved = await store.load();
    expect(saved!.draftRequest.address).toBe(30);
    expect(saved!.slave.data[0].values).toEqual([1234]);
    expect((await fs.readdir(directory)).sort()).toEqual(["preferences.json", "workspace.json"]);
  });

  it("propagates a failed replacement, preserves the old file and permits a later retry", async () => {
    const store = new WorkspaceStore(() => directory, parse);
    await store.remember(example());
    const original = await fs.readFile(path.join(directory, "preferences.json"), "utf8");
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("simulated rename failure"));
    const next = example(); next.draftRequest.address = 201;
    await expect(store.remember(next)).rejects.toThrow("simulated rename failure");
    expect(await fs.readFile(path.join(directory, "preferences.json"), "utf8")).toBe(original);
    await store.remember(next);
    expect((await store.load())!.draftRequest.address).toBe(201);
    expect((await fs.readdir(directory)).sort()).toEqual(["preferences.json"]);
  });

  it("reports a corrupted file instead of replacing it while loading", async () => {
    const file = path.join(directory, "preferences.json");
    await fs.writeFile(file, "{broken");
    const store = new WorkspaceStore(() => directory, parse);
    await expect(store.load()).rejects.toThrow();
    expect(await fs.readFile(file, "utf8")).toBe("{broken");
  });
});

import { describe, expect, it } from "vitest";
import type { WorkspaceView } from "./api";
import { parseWorkspaceView } from "./workspace-view";

const valid = (): WorkspaceView => ({ workbenchTab: "slave", channelTab: "slave", channelCollapsed: true, leftWidthPct: 52,
  decodeMode: "u16", slaveTransport: "tcp", numberBase: "dec", slavePage: { unitId: 1, area: "holdingRegisters", address: 200, quantity: 16 } });
describe("workspace view compatibility", () => {
  it("accepts legacy workspaces with no view and normalizes current view fields", () => {
    expect(parseWorkspaceView(undefined)).toBeUndefined();
    expect(parseWorkspaceView({...valid(), runAuthorization: "drop"})).toEqual(valid());
  });
  it("rejects out-of-range pages and non-finite widths", () => {
    expect(() => parseWorkspaceView({...valid(), leftWidthPct: NaN})).toThrow();
    expect(() => parseWorkspaceView({...valid(), slavePage:{...valid().slavePage,address:65535,quantity:2}})).toThrow();
    expect(() => parseWorkspaceView({...valid(), decodeMode:"other"})).toThrow();
    expect(() => parseWorkspaceView(null)).toThrow();
  });
});

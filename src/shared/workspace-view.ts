import type { WorkspaceView } from "./api";
import { ModbusProtocolError } from "./protocol";

export function parseWorkspaceView(value: unknown): WorkspaceView | undefined {
  if (value === undefined) return undefined;
  const view = value as Partial<WorkspaceView> | null;
  const page = view?.slavePage;
  if (!view || typeof view !== "object" ||
    !["master", "slave", "verify"].includes(view.workbenchTab!) ||
    !["master", "slave"].includes(view.channelTab!) || typeof view.channelCollapsed !== "boolean" ||
    typeof view.leftWidthPct !== "number" || !Number.isFinite(view.leftWidthPct) || view.leftWidthPct < 20 || view.leftWidthPct > 80 ||
    !["u16", "i16", "u32-be", "u32-swap", "i32-be", "i32-swap", "f32-be", "f32-swap", "ascii"].includes(view.decodeMode!) ||
    !["tcp", "rtu"].includes(view.slaveTransport!) || !["dec", "hex"].includes(view.numberBase!) ||
    !page || !Number.isInteger(page.unitId) || page.unitId < 1 || page.unitId > 247 ||
    !["coils", "discreteInputs", "holdingRegisters", "inputRegisters"].includes(page.area) ||
    !Number.isInteger(page.address) || page.address < 0 || !Number.isInteger(page.quantity) ||
    page.quantity < 1 || page.quantity > 64 || page.address + page.quantity > 65536) {
    throw new ModbusProtocolError("INVALID_WORKSPACE", "工作区界面配置无效。");
  }
  return {
    workbenchTab: view.workbenchTab!, channelTab: view.channelTab!, channelCollapsed: view.channelCollapsed,
    leftWidthPct: view.leftWidthPct, decodeMode: view.decodeMode!, slaveTransport: view.slaveTransport!,
    slavePage: { unitId: page.unitId, area: page.area, address: page.address, quantity: page.quantity }, numberBase: view.numberBase!
  };
}

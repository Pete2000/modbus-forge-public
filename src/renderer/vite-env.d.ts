/// <reference types="vite/client" />

import type { ModbusForgeApi } from "../shared/api";

declare global {
  interface Window {
    modbusForge: ModbusForgeApi;
  }
}

export {};

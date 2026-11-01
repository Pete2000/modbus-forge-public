import { describe, expect, it } from "vitest";
import type { RequestTrace } from "../shared/api";
import {
  buildDecodedRows,
  filterTraces,
  formatPlcAddressHint,
  formatTimestampMs,
  parseRegisterInput,
  summarizeServerWrites,
  requestFromDraft
} from "./workbench-utils";

describe("workbench-utils", () => {
  it("summarizes only timed TCP server writes in the current retained or filtered list", () => {
    const base: RequestTrace = {
      timestamp: "2020-01-01T02:00:00Z", transport: "tcp", role: "slave", rawRequest: "",
      request: { unitId: 1, functionCode: 16, address: 200, values: [2004] }, serverProcessingMs: 0.125
    };
    const traces: RequestTrace[] = [
      base,
      { ...base, serverProcessingMs: 1.875, error: { code: "TRANSPORT_ERROR", message: "failed" } },
      { ...base, request: { unitId: 1, functionCode: 3, address: 200, quantity: 1 } },
      { ...base, role: "master", elapsedMs: 500 },
      { ...base, transport: "rtu" },
      { ...base, serverProcessingMs: undefined },
      { ...base, serverProcessingMs: NaN },
      { ...base, serverProcessingMs: -1 }
    ];
    expect(summarizeServerWrites(traces)).toEqual({ samples: 2, errors: 1, latestMs: 0.125, averageMs: 1, maxMs: 1.875 });
    const successful = filterTraces(traces, { roleFilter: "all", statusFilter: "success", query: "" });
    expect(summarizeServerWrites(successful)).toMatchObject({ samples: 1, errors: 0, averageMs: 0.125 });
    expect(summarizeServerWrites([])).toEqual({ samples: 0, errors: 0, latestMs: null, averageMs: null, maxMs: null });
    expect(summarizeServerWrites([{ ...base, request: undefined, serverFunctionCode: 16, error: { code: "ILLEGAL_DATA_VALUE", message: "bad byte count" } }])).toMatchObject({ samples: 1, errors: 1, latestMs: 0.125 });
    expect(summarizeServerWrites([{ ...base, request: undefined }]).samples).toBe(0);
    for (const functionCode of [5, 6, 15, 16] as const) {
      expect(summarizeServerWrites([{ ...base, request: { unitId: 1, functionCode, address: 200, values: [1] } }]).samples).toBe(1);
    }
  });
  it("parses decimal and hexadecimal register inputs safely", () => {
    expect(parseRegisterInput("0", "dec")).toBe(0);
    expect(parseRegisterInput("65535", "dec")).toBe(65535);
    expect(parseRegisterInput("0x00FF", "dec")).toBe(255);
    expect(parseRegisterInput("00ff", "hex")).toBe(255);
    expect(() => parseRegisterInput("", "dec")).toThrow(/请输入/);
    expect(() => parseRegisterInput("65536", "dec")).toThrow(/超出范围/);
    expect(() => parseRegisterInput("-1", "dec")).toThrow();
  });

  it("constructs validated read and write requests from draft", () => {
    expect(
      requestFromDraft({ unitId: 1, functionCode: 3, address: 10, quantity: 4, valuesText: "" })
    ).toEqual({ unitId: 1, functionCode: 3, address: 10, quantity: 4 });

    expect(
      requestFromDraft({ unitId: 2, functionCode: 16, address: 100, quantity: 2, valuesText: "100, 0x00C8" })
    ).toEqual({ unitId: 2, functionCode: 16, address: 100, values: [100, 200] });

    expect(() =>
      requestFromDraft({ unitId: 1, functionCode: 6, address: 0, quantity: 1, valuesText: "1, 2" })
    ).toThrow(/FC 06/);
  });

  it("decodes 16-bit, 32-bit word-swapped, float32 and trailing unpaired registers", () => {
    const i16Rows = buildDecodedRows({ kind: "registers", values: [65535, 10] }, 100, "i16");
    expect(i16Rows[0]).toMatchObject({ addressLabel: "100", hexAddress: "0x0064", decoded: "-1" });
    expect(i16Rows[1]).toMatchObject({ addressLabel: "101", decoded: "10" });

    // IEEE 754 12.5 = 0x41480000 -> high=0x4148 (16712), low=0x0000 (0)
    const f32Be = buildDecodedRows({ kind: "registers", values: [0x4148, 0x0000] }, 20, "f32-be");
    expect(f32Be[0]).toMatchObject({ addressLabel: "20–21", decoded: "12.5" });

    const f32Swap = buildDecodedRows({ kind: "registers", values: [0x0000, 0x4148, 99] }, 20, "f32-swap");
    expect(f32Swap).toHaveLength(2);
    expect(f32Swap[0].decoded).toBe("12.5");
    expect(f32Swap[1].decoded).toContain("未配对");
  });

  it("formats PLC address hints and millisecond timestamps and filters traces", () => {
    expect(formatPlcAddressHint(3, 110)).toBe("0x006E · 参考 40111");
    expect(formatPlcAddressHint("coils", 0)).toBe("0x0000 · 参考 00001");
    expect(formatTimestampMs("2020-01-01T08:05:09.042Z")).toMatch(/^\d{2}:\d{2}:\d{2}\.042$/);

    const sampleTraces: RequestTrace[] = [
      {
        timestamp: "2020-01-01T08:00:00.100Z",
        transport: "tcp",
        role: "master",
        request: { unitId: 1, functionCode: 3, address: 110, quantity: 2 },
        rawRequest: "00 01 00 00 00 06 01 03 00 6E 00 02",
        rawResponse: "00 01 00 00 00 07 01 03 04 00 01 00 02"
      },
      {
        timestamp: "2020-01-01T08:00:01.250Z",
        transport: "rtu",
        role: "slave",
        rawRequest: "02 06 00 10 12 34",
        error: { code: "CRC_MISMATCH", message: "CRC 校验失败" }
      }
    ];

    expect(filterTraces(sampleTraces, { roleFilter: "master", statusFilter: "all", query: "" })).toHaveLength(1);
    expect(filterTraces(sampleTraces, { roleFilter: "all", statusFilter: "error", query: "crc" })).toHaveLength(1);
    expect(filterTraces(sampleTraces, { roleFilter: "all", statusFilter: "success", query: "@110" })).toHaveLength(1);
  });
});

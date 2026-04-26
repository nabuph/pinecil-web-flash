import { describe, expect, it } from "vitest";
import { buildDfuSeFile, crc32Dfu, parseDfuSeTargets, parseDfuSuffix } from "@/lib/protocol/dfu";

describe("DFU protocol helpers", () => {
  it("builds and parses a DfuSe file with valid CRC", () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const dfu = buildDfuSeFile(payload, 0x08004000);
    const suffix = parseDfuSuffix(dfu);
    const targets = parseDfuSeTargets(dfu);

    expect(suffix.crcValid).toBe(true);
    expect(suffix.idVendor).toBe(0x28e9);
    expect(targets[0].address).toBe(0x08004000);
    expect([...targets[0].bytes]).toEqual([...payload]);
  });

  it("computes deterministic DFU CRC values", () => {
    const data = new Uint8Array([0x44, 0x46, 0x55, 0x00]);
    expect(crc32Dfu(data)).toBe(crc32Dfu(data));
  });
});

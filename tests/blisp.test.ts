import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPinecilV2BootHeader, encodeBlispCommand, parseBlispFirmware, WebSerialBlispFlasher } from "@/lib/protocol/blisp";
import type { FlashInput } from "@/lib/types";

describe("BLISP helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(navigator, "serial", {
      configurable: true,
      value: undefined
    });
  });

  it("encodes BLISP packets with length and checksum", () => {
    const encoded = encodeBlispCommand(0x31, new Uint8Array([1, 2, 3]), true);
    expect([...encoded]).toEqual([0x31, 0x09, 0x03, 0x00, 1, 2, 3]);
  });

  it("normalizes Pinecil V2 firmware binaries to flash offset", () => {
    const input: FlashInput = {
      model: "v2",
      kind: "firmware",
      fileName: "Pinecilv2_EN.bin",
      bytes: new Uint8Array([1, 2, 3])
    };
    expect(parseBlispFirmware(input)).toMatchObject({ address: 0x2000, needsBootHeader: true });
  });

  it("builds a recognizable BL70x boot header shell", () => {
    const header = buildPinecilV2BootHeader();
    expect(new TextDecoder().decode(header.slice(0, 4))).toBe("BFNP");
    expect(header).toHaveLength(176);
  });

  it("rejects serial ports that do not answer the BLISP handshake", async () => {
    const close = vi.fn();
    const port = {
      open: vi.fn(async () => undefined),
      close,
      getInfo: () => ({}),
      readable: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        }
      }),
      writable: new WritableStream<Uint8Array>()
    };
    Object.defineProperty(navigator, "serial", {
      configurable: true,
      value: { requestPort: vi.fn(async () => port) }
    });

    await expect(new WebSerialBlispFlasher().connect()).rejects.toThrow(/closed|reading|BLISP|bootloader/i);
    expect(close).toHaveBeenCalledOnce();
  });

  it("accepts serial ports only after a BLISP bootloader response", async () => {
    const writes: Uint8Array[] = [];
    const chunks = [
      new Uint8Array([0x4f, 0x4b]),
      new Uint8Array([0x4f, 0x4b]),
      new Uint8Array([0x04, 0x00]),
      new Uint8Array([1, 2, 3, 4])
    ];
    const port = {
      open: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      getInfo: () => ({ usbVendorId: 0x1a86, usbProductId: 0x55d4 }),
      readable: new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = chunks.shift();
          if (chunk) controller.enqueue(chunk);
          else controller.close();
        }
      }),
      writable: new WritableStream<Uint8Array>({
        write(chunk) {
          writes.push(chunk);
        }
      })
    };
    Object.defineProperty(navigator, "serial", {
      configurable: true,
      value: { requestPort: vi.fn(async () => port) }
    });

    const target = await new WebSerialBlispFlasher().connect();

    expect(target).toMatchObject({
      model: "v2",
      transport: "webserial-blisp",
      label: "Pinecil V2 BL70x flash mode",
      portName: "USB 1a86:55d4"
    });
    // Handshake is: BOUFFALOLAB5555RESET probe (22 bytes) then 'U' burst
    // (600 bytes). Then command 0x10 once OK is seen.
    expect(writes[0]).toHaveLength(22);
    expect(new TextDecoder().decode(writes[0])).toBe("BOUFFALOLAB5555RESET\0\0");
    expect(writes[1]).toHaveLength(600);
    expect(writes[1]?.every((b) => b === 0x55)).toBe(true);
    expect(writes[2]).toEqual(encodeBlispCommand(0x10));
  });
});

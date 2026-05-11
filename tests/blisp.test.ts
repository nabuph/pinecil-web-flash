import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildLogoDfu,
  LOGO_ADDRESSES,
  LOGO_HEIGHT,
  LOGO_WIDTH
} from "@/lib/logo/generator";
import {
  buildPinecilV2BootHeader,
  BL70X_HANDSHAKE_BURST_BYTES,
  encodeBlispCommand,
  eraseResponseTimeoutMs,
  parseBlispFirmware,
  WebSerialBlispFlasher
} from "@/lib/protocol/blisp";
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

  it("normalizes Pinecil V2 firmware binaries to flash offset without rewriting the boot header", () => {
    const input: FlashInput = {
      model: "v2",
      kind: "firmware",
      fileName: "Pinecilv2_EN.bin",
      bytes: new Uint8Array([1, 2, 3])
    };
    // Native blisp identifies a Pinecil V2 .bin as needing a boot struct, but
    // the browser path leaves the installed boot header at 0x0000 untouched.
    expect(parseBlispFirmware(input)).toMatchObject({ address: 0x2000, needsBootHeader: false });
  });

  it("parses Pinecil V2 boot-logo DFUs to the model-specific logo offset", () => {
    const input: FlashInput = {
      model: "v2",
      kind: "bootLogo",
      fileName: "pinecil-v2-logo.dfu",
      bytes: buildLogoDfu("v2", new Uint8Array(LOGO_WIDTH * LOGO_HEIGHT))
    };

    expect(parseBlispFirmware(input)).toMatchObject({
      address: LOGO_ADDRESSES.v2,
      payload: expect.any(Uint8Array),
      needsBootHeader: false
    });
  });

  it("builds the BLISP BL70x boot header template", () => {
    const header = buildPinecilV2BootHeader();
    expect(new TextDecoder().decode(header.slice(0, 4))).toBe("BFNP");
    expect(new TextDecoder().decode(header.slice(8, 12))).toBe("FCFG");
    expect(header).toHaveLength(176);
    expect([...header.slice(100, 104)]).toEqual([0x00, 0x00, 0x00, 0x00]);
    expect([...header.slice(128, 132)]).toEqual([0x00, 0x20, 0x00, 0x00]);
    expect([...header.slice(132, 136)]).toEqual([0xef, 0xbe, 0xad, 0xde]);
    expect([...header.slice(164, 168)]).toEqual([0x00, 0x10, 0x00, 0x00]);
    expect([...header.slice(168, 172)]).toEqual([0x00, 0x20, 0x00, 0x00]);
    expect([...header.slice(172, 176)]).toEqual([0xef, 0xbe, 0xad, 0xde]);
  });

  it("allows full firmware erases to run well past the nominal BLISP sector timing", () => {
    // BLISP's BL70x flash config says 4K sectors erase in 300ms nominally.
    // The 184 KiB IronOS image is close enough to 15s that real hardware can
    // exceed it, so the browser path uses a scaled timeout with headroom.
    expect(eraseResponseTimeoutMs(184.2 * 1024)).toBeGreaterThan(45000);
    expect(eraseResponseTimeoutMs(4 * 1024)).toBe(30000);
  });

  it("rejects serial ports that do not answer the BLISP handshake", async () => {
    const close = vi.fn();
    const port = {
      open: vi.fn(async () => undefined),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
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
      new Uint8Array([1, 2, 3, 4]),
      new Uint8Array([0x4f, 0x4b]),
      new Uint8Array([0x04, 0x00]),
      new Uint8Array([0xff, 0xff, 0xff, 0xff])
    ];
    const port = {
      open: vi.fn(async () => undefined),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
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
      portName: "USB 1a86:55d4",
      bootRomVersion: "1.2.3.4"
    });
    // Handshake is: BOUFFALOLAB5555RESET probe (22 bytes) then blisp's
    // baud-derived 'U' burst. Then command 0x10 once OK is seen.
    expect(writes[0]).toHaveLength(22);
    expect(new TextDecoder().decode(writes[0])).toBe("BOUFFALOLAB5555RESET\0\0");
    expect(writes[1]).toHaveLength(BL70X_HANDSHAKE_BURST_BYTES);
    expect(writes[1]?.every((b) => b === 0x55)).toBe(true);
    expect(writes[2]).toEqual(encodeBlispCommand(0x10));
  });

  it("does not display the eflash_loader sentinel as a Boot ROM version", async () => {
    const chunks = [
      new Uint8Array([0x4f, 0x4b]),
      new Uint8Array([0x4f, 0x4b]),
      new Uint8Array([0x04, 0x00]),
      new Uint8Array([0xff, 0xff, 0xff, 0xff]),
      new Uint8Array([0x4f, 0x4b]),
      new Uint8Array([0x04, 0x00]),
      new Uint8Array([0xff, 0xff, 0xff, 0xff])
    ];
    const port = {
      open: vi.fn(async () => undefined),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      close: vi.fn(async () => undefined),
      getInfo: () => ({ usbVendorId: 0x1a86, usbProductId: 0x55d4 }),
      readable: new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = chunks.shift();
          if (chunk) controller.enqueue(chunk);
          else controller.close();
        }
      }),
      writable: new WritableStream<Uint8Array>()
    };
    Object.defineProperty(navigator, "serial", {
      configurable: true,
      value: { requestPort: vi.fn(async () => port) }
    });

    const target = await new WebSerialBlispFlasher().connect();

    expect(target.bootRomVersion).toBeUndefined();
  });

  it("keeps displaying a real Boot ROM version after reconnecting to the same port in eflash_loader", async () => {
    const sessions = [
      [
        new Uint8Array([0x4f, 0x4b]),
        new Uint8Array([0x4f, 0x4b]),
        new Uint8Array([0x04, 0x00]),
        new Uint8Array([9, 8, 7, 6]),
        new Uint8Array([0x4f, 0x4b]),
        new Uint8Array([0x04, 0x00]),
        new Uint8Array([0xff, 0xff, 0xff, 0xff])
      ],
      [
        new Uint8Array([0x4f, 0x4b]),
        new Uint8Array([0x4f, 0x4b]),
        new Uint8Array([0x04, 0x00]),
        new Uint8Array([0xff, 0xff, 0xff, 0xff]),
        new Uint8Array([0x4f, 0x4b]),
        new Uint8Array([0x04, 0x00]),
        new Uint8Array([0xff, 0xff, 0xff, 0xff])
      ]
    ];
    let activeChunks: Uint8Array[] = [];
    let activeReadable: ReadableStream<Uint8Array> | undefined;
    let activeWritable: WritableStream<Uint8Array> | undefined;
    const port = {
      open: vi.fn(async () => {
        const nextSession = sessions.shift();
        if (!nextSession) throw new Error("No mock serial session configured.");
        activeChunks = [...nextSession];
        activeReadable = new ReadableStream<Uint8Array>({
          pull(controller) {
            const chunk = activeChunks.shift();
            if (chunk) controller.enqueue(chunk);
            else controller.close();
          }
        });
        activeWritable = new WritableStream<Uint8Array>();
      }),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      close: vi.fn(async () => undefined),
      getInfo: () => ({ usbVendorId: 0x1a86, usbProductId: 0x55d4 }),
      get readable() {
        return activeReadable;
      },
      get writable() {
        return activeWritable;
      }
    };
    Object.defineProperty(navigator, "serial", {
      configurable: true,
      value: {
        getPorts: vi.fn(async () => [port]),
        requestPort: vi.fn()
      }
    });

    const first = new WebSerialBlispFlasher();
    const firstTarget = await first.connect();
    await first.close();

    const secondTarget = await new WebSerialBlispFlasher().connect();

    expect(firstTarget.bootRomVersion).toBe("9.8.7.6");
    expect(secondTarget.bootRomVersion).toBe("9.8.7.6");
  });

  it("auto-selects a previously authorized Pinecil V2 serial port", async () => {
    const chunks = [
      new Uint8Array([0x4f, 0x4b]),
      new Uint8Array([0x4f, 0x4b]),
      new Uint8Array([0x04, 0x00]),
      new Uint8Array([1, 2, 3, 4])
    ];
    const port = {
      open: vi.fn(async () => undefined),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      close: vi.fn(async () => undefined),
      getInfo: () => ({ usbVendorId: 0x1a86, usbProductId: 0x55d4 }),
      readable: new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = chunks.shift();
          if (chunk) controller.enqueue(chunk);
          else controller.close();
        }
      }),
      writable: new WritableStream<Uint8Array>()
    };
    const requestPort = vi.fn();
    Object.defineProperty(navigator, "serial", {
      configurable: true,
      value: {
        getPorts: vi.fn(async () => [port]),
        requestPort
      }
    });

    const target = await new WebSerialBlispFlasher().connect();

    expect(target.transport).toBe("webserial-blisp");
    expect(requestPort).not.toHaveBeenCalled();
    expect(port.open).toHaveBeenCalledOnce();
  });

  it("auto-selects the only previously authorized serial port when USB IDs are hidden", async () => {
    const chunks = [
      new Uint8Array([0x4f, 0x4b]),
      new Uint8Array([0x4f, 0x4b]),
      new Uint8Array([0x04, 0x00]),
      new Uint8Array([1, 2, 3, 4])
    ];
    const port = {
      open: vi.fn(async () => undefined),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      close: vi.fn(async () => undefined),
      getInfo: () => ({}),
      readable: new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = chunks.shift();
          if (chunk) controller.enqueue(chunk);
          else controller.close();
        }
      }),
      writable: new WritableStream<Uint8Array>()
    };
    const requestPort = vi.fn();
    Object.defineProperty(navigator, "serial", {
      configurable: true,
      value: {
        getPorts: vi.fn(async () => [port]),
        requestPort
      }
    });

    const target = await new WebSerialBlispFlasher().connect();

    expect(target.transport).toBe("webserial-blisp");
    expect(requestPort).not.toHaveBeenCalled();
    expect(port.open).toHaveBeenCalledOnce();
  });
});

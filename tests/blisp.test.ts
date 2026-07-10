import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildLogoDfu,
  LOGO_ADDRESSES,
  LOGO_HEIGHT,
  LOGO_WIDTH
} from "@/lib/logo/generator";
import {
  AmbiguousBlispWriteError,
  buildPinecilV2BootHeader,
  BL70X_HANDSHAKE_BURST_BYTES,
  encodeBlispCommand,
  eraseResponseTimeoutMs,
  PINECIL_V2_MAX_FIRMWARE_LENGTH,
  parseBlispFirmware,
  SerialBlispSession,
  validatePinecilV2BootHeader,
  writeBlispFlashChunkOnce,
  WebSerialBlispFlasher
} from "@/lib/protocol/blisp";
import type { FlashInput, FlashProgress } from "@/lib/types";

describe("BLISP helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    WebSerialBlispFlasher.onLog = () => undefined;
    WebSerialBlispFlasher.onWillReset = () => undefined;
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
      bytes: Uint8Array.from({ length: 4096 }, (_, index) => index & 0xff)
    };
    // Native blisp identifies a Pinecil V2 .bin as needing a boot struct, but
    // the browser path leaves the installed boot header at 0x0000 untouched.
    expect(parseBlispFirmware(input)).toMatchObject({ address: 0x2000, needsBootHeader: false });
  });

  it("rejects truncated, blank, and partition-overlapping Pinecil V2 firmware", () => {
    const input: FlashInput = {
      model: "v2",
      kind: "firmware",
      fileName: "Pinecilv2_EN.bin",
      bytes: new Uint8Array(3)
    };
    expect(() => parseBlispFirmware(input)).toThrow(/too small/i);
    expect(() => parseBlispFirmware({ ...input, bytes: new Uint8Array(4096).fill(0xff) })).toThrow(/blank/i);
    expect(() => parseBlispFirmware({
      ...input,
      bytes: new Uint8Array(PINECIL_V2_MAX_FIRMWARE_LENGTH + 1)
    })).toThrow(/reserved boot-logo region/i);
    expect(() => parseBlispFirmware({ ...input, model: "v1", bytes: new Uint8Array(4096) }))
      .toThrow(/only accepts Pinecil V2/i);
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
    expect(() => validatePinecilV2BootHeader(header)).not.toThrow();
  });

  it("rejects a boot header that cannot safely boot a payload-only update", () => {
    const wrongOffset = buildPinecilV2BootHeader();
    wrongOffset[128] = 0x00;
    wrongOffset[129] = 0x30;
    expect(() => validatePinecilV2BootHeader(wrongOffset)).toThrow(/points to/i);

    const hashEnforced = buildPinecilV2BootHeader();
    hashEnforced[118] &= ~0x02;
    expect(() => validatePinecilV2BootHeader(hashEnforced)).toThrow(/image hash/i);
  });

  it("never resends a flash_write whose acknowledgement is ambiguous", async () => {
    const command = vi.fn(async () => {
      throw new Error("Timed out reading from BLISP serial port.");
    });
    const receiveResponse = vi.fn(async () => {
      throw new Error("Timed out reading from BLISP serial port.");
    });
    const session = { command, receiveResponse, write: vi.fn(async () => undefined) };

    await expect(writeBlispFlashChunkOnce(session, 0x2000, new Uint8Array([1, 2, 3])))
      .rejects.toBeInstanceOf(AmbiguousBlispWriteError);
    expect(command).toHaveBeenCalledOnce();
    expect(receiveResponse).toHaveBeenCalledOnce();
  });

  it("uses one absolute response deadline across repeated pending frames", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const port = {
      open: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      getInfo: () => ({}),
      readable: new ReadableStream<Uint8Array>({
        start(nextController) {
          controller = nextController;
        }
      }),
      writable: new WritableStream<Uint8Array>()
    };
    const session = new SerialBlispSession(port as unknown as SerialPort);
    await session.open();
    const interval = setInterval(() => controller?.enqueue(new Uint8Array([0x50, 0x44])), 5);
    try {
      await expect(session.receiveResponse(false, 35)).rejects.toThrow(/Timed out reading from BLISP/i);
    } finally {
      clearInterval(interval);
      await session.close();
    }
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
    expect(close).toHaveBeenCalledTimes(2);
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
      portName: "USB 1a86:55d4"
    });
    expect(target.bootRomVersion).toBeUndefined();
    // State-aware connect first tries a U-only loader handshake, then uses
    // get_boot_info to classify the responder as ROM or eflash_loader.
    expect(writes).toHaveLength(2);
    expect(writes[0]).toHaveLength(BL70X_HANDSHAKE_BURST_BYTES);
    expect(writes[0]?.every((b) => b === 0x55)).toBe(true);
    expect(writes[1]).toEqual(encodeBlispCommand(0x10));
  });

  it("reopens with a clean RX boundary before falling back to the ROM reset handshake", async () => {
    const writesByOpen: Uint8Array[][] = [];
    let activeReadable: ReadableStream<Uint8Array> | undefined;
    let activeWritable: WritableStream<Uint8Array> | undefined;
    const sessions = [
      [],
      [
        new Uint8Array([0x4f, 0x4b]),
        new Uint8Array([0x4f, 0x4b]),
        new Uint8Array([0x04, 0x00]),
        new Uint8Array([1, 2, 3, 4])
      ]
    ];
    const port = {
      open: vi.fn(async () => {
        const chunks = sessions.shift();
        if (!chunks) throw new Error("No mock serial session configured.");
        const writes: Uint8Array[] = [];
        writesByOpen.push(writes);
        activeReadable = new ReadableStream<Uint8Array>({
          pull(controller) {
            const chunk = chunks.shift();
            if (chunk) controller.enqueue(chunk);
            else controller.close();
          }
        });
        activeWritable = new WritableStream<Uint8Array>({ write: (chunk) => { writes.push(chunk); } });
      }),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      close: vi.fn(async () => undefined),
      getInfo: () => ({ usbVendorId: 0x1a86, usbProductId: 0x55d4 }),
      get readable() { return activeReadable; },
      get writable() { return activeWritable; }
    };
    Object.defineProperty(navigator, "serial", {
      configurable: true,
      value: { requestPort: vi.fn(async () => port) }
    });

    await expect(new WebSerialBlispFlasher().connect()).resolves.toMatchObject({ model: "v2" });
    expect(port.open).toHaveBeenCalledTimes(2);
    expect(writesByOpen[0]).toHaveLength(1);
    expect(writesByOpen[0]?.[0]?.every((byte) => byte === 0x55)).toBe(true);
    expect(new TextDecoder().decode(writesByOpen[1]?.[0])).toBe("BOUFFALOLAB5555RESET\0\0");
    expect(writesByOpen[1]?.[1]?.every((byte) => byte === 0x55)).toBe(true);
    expect(writesByOpen[1]?.[2]).toEqual(encodeBlispCommand(0x10));
  });

  it("reads the installed IronOS version only when explicitly requested", async () => {
    const writes: Uint8Array[] = [];
    const versionBytes = new TextEncoder().encode("build v2.23");
    const chunks = [
      new Uint8Array([0x4f, 0x4b]),
      new Uint8Array([0x4f, 0x4b]),
      new Uint8Array([0x04, 0x00]),
      new Uint8Array([1, 2, 3, 4]),
      new Uint8Array([0x4f, 0x4b]),
      new Uint8Array([0x04, 0x00]),
      new Uint8Array([0xff, 0xff, 0xff, 0xff]),
      new Uint8Array([0x4f, 0x4b]),
      new Uint8Array([versionBytes.length, 0x00]),
      versionBytes
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

    const flasher = new WebSerialBlispFlasher();
    const target = await flasher.connect();
    const progress: FlashProgress[] = [];
    const result = await flasher.readInstalledFirmwareVersion((event) => progress.push(event));

    expect(target.installedFirmwareVersion).toBeUndefined();
    expect(result).toEqual({
      version: "v2.23",
      bytesScanned: versionBytes.length,
      bootRomVersion: "1.2.3.4"
    });
    expect(writes).toHaveLength(4);
    expect(writes[2]).toEqual(encodeBlispCommand(0x10));
    expect(writes[3]?.[0]).toBe(0x32);
    expect(progress.some((event) => event.message === "Scanning flash for installed IronOS version")).toBe(true);
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

  it("accepts an already-running eflash_loader that returns FL to get_boot_info", async () => {
    const writes: Uint8Array[] = [];
    const chunks = [
      new Uint8Array([0x4f, 0x4b]),
      new Uint8Array([0x46, 0x4c]),
      new Uint8Array([0x01, 0x00])
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
      writable: new WritableStream<Uint8Array>({ write: (chunk) => { writes.push(chunk); } })
    };
    Object.defineProperty(navigator, "serial", {
      configurable: true,
      value: { requestPort: vi.fn(async () => port) }
    });

    await expect(new WebSerialBlispFlasher().connect()).resolves.toMatchObject({
      transport: "webserial-blisp"
    });
    expect(writes).toHaveLength(2);
    expect(writes[0]?.every((byte) => byte === 0x55)).toBe(true);
    expect(writes[1]).toEqual(encodeBlispCommand(0x10));
  });

  it("does not expose cached Boot ROM versions on connect", async () => {
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
        requestPort: vi.fn(async () => port)
      }
    });

    const first = new WebSerialBlispFlasher();
    const firstTarget = await first.connect();
    await first.close();

    const secondTarget = await new WebSerialBlispFlasher().connect();

    expect(firstTarget.bootRomVersion).toBeUndefined();
    expect(secondTarget.bootRomVersion).toBeUndefined();
  });

  it("opens the picker when a Pinecil V2 serial port was previously authorized", async () => {
    const chunks = [
      new Uint8Array([0x4f, 0x4b]),
      new Uint8Array([0x4f, 0x4b]),
      new Uint8Array([0x04, 0x00]),
      new Uint8Array([1, 2, 3, 4])
    ];
    const authorizedPort = {
      open: vi.fn(async () => undefined),
      getInfo: () => ({ usbVendorId: 0x1a86, usbProductId: 0x55d4 })
    };
    const chosenPort = {
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
    const requestPort = vi.fn(async () => chosenPort);
    const onLog = vi.fn();
    WebSerialBlispFlasher.onLog = onLog;
    Object.defineProperty(navigator, "serial", {
      configurable: true,
      value: {
        getPorts: vi.fn(async () => [authorizedPort]),
        requestPort
      }
    });

    const target = await new WebSerialBlispFlasher().connect();

    expect(target.transport).toBe("webserial-blisp");
    expect(requestPort).toHaveBeenCalledOnce();
    expect(authorizedPort.open).not.toHaveBeenCalled();
    expect(chosenPort.open).toHaveBeenCalledOnce();
    expect(onLog).toHaveBeenCalledWith(
      "INFO",
      "Previously authorized Pinecil V2 USB serial port found; opening the picker so you can confirm it or choose another port."
    );
  });

  it("opens the picker instead of assuming the only previously authorized serial port is a Pinecil", async () => {
    const chunks = [
      new Uint8Array([0x4f, 0x4b]),
      new Uint8Array([0x4f, 0x4b]),
      new Uint8Array([0x04, 0x00]),
      new Uint8Array([1, 2, 3, 4])
    ];
    const authorizedPort = {
      open: vi.fn(async () => undefined),
      getInfo: () => ({})
    };
    const chosenPort = {
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
    const requestPort = vi.fn(async () => chosenPort);
    const onLog = vi.fn();
    WebSerialBlispFlasher.onLog = onLog;
    Object.defineProperty(navigator, "serial", {
      configurable: true,
      value: {
        getPorts: vi.fn(async () => [authorizedPort]),
        requestPort
      }
    });

    const target = await new WebSerialBlispFlasher().connect();

    expect(target.transport).toBe("webserial-blisp");
    expect(requestPort).toHaveBeenCalledOnce();
    expect(authorizedPort.open).not.toHaveBeenCalled();
    expect(chosenPort.open).toHaveBeenCalledOnce();
    expect(onLog).toHaveBeenCalledWith(
      "INFO",
      "Previously authorized USB serial port found; opening the picker so you can confirm it or choose another port."
    );
  });
});

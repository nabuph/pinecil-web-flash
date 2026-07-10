import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDfuSeFile, crc32Dfu, parseDfuSeTargets, parseDfuSuffix, WebUsbDfuFlasher } from "@/lib/protocol/dfu";

describe("DFU protocol helpers", () => {
  afterEach(() => {
    WebUsbDfuFlasher.onWillReset = () => undefined;
    Object.defineProperty(navigator, "usb", { configurable: true, value: undefined });
    vi.restoreAllMocks();
  });

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

  it("arms expected-disconnect handling only after every DFU data block is written", async () => {
    const status = new DataView(new ArrayBuffer(6));
    status.setUint8(0, 0);
    status.setUint8(4, 5);
    const controlTransferOut = vi.fn(async () => ({ status: "ok" as const, bytesWritten: 0 }));
    const device = {
      opened: true,
      configuration: {
        interfaces: [{
          interfaceNumber: 0,
          alternates: [{ alternateSetting: 0, interfaceClass: 0xfe, interfaceSubclass: 1 }]
        }]
      },
      productName: "Pinecil DFU",
      serialNumber: "test",
      open: vi.fn(async () => undefined),
      selectConfiguration: vi.fn(async () => undefined),
      claimInterface: vi.fn(async () => undefined),
      selectAlternateInterface: vi.fn(async () => undefined),
      releaseInterface: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      controlTransferOut,
      controlTransferIn: vi.fn(async () => ({ status: "ok" as const, data: status }))
    };
    const usb = {
      requestDevice: vi.fn(async () => device),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    };
    Object.defineProperty(navigator, "usb", { configurable: true, value: usb });

    let writesSeenWhenResetArmed = -1;
    WebUsbDfuFlasher.onWillReset = vi.fn(() => {
      writesSeenWhenResetArmed = controlTransferOut.mock.calls.length;
    });
    const flasher = new WebUsbDfuFlasher();
    await flasher.connect();
    const bytes = buildDfuSeFile(new Uint8Array([1, 2, 3, 4]), 0x08004000);
    await flasher.flash(
      { model: "v1", kind: "firmware", fileName: "Pinecil_EN.dfu", bytes },
      () => undefined
    );

    expect(WebUsbDfuFlasher.onWillReset).toHaveBeenCalledOnce();
    expect(writesSeenWhenResetArmed).toBe(controlTransferOut.mock.calls.length - 1);
  });
});

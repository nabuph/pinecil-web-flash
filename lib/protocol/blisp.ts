import { parseDfuSeTargets } from "@/lib/protocol/dfu";
import type { FlashInput, FlashProgress, FlashResult, FlashTarget, FlasherBackend } from "@/lib/types";

const DEFAULT_BAUD_RATE = 460_800;
const BL70X_FLASH_MAP_ADDR = 0x23000000;
const PINECIL_V2_FIRMWARE_OFFSET = 0x2000;
const MAX_WRITE_CHUNK = 2052;
type Bytes = Uint8Array<ArrayBufferLike>;

type BlispResponse = "OK" | "PD";

export function encodeBlispCommand(command: number, payload: Bytes = new Uint8Array(), addChecksum = false): Uint8Array {
  if (payload.length > 0xffff) throw new Error("BLISP payload is too large.");
  const out = new Uint8Array(4 + payload.length);
  out[0] = command & 0xff;
  out[2] = payload.length & 0xff;
  out[3] = (payload.length >>> 8) & 0xff;
  out.set(payload, 4);

  if (addChecksum) {
    let sum = out[2] + out[3];
    for (const byte of payload) sum += byte;
    out[1] = sum & 0xff;
  }
  return out;
}

function le32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = value & 0xff;
  out[1] = (value >>> 8) & 0xff;
  out[2] = (value >>> 16) & 0xff;
  out[3] = (value >>> 24) & 0xff;
  return out;
}

function concatBytes(parts: Bytes[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function parseBlispFirmware(input: FlashInput): { payload: Uint8Array; address: number; needsBootHeader: boolean } {
  if (input.kind === "bootLogo") {
    const targets = parseDfuSeTargets(input.bytes);
    const first = targets[0];
    if (!first) throw new Error("Boot-logo DFU did not contain any payload.");
    const normalizedAddress = first.address >= BL70X_FLASH_MAP_ADDR ? first.address - BL70X_FLASH_MAP_ADDR : first.address;
    return {
      payload: first.bytes,
      address: normalizedAddress,
      needsBootHeader: false
    };
  }

  return {
    payload: input.bytes,
    address: PINECIL_V2_FIRMWARE_OFFSET,
    needsBootHeader: true
  };
}

export function buildPinecilV2BootHeader(): Uint8Array {
  const header = new Uint8Array(176);
  header.set(new TextEncoder().encode("BFNP"), 0);
  header[4] = 0x01;
  header.set(new TextEncoder().encode("FCFG"), 8);
  header[120] = 0x01;
  header[121] = 0x00;
  header.set(le32(PINECIL_V2_FIRMWARE_OFFSET), 132);
  header[136] = 0xef;
  header[137] = 0xbe;
  header[138] = 0xad;
  header[139] = 0xde;
  return header;
}

class SerialBlispSession {
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private writer?: WritableStreamDefaultWriter<Uint8Array>;

  constructor(private readonly port: SerialPort) {}

  async open() {
    await this.port.open({
      baudRate: DEFAULT_BAUD_RATE,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      flowControl: "none"
    });
    if (!this.port.readable || !this.port.writable) throw new Error("Serial port did not expose readable and writable streams.");
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
  }

  async close() {
    await this.reader?.cancel().catch(() => undefined);
    this.reader?.releaseLock();
    this.writer?.releaseLock();
    await this.port.close();
  }

  async write(bytes: Uint8Array) {
    if (!this.writer) throw new Error("Serial writer is not open.");
    await this.writer.write(bytes);
  }

  async readExact(length: number, timeoutMs = 1000): Promise<Uint8Array> {
    if (!this.reader) throw new Error("Serial reader is not open.");
    const out = new Uint8Array(length);
    let offset = 0;
    const timeout = Date.now() + timeoutMs;
    while (offset < length) {
      const remaining = timeout - Date.now();
      if (remaining <= 0) throw new Error("Timed out reading from BLISP serial port.");
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        this.reader.read(),
        new Promise<"timeout">((resolve) => {
          timeoutId = setTimeout(() => resolve("timeout"), remaining);
        })
      ]);
      if (timeoutId) clearTimeout(timeoutId);
      if (result === "timeout") {
        await this.reader.cancel().catch(() => undefined);
        throw new Error("Timed out reading from BLISP serial port.");
      }
      if (result.done || !result.value) throw new Error("Serial port closed while reading.");
      const slice = result.value.slice(0, length - offset);
      out.set(slice, offset);
      offset += slice.length;
    }
    return out;
  }

  async command(command: number, payload: Bytes = new Uint8Array(), checksum = false, expectPayload = false): Promise<Uint8Array> {
    await this.write(encodeBlispCommand(command, payload, checksum));
    return this.receiveResponse(expectPayload);
  }

  async receiveResponse(expectPayload: boolean): Promise<Uint8Array> {
    for (;;) {
      const head = await this.readExact(2, 1200);
      const code = new TextDecoder().decode(head) as BlispResponse | "FL";
      if (code === "PD") continue;
      if (code === "FL") {
        const err = await this.readExact(2, 200);
        throw new Error(`BLISP device returned failure ${err[0] | (err[1] << 8)}.`);
      }
      if (code !== "OK") throw new Error(`Unexpected BLISP response ${Array.from(head).join(" ")}.`);
      if (!expectPayload) return new Uint8Array();
      const sizeBytes = await this.readExact(2, 200);
      const size = sizeBytes[0] | (sizeBytes[1] << 8);
      return this.readExact(size, 200);
    }
  }
}

export class WebSerialBlispFlasher implements FlasherBackend {
  private port?: SerialPort;
  private session?: SerialBlispSession;
  private bootloaderReady = false;

  async connect(): Promise<FlashTarget> {
    if (!navigator.serial) throw new Error("Web Serial is not available in this browser.");
    this.port = await navigator.serial.requestPort();
    this.session = new SerialBlispSession(this.port);
    try {
      await this.session.open();
      await this.handshake();
      this.bootloaderReady = true;
    } catch (err) {
      await this.close().catch(() => undefined);
      throw err;
    }
    return {
      model: "v2",
      transport: "webserial-blisp",
      label: "Pinecil V2 BL70x flash mode",
      portName: serialPortLabel(this.port),
      connectedAt: new Date().toISOString()
    };
  }

  async flash(input: FlashInput, onProgress: (event: FlashProgress) => void): Promise<FlashResult> {
    if (!this.session) throw new Error("No BLISP serial session is connected.");
    const firmware = parseBlispFirmware(input);
    const total = firmware.payload.length + (firmware.needsBootHeader ? 176 : 0);
    onProgress({ phase: "flash", message: "Preparing BL70x flash session", current: 0, total });

    if (!this.bootloaderReady) {
      await this.handshake(onProgress);
      this.bootloaderReady = true;
    } else {
      onProgress({ phase: "detect", message: "BL70x flash session ready", current: 1, total: 1 });
    }
    if (firmware.needsBootHeader) {
      const bootHeader = buildPinecilV2BootHeader();
      await this.eraseAndWrite(0, bootHeader, total, 0, onProgress);
    }
    const baseProgress = firmware.needsBootHeader ? 176 : 0;
    await this.eraseAndWrite(firmware.address, firmware.payload, total, baseProgress, onProgress);

    await this.session.command(0x3a, new Uint8Array(), true);
    onProgress({ phase: "verify", message: "BLISP program check returned OK", current: total, total, level: "success" });
    await this.session.command(0x21, new Uint8Array(), true).catch(() => undefined);
    return { ok: true, message: "BLISP transfer completed.", verifySummary: "Program check returned OK." };
  }

  async close(): Promise<void> {
    await this.session?.close();
    this.session = undefined;
    this.port = undefined;
    this.bootloaderReady = false;
  }

  private async handshake(onProgress?: (event: FlashProgress) => void) {
    if (!this.session) throw new Error("No BLISP serial session is connected.");
    onProgress?.({ phase: "detect", message: "Sending BLISP handshake", current: 0, total: 1 });
    await this.session.write(new Uint8Array(600).fill("U".charCodeAt(0)));
    await this.session.receiveResponse(false);
    const bootInfo = await this.session.command(0x10, new Uint8Array(), false, true);
    onProgress?.({
      phase: "detect",
      message: `Boot ROM ${Array.from(bootInfo.slice(0, 4)).join(".") || "detected"}`,
      current: 1,
      total: 1
    });
  }

  private async eraseAndWrite(
    address: number,
    bytes: Uint8Array,
    total: number,
    baseProgress: number,
    onProgress: (event: FlashProgress) => void
  ) {
    if (!this.session) throw new Error("No BLISP serial session is connected.");
    await this.session.command(0x30, concatBytes([le32(address), le32(address + bytes.length)]), true);
    let sent = 0;
    for (let offset = 0; offset < bytes.length; offset += MAX_WRITE_CHUNK) {
      const chunk = bytes.slice(offset, offset + MAX_WRITE_CHUNK);
      await this.session.command(0x31, concatBytes([le32(address + offset), chunk]), true);
      sent += chunk.length;
      onProgress({
        phase: "flash",
        message: `Writing ${sent.toLocaleString()} of ${bytes.length.toLocaleString()} bytes`,
        current: baseProgress + sent,
        total
      });
    }
  }
}

function serialPortLabel(port: SerialPort): string {
  const info = port.getInfo();
  const vendor = info.usbVendorId?.toString(16).padStart(4, "0") ?? "unknown";
  const product = info.usbProductId?.toString(16).padStart(4, "0") ?? "unknown";
  return `USB ${vendor}:${product}`;
}

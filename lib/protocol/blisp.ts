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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Scan a handshake response for the bytes 'O' 'K' anywhere in the buffer.
// blisp's reference implementation does the same loop because the chip may
// echo our 'U' bytes (or send other padding) ahead of the actual OK.
function findOkInResponse(bytes: Uint8Array): number {
  for (let index = 0; index + 1 < bytes.length; index += 1) {
    if (bytes[index] === 0x4f /* 'O' */ && bytes[index + 1] === 0x4b /* 'K' */) return index;
  }
  return -1;
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
  // Bytes received from the chip but not yet consumed by readChunk/readExact.
  // Without this buffer, racing reader.read() against a setTimeout silently
  // drops chunks when the timeout fires first while data is in flight, which
  // can cause "the chip responded but we never saw the bytes" symptoms.
  private buffer = new Uint8Array(0);
  // Pending reader.read() promise carried across pullMore() calls so that a
  // chunk arriving just after a timeout is not lost; the next pullMore awaits
  // the same outstanding read.
  private pendingRead?: Promise<ReadableStreamReadResult<Uint8Array>>;
  private streamClosed = false;

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
    // Chrome's Web Serial leaves DTR and RTS deasserted by default. The macOS
    // USB CDC driver path can hold writes from reaching the device until DTR
    // is asserted; libserialport (used by the blisp CLI) asserts both by
    // default, so mirror that. setSignals isn't supported on every browser
    // version, so swallow errors here.
    try {
      await this.port.setSignals?.({ dataTerminalReady: true, requestToSend: true });
    } catch {
      /* ignore */
    }
  }

  async close() {
    this.streamClosed = true;
    await this.reader?.cancel().catch(() => undefined);
    this.reader?.releaseLock();
    this.writer?.releaseLock();
    await this.port.close();
  }

  async write(bytes: Uint8Array) {
    if (!this.writer) throw new Error("Serial writer is not open.");
    await this.writer.write(bytes);
  }

  // Wait up to timeoutMs for more bytes from the reader and append them to
  // the internal buffer. Returns true if any bytes arrived, false on timeout
  // or stream close. Crucially, if the timeout fires while a reader.read()
  // is still in flight we keep the same Promise around so that the chunk it
  // eventually delivers is appended on the next pullMore() instead of being
  // dropped on the floor.
  private async pullMore(timeoutMs: number): Promise<boolean> {
    if (!this.reader) throw new Error("Serial reader is not open.");
    if (this.streamClosed) return false;
    if (!this.pendingRead) {
      this.pendingRead = this.reader.read();
    }
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      this.pendingRead.then((r) => ({ kind: "data" as const, r })),
      new Promise<{ kind: "timeout" }>((resolve) => {
        timeoutId = setTimeout(() => resolve({ kind: "timeout" }), Math.max(0, timeoutMs));
      })
    ]);
    if (timeoutId) clearTimeout(timeoutId);
    if (result.kind === "timeout") return false;
    this.pendingRead = undefined;
    if (result.r.done || !result.r.value) {
      this.streamClosed = true;
      return false;
    }
    if (result.r.value.length > 0) {
      const merged = new Uint8Array(this.buffer.length + result.r.value.length);
      merged.set(this.buffer);
      merged.set(result.r.value, this.buffer.length);
      this.buffer = merged;
    }
    return true;
  }

  // Single-shot non-destructive read. Returns whatever bytes are buffered or
  // arrive within the timeout (possibly empty). Does not cancel the reader,
  // so the session stays usable for retries.
  async readChunk(timeoutMs: number): Promise<Uint8Array> {
    if (this.buffer.length === 0) {
      await this.pullMore(timeoutMs);
    }
    const out = this.buffer;
    this.buffer = new Uint8Array(0);
    return out;
  }

  async readExact(length: number, timeoutMs = 1000): Promise<Uint8Array> {
    const deadline = Date.now() + timeoutMs;
    while (this.buffer.length < length) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("Timed out reading from BLISP serial port.");
      const got = await this.pullMore(remaining);
      if (!got && this.buffer.length < length) {
        if (this.streamClosed) throw new Error("Serial port closed while reading.");
        if (Date.now() >= deadline) throw new Error("Timed out reading from BLISP serial port.");
      }
    }
    const out = this.buffer.slice(0, length);
    this.buffer = this.buffer.slice(length);
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
  private bootRomVersion?: string;

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
      // The BL70x ROM bootloader only accepts the handshake for a few seconds
      // after entry. If the user spent too long in the picker the iron has
      // already exited bootloader mode by the time we send the U-burst, and
      // the handshake just times out reading. Translate the raw timeout into
      // something actionable. Wrong-port selection lands here too, with the
      // same recovery (re-enter bootloader, pick the right port).
      if (err instanceof Error && /Timed out reading from BLISP/.test(err.message)) {
        // Preserve the raw byte tail from the handshake so we can tell whether
        // the chip stayed silent or sent garbage (which indicates a different
        // bootloader/firmware on the port).
        const tail = err.message.replace(/^Timed out reading from BLISP serial port\.?\s*/, "").trim();
        throw new Error(
          "The selected serial port did not respond as a Pinecil V2 BL70x bootloader. " +
            "Re-enter bootloader mode (hold the [-] button while plugging USB-C in; keep holding for 10–15 seconds; then release; the screen stays black) and try again." +
            (tail ? ` (${tail})` : "")
        );
      }
      throw err;
    }
    return {
      model: "v2",
      transport: "webserial-blisp",
      label: "Pinecil V2 BL70x flash mode",
      portName: serialPortLabel(this.port),
      bootloader: "BL70x",
      bootRomVersion: this.bootRomVersion,
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
    this.bootRomVersion = undefined;
  }

  private async handshake(onProgress?: (event: FlashProgress) => void) {
    if (!this.session) throw new Error("No BLISP serial session is connected.");
    onProgress?.({ phase: "detect", message: "Sending BLISP handshake", current: 0, total: 1 });

    // BL70x over USB CDC needs a wake-up probe before the 'U' burst, otherwise
    // the ROM bootloader stays silent and the read times out. blisp's lib
    // sends "BOUFFALOLAB5555RESET\0\0" first, then a baud-rate-locking burst
    // of 0x55 ('U') bytes (~138 bytes for BL70x at 460800 baud — capped at
    // 600). It then reads up to 20 bytes and scans for "OK" anywhere in the
    // response, retrying up to 5 times. We mirror that exactly.
    // See https://github.com/pine64/blisp/blob/master/lib/blisp.c#L190
    const RESET_PROBE = new TextEncoder().encode("BOUFFALOLAB5555RESET\0\0");
    const U_BURST = new Uint8Array(600).fill(0x55);

    let lastResponse = new Uint8Array();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await this.session.write(RESET_PROBE);
      // blisp calls sp_drain on macOS between writes to make sure the kernel
      // has actually pushed the bytes onto the wire before the next chunk.
      // Web Serial has no drain primitive, so a small delay approximates it.
      await delay(20);
      await this.session.write(U_BURST);
      await delay(20);
      // Drain up to 20 bytes within 200ms. Stop early once we see "OK" so
      // that subsequent reads start from a clean response boundary.
      const accumulated: number[] = [];
      const deadline = Date.now() + 200;
      while (accumulated.length < 20 && Date.now() < deadline) {
        const chunk = await this.session.readChunk(deadline - Date.now());
        if (chunk.length === 0) break;
        for (const byte of chunk) accumulated.push(byte);
        const view = new Uint8Array(accumulated);
        if (findOkInResponse(view) >= 0) {
          lastResponse = view;
          break;
        }
      }
      const view = new Uint8Array(accumulated);
      lastResponse = view;
      if (findOkInResponse(view) >= 0) {
        const bootInfo = await this.session.command(0x10, new Uint8Array(), false, true);
        // First 4 bytes of the boot info payload are the BL70x ROM version.
        // Stored on the instance so connect() can put it on the FlashTarget
        // for the UI to display.
        this.bootRomVersion = bootInfo.length >= 4
          ? Array.from(bootInfo.slice(0, 4)).join(".")
          : undefined;
        onProgress?.({
          phase: "detect",
          message: `Boot ROM ${this.bootRomVersion ?? "detected"}`,
          current: 1,
          total: 1
        });
        return;
      }
    }
    const tail = lastResponse.length
      ? ` Last bytes: ${Array.from(lastResponse).map((b) => b.toString(16).padStart(2, "0")).join(" ")}.`
      : " No bytes received from the chip.";
    throw new Error(`Timed out reading from BLISP serial port.${tail}`);
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

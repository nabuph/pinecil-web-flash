import { validateLogoDfuFile } from "@/lib/logo/validation";
import {
  flashWriteChunkSize,
  findIronOsVersionInFlash,
  loadEflashLoader,
  patchBl70xEflashLoader
} from "@/lib/protocol/blisp-eflash";
import type { FlashInput, FlashProgress, FlashResult, FlashTarget, FlasherBackend } from "@/lib/types";

const DEFAULT_BAUD_RATE = 460_800;
const BL70X_HANDSHAKE_BYTE_MULTIPLIER = 0.003;
export const BL70X_HANDSHAKE_BURST_BYTES = Math.min(
  600,
  Math.floor((BL70X_HANDSHAKE_BYTE_MULTIPLIER * DEFAULT_BAUD_RATE) / 10)
);
type SerialPortFilterLike = { usbVendorId: number; usbProductId?: number };
type WebSerial = NonNullable<Navigator["serial"]>;

const PINECIL_V2_SERIAL_FILTERS: SerialPortFilterLike[] = [
  { usbVendorId: 0x1a86, usbProductId: 0x55d4 }
];
const PINECIL_V2_FIRMWARE_OFFSET = 0x2000;
const BL70X_FLASH_SECTOR_SIZE = 4096;
const BL70X_ERASE_TIME_PER_SECTOR_MS = 300;
const BL70X_MIN_ERASE_RESPONSE_TIMEOUT_MS = 30000;
const BL70X_MAX_ERASE_RESPONSE_TIMEOUT_MS = 120000;
const BL70X_FLASH_WRITE_TIMEOUT_MS = 3000;
const BL70X_FLASH_WRITE_LATE_OK_TIMEOUT_MS = 2000;
const BL70X_FLASH_WRITE_RETRY_ATTEMPTS = 3;
const BL70X_FLASH_WRITE_RETRY_DRAIN_MS = 150;
const BL70X_FLASH_WRITE_RETRY_DELAY_MS = 50;
const BL70X_FLASH_WRITE_INTER_CHUNK_DELAY_MS = 10;
const BL70X_POST_ERASE_SETTLE_MS = 100;
const BL70X_PROGRAM_CHECK_TIMEOUT_MS = 120000;
const BL70X_WRITE_PROGRESS_INTERVAL_BYTES = 16 * 1024;
const BLISP_WRITE_FLUSH_YIELD_MS = 5;
const BLISP_SERIAL_BUFFER_SIZE = 64 * 1024;
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

function elapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

function isBlispFailureError(err: unknown): boolean {
  return err instanceof Error && /BLISP device returned failure/.test(err.message);
}

function isKnownPinecilV2SerialPort(port: SerialPort): boolean {
  const info = port.getInfo();
  return PINECIL_V2_SERIAL_FILTERS.some((filter) =>
    info.usbVendorId === filter.usbVendorId &&
      (filter.usbProductId === undefined || info.usbProductId === filter.usbProductId)
  );
}

async function selectPinecilV2SerialPort(serial: WebSerial): Promise<{ port: SerialPort; autoSelected: boolean }> {
  const authorizedPorts = typeof serial.getPorts === "function"
    ? await serial.getPorts().catch(() => [])
    : [];
  const matches = authorizedPorts.filter(isKnownPinecilV2SerialPort);
  if (matches.length === 1) {
    return { port: matches[0], autoSelected: true };
  }
  if (matches.length === 0 && authorizedPorts.length === 1) {
    WebSerialBlispFlasher.onLog(
      "INFO",
      "Using the only previously authorized USB serial port."
    );
    return { port: authorizedPorts[0], autoSelected: true };
  }
  if (matches.length > 1) {
    WebSerialBlispFlasher.onLog(
      "INFO",
      "Multiple previously authorized Pinecil V2 serial ports are available; opening the picker."
    );
  }
  return {
    // Keep the manual picker broad: some OS/browser combinations expose the
    // Pinecil's USB CDC bridge with a different PID than getInfo() reports
    // after permission is granted.
    port: await serial.requestPort(),
    autoSelected: false
  };
}

export function eraseResponseTimeoutMs(byteLength: number): number {
  const sectorCount = Math.max(1, Math.ceil(byteLength / BL70X_FLASH_SECTOR_SIZE));
  const estimatedMs = sectorCount * BL70X_ERASE_TIME_PER_SECTOR_MS;
  return Math.min(
    BL70X_MAX_ERASE_RESPONSE_TIMEOUT_MS,
    Math.max(BL70X_MIN_ERASE_RESPONSE_TIMEOUT_MS, estimatedMs * 4)
  );
}

// Fetches the BL70x eflash_loader.bin from the same-origin static path. The
// bytes ship with the deploy under public/protocol/. Same-origin avoids the
// CORS problem we'd hit reaching out to GitHub for it. Tests can replace
// WebSerialBlispFlasher.eflashLoaderProvider with a mock to avoid I/O.
async function defaultEflashLoaderProvider(): Promise<Uint8Array> {
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  const url = `${basePath}/protocol/bl70x_eflash_loader.bin`;
  const res = await fetch(url, { cache: "force-cache" });
  if (!res.ok) throw new Error(`Failed to fetch eflash_loader (${res.status} ${res.statusText}).`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  patchBl70xEflashLoader(bytes);
  return bytes;
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
    const logo = validateLogoDfuFile(input.bytes, input.model);
    return {
      payload: logo.bytes,
      address: logo.address,
      needsBootHeader: false
    };
  }

  // Plain Pinecil V2 IronOS .bin files contain the firmware payload that the
  // existing BL70x boot header already points at. Native blisp generates and
  // rewrites a boot header for this format; the browser path intentionally
  // leaves 0x0000 untouched so a Web Serial stall cannot replace a known-good
  // header with a partially tested one.
  return {
    payload: input.bytes,
    address: PINECIL_V2_FIRMWARE_OFFSET,
    needsBootHeader: false
  };
}

export function buildPinecilV2BootHeader(): Uint8Array {
  // Mirrors blisp's fill_up_boot_header() defaults for BL70x/Pinecil V2.
  return new Uint8Array([
    0x42, 0x46, 0x4e, 0x50, 0x01, 0x00, 0x00, 0x00,
    0x46, 0x43, 0x46, 0x47, 0x11, 0x00, 0x01, 0x01,
    0x66, 0x99, 0xff, 0x03, 0x9f, 0x00, 0x9f, 0x00,
    0x04, 0xc2, 0x00, 0x01, 0xc7, 0x20, 0x52, 0xd8,
    0x06, 0x02, 0x32, 0x00, 0x0b, 0x01, 0x0b, 0x01,
    0x3b, 0x01, 0xbb, 0x00, 0x6b, 0x01, 0xeb, 0x02,
    0xeb, 0x02, 0x02, 0x50, 0x00, 0x01, 0x00, 0x01,
    0x01, 0x00, 0x02, 0x01, 0x02, 0x01, 0xab, 0x01,
    0x05, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
    0x38, 0xff, 0x00, 0xff, 0x77, 0x03, 0x02, 0x40,
    0x77, 0x03, 0x02, 0xf0, 0x2c, 0x01, 0xb0, 0x04,
    0xb0, 0x04, 0x05, 0x00, 0xff, 0xff, 0x14, 0x00,
    0x2a, 0x76, 0x3c, 0xe4, 0x00, 0x00, 0x00, 0x00,
    0x01, 0x04, 0x00, 0x01, 0x03, 0x00, 0x00, 0x00,
    0xba, 0x7d, 0x12, 0x72, 0x00, 0x03, 0x03, 0x00,
    0xa8, 0xcd, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x20, 0x00, 0x00, 0xef, 0xbe, 0xad, 0xde,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x00,
    0x00, 0x20, 0x00, 0x00, 0xef, 0xbe, 0xad, 0xde
  ]);
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
      bufferSize: BLISP_SERIAL_BUFFER_SIZE,
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
    try { this.reader?.releaseLock(); } catch { /* ignore */ }
    try { this.writer?.releaseLock(); } catch { /* ignore */ }
    await this.port.close().catch(() => undefined);
  }

  async write(bytes: Uint8Array) {
    if (!this.writer) throw new Error("Serial writer is not open.");
    const frame = bytes.slice();
    await this.writer.ready;
    await this.writer.write(frame);
    await this.writer.ready;
    await delay(BLISP_WRITE_FLUSH_YIELD_MS);
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

  async command(
    command: number,
    payload: Bytes = new Uint8Array(),
    checksum = false,
    expectPayload = false,
    responseTimeoutMs = 1200
  ): Promise<Uint8Array> {
    await this.write(encodeBlispCommand(command, payload, checksum));
    return this.receiveResponse(expectPayload, responseTimeoutMs);
  }

  async receiveResponse(expectPayload: boolean, headTimeoutMs = 1200): Promise<Uint8Array> {
    for (;;) {
      const head = await this.readExact(2, headTimeoutMs);
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
  // Set true once the eflash_loader RAM app is running and we've completed
  // the post-load handshake against it. The eflash_loader exposes the actual
  // flash erase/write/read commands that the bare BL70x ROM does not.
  private eflashLoaderReady = false;
  private bootRomVersion?: string;
  private installedFirmwareVersion?: string;
  // Optional injection seam used by tests so they don't have to mock fetch.
  // Production runtime fetches `${basePath}/protocol/bl70x_eflash_loader.bin`.
  static eflashLoaderProvider: () => Promise<Uint8Array> = defaultEflashLoaderProvider;
  // Static log sink so app-shell can surface BLISP-internal progress and
  // soft errors without us having to plumb a callback through every method.
  // Defaults to a no-op; app-shell installs an addLog adapter at mount.
  static onLog: (
    level: "INFO" | "OK" | "WARN" | "ERROR",
    message: string,
    options?: { trace?: boolean }
  ) => void =
    () => undefined;
  // Fired when the underlying SerialPort raises a 'disconnect' event (e.g.
  // the user pulled the USB cable). app-shell uses this to clear connected
  // state instead of waiting for the next operation to fail.
  static onDisconnect: (source: WebSerialBlispFlasher) => void = () => undefined;
  private disconnectListener?: () => void;

  async connect(): Promise<FlashTarget> {
    if (!navigator.serial) throw new Error("Web Serial is not available in this browser.");
    const selection = await selectPinecilV2SerialPort(navigator.serial);
    this.port = selection.port;
    if (selection.autoSelected) {
      WebSerialBlispFlasher.onLog("INFO", "Using previously authorized Pinecil V2 USB serial port.");
    }
    this.session = new SerialBlispSession(this.port);
    // Notify the app immediately when the cable is unplugged. Without this
    // the UI keeps showing "Connected" until the next operation fails.
    this.disconnectListener = () => {
      WebSerialBlispFlasher.onDisconnect(this);
    };
    this.port.addEventListener("disconnect", this.disconnectListener);
    try {
      await this.session.open();
      await this.handshake();
      this.bootloaderReady = true;
      await this.tryLoadEflashLoaderAndReadVersion();
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
      installedFirmwareVersion: this.installedFirmwareVersion,
      connectedAt: new Date().toISOString()
    };
  }

  async flash(input: FlashInput, onProgress: (event: FlashProgress) => void): Promise<FlashResult> {
    if (!this.session) throw new Error("No BLISP serial session is connected.");
    try {
      const firmware = parseBlispFirmware(input);
      const total = firmware.payload.length + (firmware.needsBootHeader ? 176 : 0);
      onProgress({ phase: "flash", message: "Preparing BL70x flash session", current: 0, total });

      if (!this.bootloaderReady) {
        await this.handshake(onProgress);
        this.bootloaderReady = true;
      }
      if (!this.eflashLoaderReady) {
        await this.ensureEflashLoader(onProgress, total);
      } else {
        await this.refreshEflashLoaderSession(onProgress, total);
      }
      if (firmware.needsBootHeader) {
        const bootHeader = buildPinecilV2BootHeader();
        await this.eraseAndWrite(0, bootHeader, total, 0, onProgress);
      }
      const baseProgress = firmware.needsBootHeader ? 176 : 0;
      await this.eraseAndWrite(firmware.address, firmware.payload, total, baseProgress, onProgress);

      onProgress({ phase: "verify", message: "Running BLISP program check", current: total, total });
      // Program check can run for several seconds because the chip recomputes
      // a hash over everything we just wrote. Match the same generous timeout
      // we use for erase rather than the default 1.2s.
      await this.session.command(0x3a, new Uint8Array(), true, false, BL70X_PROGRAM_CHECK_TIMEOUT_MS);
      onProgress({ phase: "verify", message: "BLISP program check returned OK", current: total, total, level: "success" });
      let flashedFirmwareVersion: string | undefined;
      if (input.kind === "firmware") {
        onProgress({ phase: "verify", message: "Reading flashed IronOS version", current: total, total });
        try {
          const { version, bytesScanned } = await this.readInstalledFirmwareVersionFromFlash(firmware.payload.length);
          if (version) {
            this.installedFirmwareVersion = version;
            flashedFirmwareVersion = version;
            onProgress({
              phase: "verify",
              message: `Installed IronOS version now ${version} (found within ${bytesScanned.toLocaleString()} bytes)`,
              current: total,
              total,
              level: "success"
            });
          } else {
            onProgress({
              phase: "verify",
              message: `Program check passed, but no IronOS version string was found in ${bytesScanned.toLocaleString()} bytes.`,
              current: total,
              total,
              level: "warn"
            });
          }
        } catch (err) {
          onProgress({
            phase: "verify",
            message: err instanceof Error
              ? `Program check passed, but installed version read failed: ${err.message}`
              : "Program check passed, but installed version read failed.",
            current: total,
            total,
            level: "warn"
          });
        }
      }
      await this.session.command(0x21, new Uint8Array(), true).catch(() => undefined);
      return {
        ok: true,
        message: "BLISP transfer completed.",
        installedFirmwareVersion: flashedFirmwareVersion,
        verifySummary: flashedFirmwareVersion
          ? `Program check returned OK. Installed firmware ${flashedFirmwareVersion}.`
          : "Program check returned OK."
      };
    } catch (err) {
      this.bootloaderReady = false;
      this.eflashLoaderReady = false;
      throw err;
    }
  }

  async close(): Promise<void> {
    if (this.port && this.disconnectListener) {
      try { this.port.removeEventListener("disconnect", this.disconnectListener); } catch { /* ignore */ }
    }
    this.disconnectListener = undefined;
    await this.session?.close().catch(() => undefined);
    this.session = undefined;
    this.port = undefined;
    this.bootloaderReady = false;
    this.eflashLoaderReady = false;
    this.bootRomVersion = undefined;
    this.installedFirmwareVersion = undefined;
  }

  private async handshake(onProgress?: (event: FlashProgress) => void) {
    await this.runHandshake({ inEflashLoader: false, getBootInfo: true, onProgress });
  }

  // Re-handshakes against the eflash_loader RAM app after it has been loaded
  // and started. Skip the BOUFFALOLAB5555RESET probe (that's only used by
  // the BL70x ROM) and skip the get_boot_info call (the loader doesn't
  // implement it the same way). Just lock baud with the 'U' burst and look
  // for OK.
  private async eflashHandshake(onProgress?: (event: FlashProgress) => void) {
    await this.runHandshake({ inEflashLoader: true, getBootInfo: false, onProgress });
  }

  private async runHandshake(options: {
    inEflashLoader: boolean;
    getBootInfo: boolean;
    onProgress?: (event: FlashProgress) => void;
  }): Promise<void> {
    if (!this.session) throw new Error("No BLISP serial session is connected.");
    const { inEflashLoader, getBootInfo, onProgress } = options;
    onProgress?.({
      phase: "detect",
      message: inEflashLoader ? "Re-handshaking with eflash_loader" : "Sending BLISP handshake",
      current: 0,
      total: 1,
      trace: true
    });

    // BL70x over USB CDC needs a wake-up probe before the 'U' burst when
    // talking to the ROM, otherwise it stays silent. The eflash_loader
    // accepts the 'U' burst alone. blisp's lib reads up to 20 bytes and
    // scans for "OK" anywhere in the response, retrying up to 5 times. We
    // mirror that exactly.
    // See https://github.com/pine64/blisp/blob/master/lib/blisp.c#L190
    const RESET_PROBE = new TextEncoder().encode("BOUFFALOLAB5555RESET\0\0");
    const U_BURST = new Uint8Array(BL70X_HANDSHAKE_BURST_BYTES).fill(0x55);

    let lastResponse = new Uint8Array();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (!inEflashLoader) {
        await this.session.write(RESET_PROBE);
        // blisp calls sp_drain on macOS between writes to make sure the
        // kernel has actually pushed the bytes onto the wire before the
        // next chunk. Web Serial has no drain primitive, so a small delay
        // approximates it.
        await delay(20);
      }
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
        if (getBootInfo) {
          const bootInfo = await this.session.command(0x10, new Uint8Array(), false, true);
          // First 4 bytes of the boot info payload are the BL70x ROM
          // version. Stored on the instance so connect() can put it on the
          // FlashTarget for the UI to display.
          this.bootRomVersion = bootInfo.length >= 4
            ? Array.from(bootInfo.slice(0, 4)).join(".")
            : undefined;
          onProgress?.({
            phase: "detect",
            message: `Boot ROM ${this.bootRomVersion ?? "detected"}`,
            current: 1,
            total: 1,
            trace: true
          });
        } else {
          onProgress?.({
            phase: "detect",
            message: "eflash_loader handshake OK",
            current: 1,
            total: 1,
            trace: true
          });
        }
        return;
      }
    }
    const tail = lastResponse.length
      ? ` Last bytes: ${Array.from(lastResponse).map((b) => b.toString(16).padStart(2, "0")).join(" ")}.`
      : " No bytes received from the chip.";
    throw new Error(`Timed out reading from BLISP serial port.${tail}`);
  }

  private async ensureEflashLoader(
    onProgress: (event: FlashProgress) => void,
    total: number
  ): Promise<void> {
    if (!this.session) throw new Error("No BLISP serial session is connected.");

    // Match blisp_common_prepare_flash: first try get_boot_info to see what is
    // currently answering. A boot ROM version of ff.ff.ff.ff means the RAM
    // eflash_loader is already running; a normal version means we are still in
    // ROM and must load it before issuing flash erase/write commands.
    let inRomBootloader = this.bootloaderReady;
    try {
      onProgress({ phase: "detect", message: "Checking BL70x loader state", current: 0, total, trace: true });
      const bootInfo = await this.session.command(0x10, new Uint8Array(), false, true, 500);
      const bootRomVersion = bootInfo.slice(0, 4);
      const alreadyInEflashLoader =
        bootRomVersion.length === 4 && bootRomVersion.every((byte) => byte === 0xff);
      if (alreadyInEflashLoader) {
        this.eflashLoaderReady = true;
        this.bootloaderReady = true;
        return;
      }
      if (bootRomVersion.length >= 4) this.bootRomVersion = Array.from(bootRomVersion).join(".");
      this.bootloaderReady = true;
      inRomBootloader = true;
    } catch (err) {
      this.eflashLoaderReady = false;
      inRomBootloader = false;
      if (isBlispFailureError(err)) {
        try {
          await this.confirmEflashLoaderReady(onProgress, total, "loader-state probe");
          return;
        } catch {
          throw err;
        }
      }
    }

    if (!inRomBootloader) {
      onProgress({ phase: "detect", message: "Re-handshaking with BL70x ROM", current: 0, total, trace: true });
      await this.handshake(onProgress);
      this.bootloaderReady = true;
      await this.session.readChunk(40);
    }

    onProgress({ phase: "detect", message: "Loading eflash_loader for flash access", current: 0, total });
    const bytes = await WebSerialBlispFlasher.eflashLoaderProvider();
    await loadEflashLoader(this.session, bytes, onProgress);
    await delay(150);
    await this.confirmEflashLoaderReady(onProgress, total, "eflash_loader handshake");
  }

  private async confirmEflashLoaderReady(
    onProgress: (event: FlashProgress) => void,
    total: number,
    context: string
  ): Promise<void> {
    if (!this.session) throw new Error("No BLISP serial session is connected.");
    await this.eflashHandshake(onProgress);
    const drained = await this.session.readChunk(40);
    if (drained.length > 0) {
      WebSerialBlispFlasher.onLog("INFO", `Drained ${drained.length} trailing byte(s) after ${context}.`, { trace: true });
    }
    this.eflashLoaderReady = true;
    this.bootloaderReady = true;
    onProgress({ phase: "detect", message: "BL70x flash session ready", current: 1, total });
  }

  private async refreshEflashLoaderSession(
    onProgress: (event: FlashProgress) => void,
    total: number
  ): Promise<void> {
    if (!this.session) throw new Error("No BLISP serial session is connected.");
    try {
      await this.confirmEflashLoaderReady(onProgress, total, "eflash_loader refresh");
    } catch {
      this.eflashLoaderReady = false;
      onProgress({ phase: "detect", message: "Refreshing BL70x serial session", current: 0, total, trace: true });
      await this.reopenSerialSession();
      try {
        await this.confirmEflashLoaderReady(onProgress, total, "refreshed eflash_loader session");
      } catch {
        this.eflashLoaderReady = false;
        await this.ensureEflashLoader(onProgress, total);
      }
    }
  }

  private async reopenSerialSession(): Promise<void> {
    if (!this.port) throw new Error("No BLISP serial port is connected.");
    await this.session?.close().catch(() => undefined);
    this.session = new SerialBlispSession(this.port);
    await this.session.open();
  }

  private async tryLoadEflashLoaderAndReadVersion(): Promise<void> {
    if (!this.session) return;
    const log = WebSerialBlispFlasher.onLog;
    let step = "loading eflash_loader";
    try {
      log("INFO", "Loading eflash_loader to read installed firmware version.");
      await this.ensureEflashLoader(
        (event) => {
          if (event.level === "warn") {
            log("WARN", event.message);
          }
        },
        1
      );

      step = "reading flash at IronOS firmware offset";
      log("INFO", "Reading flash to detect installed IronOS version.");
      let lastReported = 0;
      const { version, bytesScanned } = await this.readInstalledFirmwareVersionFromFlash(
        undefined,
        (scanned, total) => {
          if (scanned - lastReported >= 32 * 1024) {
            lastReported = scanned;
            log("INFO", `Scanning flash for version: ${(scanned / 1024) | 0} / ${(total / 1024) | 0} KiB`, { trace: true });
          }
        }
      );
      this.installedFirmwareVersion = version;
      if (version) {
        log("OK", `Installed IronOS version: ${version} (found within ${bytesScanned.toLocaleString()} bytes).`);
      } else {
        log("WARN", `Scanned ${bytesScanned.toLocaleString()} bytes of flash and did not find an IronOS version string.`);
      }
    } catch (err) {
      this.eflashLoaderReady = false;
      const message = err instanceof Error ? err.message : String(err);
      log("WARN", `Unable to read installed firmware version while ${step}: ${message}`);
    }
  }

  private async readInstalledFirmwareVersionFromFlash(
    maxBytes?: number,
    onProgress?: (scanned: number, total: number) => void
  ): Promise<{ version?: string; bytesScanned: number }> {
    if (!this.session) throw new Error("No BLISP serial session is connected.");
    return findIronOsVersionInFlash(
      this.session,
      PINECIL_V2_FIRMWARE_OFFSET,
      maxBytes,
      undefined,
      onProgress
    );
  }

  private async eraseAndWrite(
    address: number,
    bytes: Uint8Array,
    total: number,
    baseProgress: number,
    onProgress: (event: FlashProgress) => void
  ) {
    if (!this.session) throw new Error("No BLISP serial session is connected.");
    const log = WebSerialBlispFlasher.onLog;
    const eraseTimeoutMs = eraseResponseTimeoutMs(bytes.length);
    const eraseEnd = address + bytes.length;
    onProgress({
      phase: "flash",
      message: `Erasing flash 0x${address.toString(16).padStart(8, "0")} … 0x${eraseEnd.toString(16).padStart(8, "0")}`,
      current: baseProgress,
      total
    });
    // Match native blisp: one flash_erase command with start address and
    // end address (the CLI passes address + length), then wait through any
    // PD responses until OK.
    log(
      "INFO",
      `BLISP flash_erase 0x${address.toString(16).padStart(8, "0")}..0x${eraseEnd.toString(16).padStart(8, "0")} (${bytes.length.toLocaleString()} bytes, timeout ${eraseTimeoutMs} ms)`,
      { trace: true }
    );
    const eraseStartedAt = performance.now();
    await this.session.command(
      0x30,
      concatBytes([le32(address), le32(eraseEnd)]),
      true,
      false,
      eraseTimeoutMs
    );
    log("INFO", `BLISP flash_erase OK after ${elapsedMs(eraseStartedAt)} ms`, { trace: true });
    await delay(BL70X_POST_ERASE_SETTLE_MS);
    const chunkSize = flashWriteChunkSize();
    let sent = 0;
    let lastReportedSent = 0;
    onProgress({
      phase: "flash",
      message: "Writing firmware to flash",
      current: baseProgress,
      total
    });
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const chunk = bytes.slice(offset, offset + chunkSize);
      const chunkAddress = address + offset;
      if (offset === 0) {
        log(
          "INFO",
          `Starting BLISP flash_write at 0x${chunkAddress.toString(16).padStart(8, "0")} (chunk ${chunk.length} bytes, timeout ${BL70X_FLASH_WRITE_TIMEOUT_MS} ms)`,
          { trace: true }
        );
      }
      const payload = concatBytes([le32(chunkAddress), chunk]);
      let written = false;
      let lastError: unknown;
      for (let attempt = 1; attempt <= BL70X_FLASH_WRITE_RETRY_ATTEMPTS && !written; attempt += 1) {
        try {
          await this.session.command(0x31, payload, true, false, BL70X_FLASH_WRITE_TIMEOUT_MS);
          written = true;
          break;
        } catch (err) {
          lastError = err;
          if (!(err instanceof Error) || !/Timed out reading from BLISP/.test(err.message)) {
            break;
          }

          // Web Serial occasionally loses an ACK even though the page write
          // completed. Wait a little longer, then drain one last chunk before
          // retrying the exact same page. Reprogramming identical data into an
          // erased/already-written flash page is safe because no bits need to
          // flip from 0 back to 1.
          try {
            await this.session.receiveResponse(false, BL70X_FLASH_WRITE_LATE_OK_TIMEOUT_MS);
            written = true;
            log(
              "WARN",
              `BLISP flash_write late OK at 0x${chunkAddress.toString(16).padStart(8, "0")} after ${BL70X_FLASH_WRITE_TIMEOUT_MS}+${BL70X_FLASH_WRITE_LATE_OK_TIMEOUT_MS} ms`
            );
            break;
          } catch {
            const trailing = await this.session.readChunk(BL70X_FLASH_WRITE_RETRY_DRAIN_MS);
            if (findOkInResponse(trailing) >= 0) {
              written = true;
              log(
                "WARN",
                `BLISP flash_write recovered trailing OK at 0x${chunkAddress.toString(16).padStart(8, "0")} after timeout`
              );
              break;
            }
          }

          if (attempt < BL70X_FLASH_WRITE_RETRY_ATTEMPTS) {
            log(
              "WARN",
              `Retrying BLISP flash_write at 0x${chunkAddress.toString(16).padStart(8, "0")} (attempt ${attempt + 1}/${BL70X_FLASH_WRITE_RETRY_ATTEMPTS})`
            );
            await delay(BL70X_FLASH_WRITE_RETRY_DELAY_MS);
          }
        }
      }
      if (!written) {
        const message = lastError instanceof Error ? lastError.message : String(lastError);
        throw new Error(
          `BLISP flash_write failed at 0x${chunkAddress.toString(16).padStart(8, "0")} ` +
            `(${offset.toLocaleString()} of ${bytes.length.toLocaleString()} bytes, chunk ${chunk.length}, attempts ${BL70X_FLASH_WRITE_RETRY_ATTEMPTS}, timeout ${BL70X_FLASH_WRITE_TIMEOUT_MS}+${BL70X_FLASH_WRITE_LATE_OK_TIMEOUT_MS} ms): ${message}`
        );
      }
      sent += chunk.length;
      if (BL70X_FLASH_WRITE_INTER_CHUNK_DELAY_MS > 0) {
        await delay(BL70X_FLASH_WRITE_INTER_CHUNK_DELAY_MS);
      }
      if (
        sent === bytes.length ||
        lastReportedSent === 0 ||
        sent - lastReportedSent >= BL70X_WRITE_PROGRESS_INTERVAL_BYTES
      ) {
        lastReportedSent = sent;
        onProgress({
          phase: "flash",
          message: `Writing ${sent.toLocaleString()} of ${bytes.length.toLocaleString()} bytes`,
          current: baseProgress + sent,
          total,
          trace: true
        });
      }
    }
  }
}

function serialPortLabel(port: SerialPort): string {
  const info = port.getInfo();
  const vendor = info.usbVendorId?.toString(16).padStart(4, "0") ?? "unknown";
  const product = info.usbProductId?.toString(16).padStart(4, "0") ?? "unknown";
  return `USB ${vendor}:${product}`;
}

import type { FlashInput, FlashProgress, FlashResult, FlashTarget, FlasherBackend } from "@/lib/types";

const PINECIL_V1_VENDOR_ID = 0x28e9;
const PINECIL_V1_PRODUCT_ID = 0x0189;
const DFU_CLASS = 0xfe;
const DFU_SUBCLASS = 0x01;
const DFU_DETACH = 0;
const DFU_DNLOAD = 1;
const DFU_GETSTATUS = 3;
const DFU_CLRSTATUS = 4;
const TRANSFER_SIZE = 1024;

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

export interface DfuSuffix {
  bcdDevice: number;
  idProduct: number;
  idVendor: number;
  bcdDfu: number;
  suffixLength: number;
  crc: number;
  crcValid: boolean;
}

export interface DfuTargetImage {
  altSetting: number;
  address: number;
  bytes: Uint8Array;
}

export function crc32Dfu(bytes: Uint8Array, end = bytes.length): number {
  let crc = 0xffffffff;
  for (let index = 0; index < end; index += 1) {
    crc ^= bytes[index];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return crc >>> 0;
}

function readLe16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readLe32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function writeLe16(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function writeLe32(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

export function parseDfuSuffix(bytes: Uint8Array): DfuSuffix {
  if (bytes.length < 16) {
    throw new Error("DFU file is too short to contain a suffix.");
  }
  const offset = bytes.length - 16;
  if (bytes[offset + 8] !== 0x55 || bytes[offset + 9] !== 0x46 || bytes[offset + 10] !== 0x44) {
    throw new Error("DFU suffix signature is missing.");
  }
  const expectedCrc = readLe32(bytes, offset + 12);
  return {
    bcdDevice: readLe16(bytes, offset),
    idProduct: readLe16(bytes, offset + 2),
    idVendor: readLe16(bytes, offset + 4),
    bcdDfu: readLe16(bytes, offset + 6),
    suffixLength: bytes[offset + 11],
    crc: expectedCrc,
    crcValid: crc32Dfu(bytes, bytes.length - 4) === expectedCrc
  };
}

export function parseDfuSeTargets(bytes: Uint8Array): DfuTargetImage[] {
  if (bytes[0] !== 0x44 || bytes[1] !== 0x66 || bytes[2] !== 0x75 || bytes[3] !== 0x53 || bytes[4] !== 0x65) {
    throw new Error("Only DfuSe .dfu files are supported.");
  }
  const targetCount = bytes[10];
  const targets: DfuTargetImage[] = [];
  let offset = 11;

  for (let targetIndex = 0; targetIndex < targetCount; targetIndex += 1) {
    if (bytes[offset] !== 0x54 || bytes[offset + 1] !== 0x61) break;
    const altSetting = bytes[offset + 6];
    const targetSize = readLe32(bytes, offset + 266);
    const imageCount = readLe32(bytes, offset + 270);
    offset += 274;

    for (let imageIndex = 0; imageIndex < imageCount; imageIndex += 1) {
      const address = readLe32(bytes, offset);
      const size = readLe32(bytes, offset + 4);
      offset += 8;
      targets.push({
        altSetting,
        address,
        bytes: bytes.slice(offset, offset + size)
      });
      offset += size;
    }

    const consumed = targets.filter((target) => target.altSetting === altSetting).reduce((sum, target) => sum + target.bytes.length + 8, 0);
    const expectedOffset = offset - consumed + 274 + targetSize;
    if (expectedOffset > offset) offset = expectedOffset;
  }

  return targets;
}

export interface DfuSeBuildOptions {
  vendorId?: number;
  productId?: number;
  targetName?: string;
  altSetting?: number;
  bcdDevice?: number;
}

export function buildDfuSeFile(payload: Uint8Array, address: number, options: DfuSeBuildOptions = {}): Uint8Array {
  const vendorId = options.vendorId ?? PINECIL_V1_VENDOR_ID;
  const productId = options.productId ?? PINECIL_V1_PRODUCT_ID;
  const targetName = options.targetName ?? "@Internal Flash /0x08000000/128*001Kg";
  const altSetting = options.altSetting ?? 0;
  const bcdDevice = options.bcdDevice ?? 0xffff;
  const targetPrefixLength = 274;
  const suffixLength = 16;
  const total = 11 + targetPrefixLength + 8 + payload.length + suffixLength;
  const out = new Uint8Array(total);
  out.set(new TextEncoder().encode("DfuSe"), 0);
  out[5] = 0x01;
  writeLe32(out, 6, total);
  out[10] = 1;

  let offset = 11;
  out.set(new TextEncoder().encode("Target"), offset);
  out[offset + 6] = altSetting;
  out[offset + 7] = 1;
  const encodedTargetName = new TextEncoder().encode(targetName);
  out.set(encodedTargetName.slice(0, 255), offset + 11);
  writeLe32(out, offset + 266, payload.length + 8);
  writeLe32(out, offset + 270, 1);
  offset += targetPrefixLength;

  writeLe32(out, offset, address);
  writeLe32(out, offset + 4, payload.length);
  offset += 8;
  out.set(payload, offset);
  offset += payload.length;

  writeLe16(out, offset, bcdDevice);
  writeLe16(out, offset + 2, productId);
  writeLe16(out, offset + 4, vendorId);
  writeLe16(out, offset + 6, 0x011a);
  out[offset + 8] = 0x55;
  out[offset + 9] = 0x46;
  out[offset + 10] = 0x44;
  out[offset + 11] = suffixLength;
  writeLe32(out, offset + 12, crc32Dfu(out, out.length - 4));
  return out;
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export class WebUsbDfuFlasher implements FlasherBackend {
  private device?: USBDevice;
  private interfaceNumber = 0;

  async connect(): Promise<FlashTarget> {
    if (!navigator.usb) throw new Error("WebUSB is not available in this browser.");
    this.device = await navigator.usb.requestDevice({
      filters: [{ vendorId: PINECIL_V1_VENDOR_ID }, { classCode: DFU_CLASS, subclassCode: DFU_SUBCLASS }]
    });
    if (!this.device.opened) await this.device.open();
    if (!this.device.configuration) await this.device.selectConfiguration(1);
    const dfuInterface = this.device.configuration?.interfaces.find((item) =>
      item.alternates.some((alt) => alt.interfaceClass === DFU_CLASS && alt.interfaceSubclass === DFU_SUBCLASS)
    );
    if (!dfuInterface) throw new Error("The selected USB device does not expose a DFU interface.");
    this.interfaceNumber = dfuInterface.interfaceNumber;
    await this.device.claimInterface(this.interfaceNumber);
    await this.device.selectAlternateInterface(this.interfaceNumber, dfuInterface.alternates[0]?.alternateSetting ?? 0);
    return {
      model: "v1",
      transport: "webusb-dfu",
      label: this.device.productName ?? "Pinecil V1 DFU",
      serial: this.device.serialNumber,
      connectedAt: new Date().toISOString()
    };
  }

  async flash(input: FlashInput, onProgress: (event: FlashProgress) => void): Promise<FlashResult> {
    if (!this.device) throw new Error("No DFU device is connected.");
    const suffix = parseDfuSuffix(input.bytes);
    if (!suffix.crcValid) throw new Error("DFU CRC check failed before flashing.");

    const targets = parseDfuSeTargets(input.bytes);
    if (!targets.length) throw new Error("No DfuSe target images were found.");

    let written = 0;
    const total = targets.reduce((sum, target) => sum + target.bytes.length, 0);
    onProgress({ phase: "flash", message: "Starting DFU download", current: 0, total });

    for (const target of targets) {
      await this.sendDfuCommand(DFU_CLRSTATUS, 0, new Uint8Array());
      await this.sendAddressPointer(target.address);
      let block = 2;
      for (let offset = 0; offset < target.bytes.length; offset += TRANSFER_SIZE) {
        const chunk = target.bytes.slice(offset, offset + TRANSFER_SIZE);
        await this.sendDfuCommand(DFU_DNLOAD, block, chunk);
        await this.pollStatus();
        written += chunk.length;
        onProgress({
          phase: "flash",
          message: `Writing DFU block ${block}`,
          current: written,
          total
        });
        block += 1;
      }
    }

    await this.sendDfuCommand(DFU_DNLOAD, 0, new Uint8Array());
    await this.pollStatus();
    onProgress({ phase: "verify", message: "DFU download complete", current: total, total, level: "success" });
    return { ok: true, message: "DFU transfer completed.", verifySummary: "DFU status returned OK after final block." };
  }

  async close(): Promise<void> {
    if (!this.device) return;
    try {
      await this.device.releaseInterface(this.interfaceNumber);
    } catch {
      // The device may already have reset after flashing.
    }
    await this.device.close();
    this.device = undefined;
  }

  private async sendAddressPointer(address: number) {
    const data = new Uint8Array(5);
    data[0] = 0x21;
    writeLe32(data, 1, address);
    await this.sendDfuCommand(DFU_DNLOAD, 0, data);
    await this.pollStatus();
  }

  private async sendDfuCommand(request: number, value: number, data: Uint8Array) {
    if (!this.device) throw new Error("No DFU device is connected.");
    const result = await this.device.controlTransferOut(
      {
        requestType: "class",
        recipient: "interface",
        request,
        value,
        index: this.interfaceNumber
      },
      asArrayBuffer(data)
    );
    if (result.status !== "ok") throw new Error(`DFU command ${request} failed with status ${result.status}.`);
  }

  private async pollStatus() {
    if (!this.device) throw new Error("No DFU device is connected.");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const result = await this.device.controlTransferIn(
        {
          requestType: "class",
          recipient: "interface",
          request: DFU_GETSTATUS,
          value: 0,
          index: this.interfaceNumber
        },
        6
      );
      const data = result.data;
      if (!data || result.status !== "ok") throw new Error("Unable to read DFU status.");
      const state = data.getUint8(4);
      const status = data.getUint8(0);
      const pollTimeout = data.getUint8(1) | (data.getUint8(2) << 8) | (data.getUint8(3) << 16);
      if (status !== 0) throw new Error(`DFU reported status code ${status}.`);
      if (state === 2 || state === 5) return;
      await sleep(Math.max(20, pollTimeout));
    }
    throw new Error("DFU status polling timed out.");
  }

  async detach() {
    if (!this.device) return;
    await this.sendDfuCommand(DFU_DETACH, 1000, new Uint8Array());
  }
}

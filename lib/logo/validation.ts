import { LOGO_ADDRESSES, LOGO_BYTE_LENGTH, LOGO_PAGE_SIZE } from "@/lib/logo/generator";
import { parseDfuSeTargets, parseDfuSuffix } from "@/lib/protocol/dfu";
import type { PinecilModel } from "@/lib/types";

const BL70X_FLASH_MAP_ADDR = 0x23000000;
const OLD_LOGO_HEADER_VALUE = 0xf00daa55;

export interface ValidatedLogoDfu {
  address: number;
  bytes: Uint8Array;
}

function readLe32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function isErasePayload(bytes: Uint8Array): boolean {
  return bytes.every((byte) => byte === 0xff);
}

function normalizeLogoAddress(model: PinecilModel, address: number): number {
  if (model === "v2" && address >= BL70X_FLASH_MAP_ADDR) return address - BL70X_FLASH_MAP_ADDR;
  return address;
}

function validateNewLogoPayload(bytes: Uint8Array): void {
  let position = 2; // 0xaa marker + inter-frame delay
  let sawFrame = false;

  while (position < bytes.length) {
    const length = bytes[position];
    if (length === 0) {
      if (!sawFrame) throw new Error("Boot-logo payload does not contain any frames.");
      return;
    }
    if (length === 0xfe) {
      sawFrame = true;
      position += 1;
      continue;
    }
    if (length === 0xff) {
      if (position + 1 + LOGO_BYTE_LENGTH > bytes.length) {
        throw new Error("Boot-logo full-frame data is truncated.");
      }
      sawFrame = true;
      position += 1 + LOGO_BYTE_LENGTH;
      continue;
    }

    if (length % 2 !== 0) throw new Error("Boot-logo delta-frame length must be even.");
    if (position + 1 + length > bytes.length) throw new Error("Boot-logo delta-frame data is truncated.");

    for (let offset = 0; offset < length; offset += 2) {
      const index = bytes[position + 1 + offset];
      if (index >= LOGO_BYTE_LENGTH) throw new Error("Boot-logo delta-frame index is outside the 96x16 logo page.");
    }

    sawFrame = true;
    position += 1 + length;
  }

  if (!sawFrame) throw new Error("Boot-logo payload does not contain any frames.");
}

export function validateIronOsLogoPayload(bytes: Uint8Array): void {
  if (bytes.length !== LOGO_PAGE_SIZE) {
    throw new Error(`Boot-logo payload must be exactly ${LOGO_PAGE_SIZE} bytes.`);
  }
  if (isErasePayload(bytes)) return;
  if (readLe32(bytes, 0) === OLD_LOGO_HEADER_VALUE) return;
  if (bytes[0] !== 0xaa) {
    throw new Error("Boot-logo payload is not an IronOS logo page.");
  }
  validateNewLogoPayload(bytes);
}

export function validateLogoDfuFile(bytes: Uint8Array, model: PinecilModel): ValidatedLogoDfu {
  const suffix = parseDfuSuffix(bytes);
  if (!suffix.crcValid) throw new Error("Boot-logo DFU CRC check failed before flashing.");

  const targets = parseDfuSeTargets(bytes);
  if (targets.length !== 1) {
    throw new Error("Boot-logo DFU must contain exactly one target image.");
  }

  const target = targets[0];
  const normalizedAddress = normalizeLogoAddress(model, target.address);
  const expectedAddress = LOGO_ADDRESSES[model];
  if (normalizedAddress !== expectedAddress) {
    throw new Error(
      `Boot-logo DFU target address 0x${target.address.toString(16)} does not match ${model.toUpperCase()} logo address 0x${expectedAddress.toString(16)}.`
    );
  }

  validateIronOsLogoPayload(target.bytes);
  return { address: normalizedAddress, bytes: target.bytes };
}

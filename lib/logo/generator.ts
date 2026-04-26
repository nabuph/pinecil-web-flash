import { buildDfuSeFile } from "@/lib/protocol/dfu";
import type { GeneratedLogo, LogoGenerationInput, LogoPanOffset, PinecilModel } from "@/lib/types";

export const LOGO_WIDTH = 96;
export const LOGO_HEIGHT = 16;
export const LOGO_BYTE_LENGTH = (LOGO_WIDTH * LOGO_HEIGHT) / 8;
export const LOGO_PAGE_SIZE = 1024;
export const DATA_PROGRAMMED_MARKER = 0xaa;
export const FULL_FRAME_MARKER = 0xff;
export const EMPTY_FRAME_MARKER = 0xfe;

export const LOGO_ADDRESSES: Record<PinecilModel, number> = {
  v1: 0x0801f800,
  v2: 1016 * 1024
};

const LOGO_TARGET_NAMES: Record<PinecilModel, string> = {
  v1: "Pinecil",
  v2: "Pinecilv2"
};

function assertLogoBits(bits: Uint8Array) {
  if (bits.length !== LOGO_WIDTH * LOGO_HEIGHT) {
    throw new Error(`Expected ${LOGO_WIDTH * LOGO_HEIGHT} logo pixels.`);
  }
}

function invertBits(bits: Uint8Array): Uint8Array {
  const out = new Uint8Array(bits.length);
  for (let index = 0; index < bits.length; index += 1) {
    out[index] = bits[index] ? 0 : 1;
  }
  return out;
}

export function packLogoPixels(bits: Uint8Array, invert = false): Uint8Array {
  assertLogoBits(bits);
  const source = invert ? invertBits(bits) : bits;
  const out = new Uint8Array(LOGO_BYTE_LENGTH);

  for (let byteIndex = 0; byteIndex < LOGO_BYTE_LENGTH; byteIndex += 1) {
    const pageOffset = byteIndex < LOGO_WIDTH ? 0 : 8;
    const x = byteIndex % LOGO_WIDTH;
    let byte = 0;
    for (let y = 0; y < 8; y += 1) {
      if (source[(y + pageOffset) * LOGO_WIDTH + x]) {
        byte |= 1 << y;
      }
    }
    out[byteIndex] = byte;
  }

  return out;
}

export function calculateFrameDelta(previousFrame: Uint8Array, nextFrame: Uint8Array): number[] {
  if (previousFrame.length !== nextFrame.length) {
    throw new Error("Logo frames must be the same length.");
  }
  const delta: number[] = [];
  for (let index = 0; index < nextFrame.length; index += 1) {
    if (previousFrame[index] !== nextFrame[index]) {
      delta.push(index, nextFrame[index]);
    }
  }
  return delta;
}

export function encodeLogoFrame(previousFrame: Uint8Array, nextFrame: Uint8Array): Uint8Array {
  const delta = calculateFrameDelta(previousFrame, nextFrame);
  if (delta.length === 0) return new Uint8Array([EMPTY_FRAME_MARKER]);
  if (delta.length < nextFrame.length) return new Uint8Array([delta.length, ...delta]);
  return new Uint8Array([FULL_FRAME_MARKER, ...nextFrame]);
}

export function buildLogoPayload(bits: Uint8Array, invert = false): Uint8Array {
  const packed = packLogoPixels(bits, invert);
  const firstFrame = encodeLogoFrame(new Uint8Array(LOGO_BYTE_LENGTH), packed);
  const out = new Uint8Array(LOGO_PAGE_SIZE);
  out[0] = DATA_PROGRAMMED_MARKER;
  out[1] = 0x00;
  out.set(firstFrame, 2);
  return out;
}

export function buildEraseLogoPayload(): Uint8Array {
  return new Uint8Array(LOGO_PAGE_SIZE).fill(0xff);
}

export function buildLogoDfu(model: PinecilModel, bits: Uint8Array, invert = false): Uint8Array {
  return buildDfuSeFile(buildLogoPayload(bits, invert), LOGO_ADDRESSES[model], {
    targetName: LOGO_TARGET_NAMES[model],
    vendorId: 0x28e9,
    productId: 0x0189,
    bcdDevice: 0
  });
}

export function buildEraseLogoDfu(model: PinecilModel): Uint8Array {
  return buildDfuSeFile(buildEraseLogoPayload(), LOGO_ADDRESSES[model], {
    targetName: LOGO_TARGET_NAMES[model],
    vendorId: 0x28e9,
    productId: 0x0189,
    bcdDevice: 0
  });
}

function imageToPixels(data: Uint8ClampedArray, threshold: number, invert: boolean): Uint8Array {
  const pixels = new Uint8Array(LOGO_WIDTH * LOGO_HEIGHT);
  for (let index = 0; index < pixels.length; index += 1) {
    const offset = index * 4;
    const luminance = data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722;
    const white = luminance >= threshold;
    pixels[index] = invert ? (white ? 0 : 1) : white ? 1 : 0;
  }
  return pixels;
}

function blankPreviewUrl(on = false): string {
  const canvas = document.createElement("canvas");
  canvas.width = LOGO_WIDTH;
  canvas.height = LOGO_HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) return "";
  context.fillStyle = on ? "white" : "black";
  context.fillRect(0, 0, LOGO_WIDTH, LOGO_HEIGHT);
  return canvas.toDataURL("image/png");
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function resolveLogoImagePlacement(
  bitmapWidth: number,
  bitmapHeight: number,
  pan: LogoPanOffset = { x: 0, y: 0 }
) {
  const zoom = clamp(pan.zoom ?? 1, 1, 6);
  const scale = Math.max(LOGO_WIDTH / bitmapWidth, LOGO_HEIGHT / bitmapHeight) * zoom;
  const width = bitmapWidth * scale;
  const height = bitmapHeight * scale;
  const maxOffsetX = Math.max(0, (width - LOGO_WIDTH) / 2);
  const maxOffsetY = Math.max(0, (height - LOGO_HEIGHT) / 2);
  const offsetX = clamp(pan.x, -1, 1) * maxOffsetX;
  const offsetY = clamp(pan.y, -1, 1) * maxOffsetY;

  return {
    x: (LOGO_WIDTH - width) / 2 + offsetX,
    y: (LOGO_HEIGHT - height) / 2 + offsetY,
    width,
    height,
    scale,
    zoom,
    maxOffsetX,
    maxOffsetY
  };
}

export async function generateLogoFromImage(input: LogoGenerationInput): Promise<GeneratedLogo> {
  if (input.erase) {
    return {
      fileName: `pinecil-${input.model}-erase-logo.dfu`,
      bytes: buildEraseLogoDfu(input.model),
      pixels: new Uint8Array(LOGO_WIDTH * LOGO_HEIGHT),
      width: LOGO_WIDTH,
      height: LOGO_HEIGHT,
      previewUrl: blankPreviewUrl(false),
      formatNote: "Default-logo restore .dfu file ready. Flash it to remove the custom boot logo.",
      isErase: true
    };
  }

  if (!input.image) throw new Error("Choose an image before generating a logo.");

  const bitmap = await createImageBitmap(input.image);
  const canvas = document.createElement("canvas");
  canvas.width = LOGO_WIDTH;
  canvas.height = LOGO_HEIGHT;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Unable to create a canvas context.");

  context.fillStyle = "black";
  context.fillRect(0, 0, LOGO_WIDTH, LOGO_HEIGHT);
  const placement = resolveLogoImagePlacement(bitmap.width, bitmap.height, input.imagePan);
  context.drawImage(bitmap, placement.x, placement.y, placement.width, placement.height);

  const rgba = context.getImageData(0, 0, LOGO_WIDTH, LOGO_HEIGHT).data;
  const pixels = imageToPixels(rgba, input.threshold, input.invert);
  const bytes = buildLogoDfu(input.model, pixels);
  const fileStem = input.image.name.replace(/\.[^.]+$/, "").replace(/[^a-z0-9-]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "logo";

  return {
    fileName: `pinecil-${input.model}-${fileStem}.dfu`,
    bytes,
    pixels,
    width: LOGO_WIDTH,
    height: LOGO_HEIGHT,
    previewUrl: canvas.toDataURL("image/png"),
    formatNote:
      input.animationMode === "animated"
        ? "Animated input flattened to the first browser-decoded frame, then converted to the official IronOS logo page."
        : "Static image converted to the official 96x16 one-bit IronOS logo page.",
    isErase: false
  };
}

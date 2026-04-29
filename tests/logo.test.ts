import { describe, expect, it } from "vitest";
import {
  buildEraseLogoPayload,
  buildLogoPayload,
  buildLogoDfu,
  DATA_PROGRAMMED_MARKER,
  EMPTY_FRAME_MARKER,
  FULL_FRAME_MARKER,
  LOGO_ADDRESSES,
  LOGO_HEIGHT,
  LOGO_PAGE_SIZE,
  LOGO_WIDTH,
  packLogoPixels,
  resolveLogoImagePlacement
} from "@/lib/logo/generator";
import { validateLogoDfuFile } from "@/lib/logo/validation";
import { buildDfuSeFile, parseDfuSeTargets, parseDfuSuffix } from "@/lib/protocol/dfu";

describe("logo generator", () => {
  it("packs 96x16 pixels into the official IronOS OLED page layout", () => {
    const bits = new Uint8Array(LOGO_WIDTH * LOGO_HEIGHT);
    bits[0] = 1;
    bits[7 * LOGO_WIDTH] = 1;
    bits[8 * LOGO_WIDTH] = 1;
    const packed = packLogoPixels(bits);

    expect(packed[0]).toBe(0x81);
    expect(packed[LOGO_WIDTH]).toBe(0x01);
  });

  it("builds a static IronOS logo page with programmed marker and frame encoding", () => {
    const blank = new Uint8Array(LOGO_WIDTH * LOGO_HEIGHT);
    const payload = buildLogoPayload(blank);

    expect(payload).toHaveLength(LOGO_PAGE_SIZE);
    expect(payload[0]).toBe(DATA_PROGRAMMED_MARKER);
    expect(payload[1]).toBe(0x00);
    expect(payload[2]).toBe(EMPTY_FRAME_MARKER);
  });

  it("uses a full-frame encoding when the official fixture would be smaller as a full frame", () => {
    const white = new Uint8Array(LOGO_WIDTH * LOGO_HEIGHT).fill(1);
    const payload = buildLogoPayload(white);

    expect(payload[2]).toBe(FULL_FRAME_MARKER);
    expect([...payload.slice(3, 3 + 192)]).toEqual(new Array(192).fill(0xff));
  });

  it("builds erase payloads and model-specific DFU containers", () => {
    const erase = buildEraseLogoPayload();
    const dfu = buildLogoDfu("v2", new Uint8Array(LOGO_WIDTH * LOGO_HEIGHT));
    const suffix = parseDfuSuffix(dfu);
    const targets = parseDfuSeTargets(dfu);

    expect([...erase]).toEqual(new Array(LOGO_PAGE_SIZE).fill(0xff));
    expect(suffix.crcValid).toBe(true);
    expect(targets[0].address).toBe(LOGO_ADDRESSES.v2);
    expect(validateLogoDfuFile(dfu, "v2")).toMatchObject({
      address: LOGO_ADDRESSES.v2
    });
  });

  it("rejects boot-logo DFUs for the wrong Pinecil model before flashing", () => {
    const v1Dfu = buildLogoDfu("v1", new Uint8Array(LOGO_WIDTH * LOGO_HEIGHT));

    expect(() => validateLogoDfuFile(v1Dfu, "v2")).toThrow(/does not match V2 logo address/);
  });

  it("rejects corrupted boot-logo DFUs before flashing", () => {
    const dfu = buildLogoDfu("v2", new Uint8Array(LOGO_WIDTH * LOGO_HEIGHT));
    dfu[dfu.length - 1] ^= 0xff;

    expect(() => validateLogoDfuFile(dfu, "v2")).toThrow(/CRC check failed/);
  });

  it("accepts Pinecil V2 logo DFUs that use the BL70x flash map address", () => {
    const mapped = buildDfuSeFile(
      buildLogoPayload(new Uint8Array(LOGO_WIDTH * LOGO_HEIGHT)),
      0x23000000 + LOGO_ADDRESSES.v2
    );

    expect(validateLogoDfuFile(mapped, "v2")).toMatchObject({
      address: LOGO_ADDRESSES.v2
    });
  });

  it("resolves panned image placement without exposing empty canvas", () => {
    const wide = resolveLogoImagePlacement(960, 160, { x: 1, y: 1 });
    expect(wide.x).toBeCloseTo(0);
    expect(wide.y).toBe(0);

    const zoomedWide = resolveLogoImagePlacement(960, 160, { x: 1, y: 0, zoom: 2 });
    expect(zoomedWide.x).toBeCloseTo(0);
    expect(zoomedWide.width).toBeCloseTo(192);

    const tall = resolveLogoImagePlacement(96, 96, { x: -1, y: -1 });
    expect(tall.x).toBe(0);
    expect(tall.y).toBeCloseTo(-80);

    const clamped = resolveLogoImagePlacement(960, 160, { x: 4, y: -4 });
    expect(clamped.x).toBeCloseTo(0);
    expect(clamped.y).toBe(0);
  });
});

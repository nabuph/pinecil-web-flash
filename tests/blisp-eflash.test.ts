import { describe, expect, it } from "vitest";
import {
  BL70X_TCM_ADDRESS,
  buildRamLoadBootHeader,
  buildRamSegmentHeader,
  crc32,
  findIronOsVersion,
  findIronOsVersionInFlash,
  flashRead,
  loadEflashLoader
} from "@/lib/protocol/blisp-eflash";

describe("blisp-eflash CRC32", () => {
  it("matches Python zlib.crc32 for a known sequence", () => {
    // Reference: zlib.crc32(b'\x12\x34\x56\x78\x9a\xbc\xde\xf0') == 0xa85a34a3
    const result = crc32(new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0]));
    expect(result.toString(16).padStart(8, "0")).toBe("a85a34a3");
  });

  it("returns 0 for an empty input", () => {
    expect(crc32(new Uint8Array())).toBe(0);
  });
});

describe("buildRamLoadBootHeader", () => {
  it("produces a 176-byte header with the BFNP/FCFG magics in place", () => {
    const header = buildRamLoadBootHeader();
    expect(header).toHaveLength(176);
    expect(new TextDecoder().decode(header.slice(0, 4))).toBe("BFNP");
    expect(new TextDecoder().decode(header.slice(8, 12))).toBe("FCFG");
  });

  it("places the TCM dest address at offset 128 (LE) and the deadbeef hash sentinel at 132", () => {
    const header = buildRamLoadBootHeader();
    const dv = new DataView(header.buffer, header.byteOffset, header.byteLength);
    expect(dv.getUint32(128, true)).toBe(BL70X_TCM_ADDRESS);
    expect(header[132]).toBe(0xef);
    expect(header[133]).toBe(0xbe);
    expect(header[134]).toBe(0xad);
    expect(header[135]).toBe(0xde);
  });

  it("sets crc_ignore + hash_ignore + cache_enable + no_segment in bootcfg.wval", () => {
    const header = buildRamLoadBootHeader();
    const dv = new DataView(header.buffer, header.byteOffset, header.byteLength);
    expect(dv.getUint32(116, true)).toBe(0x00030300);
  });
});

describe("buildRamSegmentHeader", () => {
  it("encodes dest_addr, length, reserved, and a CRC over the first 12 bytes", () => {
    const dest = 0x22010000;
    const length = 59200;
    const header = buildRamSegmentHeader(dest, length);
    expect(header).toHaveLength(16);
    const dv = new DataView(header.buffer, header.byteOffset, header.byteLength);
    expect(dv.getUint32(0, true)).toBe(dest);
    expect(dv.getUint32(4, true)).toBe(length);
    expect(dv.getUint32(8, true)).toBe(0);
    // CRC must match crc32 over the first 12 bytes (zero-padded same buffer).
    const headBytes = header.slice(0, 12);
    expect(dv.getUint32(12, true)).toBe(crc32(headBytes));
  });
});

describe("findIronOsVersion", () => {
  it("extracts a v2.X version from a flash dump", () => {
    // IronOS BUILD_VERSION format is major.minor only (no patch component);
    // a build-type letter and optional commit hash may follow. See
    // source/version.h in IronOS.
    const text = "BFNP\x00\x00\x00\x00...some firmware bytes...IronOS v2.23\x00\x00\x00";
    const bytes = new TextEncoder().encode(text);
    expect(findIronOsVersion(bytes)).toBe("v2.23");
  });

  it("accepts v2.X (no build-type letter)", () => {
    const text = "boot \x00 v2.22 trailing";
    expect(findIronOsVersion(new TextEncoder().encode(text))).toBe("v2.22");
  });

  it("matches the IronOS release form 'v2.22H'", () => {
    const bytes = new TextEncoder().encode("...build v2.22H here...");
    expect(findIronOsVersion(bytes)).toBe("v2.22H");
  });

  it("matches the dev-build form 'v2.22D.1A2B3C4D'", () => {
    const bytes = new TextEncoder().encode("xx v2.22D.1A2B3C4D yy");
    expect(findIronOsVersion(bytes)).toBe("v2.22D.1A2B3C4D");
  });

  it("returns undefined when no version-shaped string is present", () => {
    const bytes = new Uint8Array(2048).fill(0xff);
    expect(findIronOsVersion(bytes)).toBeUndefined();
  });

  it("does not match arbitrary numbers like 1.2.3", () => {
    const bytes = new TextEncoder().encode("1.2.3");
    expect(findIronOsVersion(bytes)).toBeUndefined();
  });
});

describe("findIronOsVersionInFlash", () => {
  it("stream-scans across chunks and stops as soon as the literal is found", async () => {
    // Place "v2.23R" at offset 1500 of a synthetic flash, well past the
    // first chunk of 1 KiB. Scanner should find it on the second chunk.
    const flash = new Uint8Array(8 * 1024).fill(0xff);
    flash.set(new TextEncoder().encode("v2.23R"), 1500);
    const requests: { address: number; length: number }[] = [];
    const session = {
      command: async (code: number, payload?: Uint8Array): Promise<Uint8Array> => {
        if (code !== 0x32 || !payload) throw new Error("unexpected");
        const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
        const address = dv.getUint32(0, true);
        const length = dv.getUint32(4, true);
        requests.push({ address, length });
        return flash.slice(address, address + length);
      },
      write: async () => undefined
    };

    const { version, bytesScanned } = await findIronOsVersionInFlash(session, 0, 8 * 1024, 1024);
    expect(version).toBe("v2.23R");
    // Two chunks scanned (offset 0..1024 and 1024..2048) — covers offset 1500.
    expect(bytesScanned).toBe(2048);
    expect(requests.length).toBeGreaterThanOrEqual(2);
  });

  it("returns undefined and reports bytesScanned when no literal is present", async () => {
    const flash = new Uint8Array(4 * 1024).fill(0xff);
    const session = {
      command: async (_code: number, payload?: Uint8Array): Promise<Uint8Array> => {
        const dv = new DataView(payload!.buffer, payload!.byteOffset, payload!.byteLength);
        const address = dv.getUint32(0, true);
        const length = dv.getUint32(4, true);
        return flash.slice(address, address + length);
      },
      write: async () => undefined
    };

    const { version, bytesScanned } = await findIronOsVersionInFlash(session, 0, 4 * 1024, 1024);
    expect(version).toBeUndefined();
    expect(bytesScanned).toBe(4 * 1024);
  });
});

describe("loadEflashLoader (mocked session)", () => {
  it("sends 0x11 boot header, 0x17 segment header, 0x18 segment data chunks, 0x19 check, then 3 write_memory pokes", async () => {
    const sent: { code?: number; payload?: Uint8Array; raw?: Uint8Array }[] = [];
    const session = {
      command: async (code: number, payload?: Uint8Array): Promise<Uint8Array> => {
        sent.push({ code, payload });
        return new Uint8Array();
      },
      write: async (bytes: Uint8Array) => {
        sent.push({ raw: bytes });
      }
    };
    // Small fake loader so we exercise multi-chunk segment data without
    // pulling in the real 59 KiB blob.
    const fakeLoader = new Uint8Array(8192).fill(0xab);

    await loadEflashLoader(session, fakeLoader);

    // Sequence sanity: 0x11, 0x17, then one or more 0x18, then 0x19, then
    // two 0x50 (write_memory with response), then a raw write framed packet
    // (the run-image poke that doesn't wait).
    const codes = sent
      .filter((s): s is { code: number; payload?: Uint8Array } => typeof s.code === "number")
      .map((s) => s.code);
    expect(codes[0]).toBe(0x11);
    expect(codes[1]).toBe(0x17);
    expect(codes.slice(2, -3).every((c) => c === 0x18)).toBe(true);
    // last command and the two before are: 0x19, 0x50, 0x50
    expect(codes[codes.length - 3]).toBe(0x19);
    expect(codes[codes.length - 2]).toBe(0x50);
    expect(codes[codes.length - 1]).toBe(0x50);
    // Final entry is a raw framed write (the no-wait write_memory).
    const last = sent[sent.length - 1];
    expect(last.raw).toBeDefined();
    expect(last.raw?.[0]).toBe(0x50);
  });
});

describe("flashRead (mocked session)", () => {
  it("requests bytes in chunks until the requested length is satisfied", async () => {
    const requested: { address: number; length: number }[] = [];
    let cursor = 0;
    const session = {
      command: async (code: number, payload?: Uint8Array): Promise<Uint8Array> => {
        if (code !== 0x32 || !payload) throw new Error("unexpected");
        const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
        const address = dv.getUint32(0, true);
        const length = dv.getUint32(4, true);
        requested.push({ address, length });
        const out = new Uint8Array(length);
        for (let i = 0; i < length; i += 1) {
          out[i] = (cursor + i) & 0xff;
        }
        cursor += length;
        return out;
      },
      write: async () => undefined
    };

    // Use a 1024-byte chunk so this test stays self-contained without
    // depending on the production default (which is intentionally small for
    // hardware compatibility).
    const result = await flashRead(session, 0x2000, 1024 + 500, 1024);
    expect(result).toHaveLength(1024 + 500);
    expect(requested).toEqual([
      { address: 0x2000, length: 1024 },
      { address: 0x2000 + 1024, length: 500 }
    ]);
  });
});

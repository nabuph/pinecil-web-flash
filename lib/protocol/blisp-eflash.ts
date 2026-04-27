// BLISP eflash_loader pipeline for Pinecil V2 (BL70x).
//
// The BL70x ROM bootloader can only do a small set of low-level operations
// (handshake, get boot info, load+run a RAM image, raw memory writes). It
// cannot directly erase or program flash. To do real flashing — or even read
// what's currently on flash — we need to load the official Bouffalo Labs
// "eflash_loader" RAM application into TCM, run it, and then talk to *it*
// using the same BLISP packet framing.
//
// The flow we run after the ROM handshake (lib/protocol/blisp.ts) is:
//   1. Send a 176-byte boot header (cmd 0x11) describing flash + clock cfg.
//   2. Send a 16-byte segment header (cmd 0x17) saying "the next blob is N
//      bytes and goes at TCM 0x22010000."
//   3. Stream the eflash_loader.bin in chunks via cmd 0x18.
//   4. check_image (cmd 0x19) — verify what we sent.
//   5. BL70x ERRATA: instead of run_image (0x1A) we issue three write_memory
//      (0x50) calls that prod the chip into jumping to TCM.
//   6. Wait briefly for the loader to start, then re-handshake with just a
//      'U' burst (no BOUFFALOLAB5555RESET this time — that's only for the
//      ROM stage) and confirm we get OK back from the loader.
//
// Once we've done that the chip will accept eflash_loader commands like
// flash_erase (0x30), flash_write (0x31), flash_read (0x32), program_check
// (0x3A), and reset (0x21). Mirrors lib/blisp_easy.c::blisp_easy_load_ram_app
// from https://github.com/pine64/blisp.

import type { FlashProgress } from "@/lib/types";

// Where the eflash_loader expects to live in TCM RAM on BL70x.
export const BL70X_TCM_ADDRESS = 0x22010000;
// blisp's blisp_easy_load_segment_data uses smaller chunks on macOS because
// the kernel CDC driver discards larger USB bulk transfers. Match that here
// so we don't have to special-case the platform.
const SEGMENT_CHUNK_SIZE_MAC = 252 * 16;
const SEGMENT_CHUNK_SIZE_OTHER = 4092;
// blisp_easy_flash_write tightens further for flash-write traffic on macOS.
const FLASH_WRITE_CHUNK_MAC = 372;
const FLASH_WRITE_CHUNK_OTHER = 2052;

function isAppleHost(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  // Apple Silicon and Intel Macs report "Macintosh" or "Mac OS X". iPad
  // pretends to be a desktop Mac too but Web Serial isn't available on iPad
  // anyway, so this is fine.
  return /Macintosh|Mac OS X/i.test(ua);
}

export function segmentChunkSize(): number {
  return isAppleHost() ? SEGMENT_CHUNK_SIZE_MAC : SEGMENT_CHUNK_SIZE_OTHER;
}

export function flashWriteChunkSize(): number {
  return isAppleHost() ? FLASH_WRITE_CHUNK_MAC : FLASH_WRITE_CHUNK_OTHER;
}

// Standard CRC-32 (IEEE 802.3) with reflected input/output and final XOR.
// Matches the crc32_calculate helper in blisp's lib/blisp_util.c. Distinct
// from the no-final-XOR variant we use for DFU suffix CRCs in dfu.ts.
const CRC32_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array, end = bytes.length): number {
  let crc = 0xffffffff;
  for (let index = 0; index < end; index += 1) {
    crc = (CRC32_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeU16LE(buf: Uint8Array, offset: number, value: number) {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
}

function writeU32LE(buf: Uint8Array, offset: number, value: number) {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
  buf[offset + 2] = (value >>> 16) & 0xff;
  buf[offset + 3] = (value >>> 24) & 0xff;
}

// Builds the 176-byte boot header that tells the BL70x ROM to load a RAM
// image at TCM 0x22010000. Mirrors blisp_easy_load_ram_app's hand-built
// struct exactly. We set crc_ignore + hash_ignore so the chip doesn't try
// to validate the (we leave them as 0xDEADBEEF placeholders) trailing CRC
// or hash bytes.
export function buildRamLoadBootHeader(tcmAddress = BL70X_TCM_ADDRESS): Uint8Array {
  const header = new Uint8Array(176);
  // 0..3: magiccode "BFNP"
  header.set(new TextEncoder().encode("BFNP"), 0);
  // 4..7: revison
  writeU32LE(header, 4, 0x01);
  // 8..11: flashCfg.magiccode "FCFG"
  header.set(new TextEncoder().encode("FCFG"), 8);
  // 12..95: SPI_Flash_Cfg_Type fields (84 bytes). Values copied from
  // blisp_easy_load_ram_app — they describe a generic Winbond-style 4 KiB
  // sector flash, which is what the Pinecil's onboard chip uses.
  let o = 12;
  header[o++] = 0x04; // ioMode
  header[o++] = 0x01; // cReadSupport
  header[o++] = 0x01; // clkDelay
  header[o++] = 0x01; // clkInvert
  header[o++] = 0x66; // resetEnCmd
  header[o++] = 0x99; // resetCmd
  header[o++] = 0xff; // resetCreadCmd
  header[o++] = 0x03; // resetCreadCmdSize
  header[o++] = 0x9f; // jedecIdCmd
  header[o++] = 0x00; // jedecIdCmdDmyClk
  header[o++] = 0x9f; // qpiJedecIdCmd
  header[o++] = 0x00; // qpiJedecIdCmdDmyClk
  header[o++] = 0x04; // sectorSize
  header[o++] = 0xef; // mid
  writeU16LE(header, o, 0x100); o += 2; // pageSize
  header[o++] = 0xc7; // chipEraseCmd
  header[o++] = 0x20; // sectorEraseCmd
  header[o++] = 0x52; // blk32EraseCmd
  header[o++] = 0xd8; // blk64EraseCmd
  header[o++] = 0x06; // writeEnableCmd
  header[o++] = 0x02; // pageProgramCmd
  header[o++] = 0x32; // qpageProgramCmd
  header[o++] = 0x00; // qppAddrMode
  header[o++] = 0x0b; // fastReadCmd
  header[o++] = 0x01; // frDmyClk
  header[o++] = 0x0b; // qpiFastReadCmd
  header[o++] = 0x01; // qpiFrDmyClk
  header[o++] = 0x3b; // fastReadDoCmd
  header[o++] = 0x01; // frDoDmyClk
  header[o++] = 0xbb; // fastReadDioCmd
  header[o++] = 0x00; // frDioDmyClk
  header[o++] = 0x6b; // fastReadQoCmd
  header[o++] = 0x01; // frQoDmyClk
  header[o++] = 0xeb; // fastReadQioCmd
  header[o++] = 0x02; // frQioDmyClk
  header[o++] = 0xeb; // qpiFastReadQioCmd
  header[o++] = 0x02; // qpiFrQioDmyClk
  header[o++] = 0x02; // qpiPageProgramCmd
  header[o++] = 0x50; // writeVregEnableCmd
  header[o++] = 0x00; // wrEnableIndex
  header[o++] = 0x01; // qeIndex
  header[o++] = 0x00; // busyIndex
  header[o++] = 0x01; // wrEnableBit
  header[o++] = 0x01; // qeBit
  header[o++] = 0x00; // busyBit
  header[o++] = 0x02; // wrEnableWriteRegLen
  header[o++] = 0x01; // wrEnableReadRegLen
  header[o++] = 0x01; // qeWriteRegLen
  header[o++] = 0x01; // qeReadRegLen
  header[o++] = 0xab; // releasePowerDown
  header[o++] = 0x01; // busyReadRegLen
  // readRegCmd[4]
  header[o++] = 0x05; header[o++] = 0x35; header[o++] = 0x00; header[o++] = 0x00;
  // writeRegCmd[4]
  header[o++] = 0x01; header[o++] = 0x31; header[o++] = 0x00; header[o++] = 0x00;
  header[o++] = 0x38; // enterQpi
  header[o++] = 0xff; // exitQpi
  header[o++] = 0x20; // cReadMode
  header[o++] = 0xff; // cRExit
  header[o++] = 0x77; // burstWrapCmd
  header[o++] = 0x03; // burstWrapCmdDmyClk
  header[o++] = 0x02; // burstWrapDataMode
  header[o++] = 0x40; // burstWrapData
  header[o++] = 0x77; // deBurstWrapCmd
  header[o++] = 0x03; // deBurstWrapCmdDmyClk
  header[o++] = 0x02; // deBurstWrapDataMode
  header[o++] = 0xf0; // deBurstWrapData
  writeU16LE(header, o, 0x12c); o += 2; // timeEsector
  writeU16LE(header, o, 0x4b0); o += 2; // timeE32k
  writeU16LE(header, o, 0x4b0); o += 2; // timeE64k
  writeU16LE(header, o, 0x05);  o += 2; // timePagePgm
  writeU16LE(header, o, 0xd40); o += 2; // timeCe
  header[o++] = 0x03; // pdDelay
  header[o++] = 0x00; // qeData
  // 96..99: flashCfg.crc32 (precomputed in blisp; chip ignores it because
  // crc_ignore is set in bootcfg)
  writeU32LE(header, 96, 0xc4bdd748);
  // 100..103: clkCfg.magiccode (left as 0 to match blisp; chip ignores it).
  // 104..111: sys_clk_cfg_t
  header[104] = 0x04; // xtal_type
  header[105] = 0x04; // pll_clk
  header[106] = 0x00; // hclk_div
  header[107] = 0x01; // bclk_div
  header[108] = 0x02; // flash_clk_type
  header[109] = 0x00; // flash_clk_div
  // 110..111: rsvd[2] = 0
  // 112..115: clkCfg.crc32
  writeU32LE(header, 112, 0x824e14bb);
  // 116..119: bootcfg.wval — bit-packed config flags. Match blisp:
  //   no_segment=1 (bit 8), cache_enable=1 (bit 9),
  //   crc_ignore=1 (bit 16), hash_ignore=1 (bit 17). All others 0.
  writeU32LE(header, 116, 0x00030300);
  // 120..123: segment_info.segment_cnt = 1
  writeU32LE(header, 120, 0x01);
  // 124..127: bootentry = 0
  // 128..131: flashoffset (here used as the TCM destination address)
  writeU32LE(header, 128, tcmAddress >>> 0);
  // 132..163: hash[32] — placeholder magic bytes (deadbeef + zeros)
  header[132] = 0xef; header[133] = 0xbe; header[134] = 0xad; header[135] = 0xde;
  // 164..167: rsv1, 168..171: rsv2 (both 0)
  // 172..175: crc32 placeholder
  writeU32LE(header, 172, 0xdeadbeef);
  return header;
}

// Builds the 16-byte segment header that precedes a RAM segment payload.
// Layout: dest_addr (u32 LE) + length (u32 LE) + reserved (u32 LE) +
// crc32 (u32 LE over the first 12 bytes).
export function buildRamSegmentHeader(destAddress: number, length: number): Uint8Array {
  const header = new Uint8Array(16);
  writeU32LE(header, 0, destAddress >>> 0);
  writeU32LE(header, 4, length >>> 0);
  writeU32LE(header, 8, 0);
  writeU32LE(header, 12, crc32(header, 12));
  return header;
}

// Minimal session interface used by this module. Lets us unit-test the
// pipeline without spinning up Web Serial.
export interface BlispCommandSession {
  command(
    command: number,
    payload?: Uint8Array,
    addChecksum?: boolean,
    expectPayload?: boolean
  ): Promise<Uint8Array>;
  write(bytes: Uint8Array): Promise<void>;
}

// Loads `eflashLoaderBytes` (the BL70x eflash_loader.bin) into TCM RAM and
// triggers the chip to start running it. After this returns, the caller is
// expected to do a fresh handshake (BLISP 'U' burst, no BOUFFALOLAB probe)
// before issuing eflash_loader commands like flash_read.
export async function loadEflashLoader(
  session: BlispCommandSession,
  eflashLoaderBytes: Uint8Array,
  onProgress?: (event: FlashProgress) => void
): Promise<void> {
  // 1. Send the boot header (cmd 0x11). 176 bytes. No checksum.
  onProgress?.({
    phase: "detect",
    message: "Loading eflash_loader (boot header)",
    current: 0,
    total: eflashLoaderBytes.length
  });
  await session.command(0x11, buildRamLoadBootHeader(), false, false);

  // 2. Send the segment header (cmd 0x17). 16 bytes. No checksum.
  onProgress?.({
    phase: "detect",
    message: "Loading eflash_loader (segment header)",
    current: 0,
    total: eflashLoaderBytes.length
  });
  await session.command(
    0x17,
    buildRamSegmentHeader(BL70X_TCM_ADDRESS, eflashLoaderBytes.length),
    false,
    true
  );

  // 3. Stream the eflash_loader bytes via cmd 0x18. Chunks must respect the
  // host platform's USB CDC limits.
  const chunkSize = segmentChunkSize();
  for (let offset = 0; offset < eflashLoaderBytes.length; offset += chunkSize) {
    const chunk = eflashLoaderBytes.slice(offset, offset + chunkSize);
    await session.command(0x18, chunk, false, false);
    onProgress?.({
      phase: "detect",
      message: `Loading eflash_loader (${offset + chunk.length} of ${eflashLoaderBytes.length} bytes)`,
      current: offset + chunk.length,
      total: eflashLoaderBytes.length
    });
  }

  // 4. check_image (cmd 0x19) — chip verifies what we just sent.
  onProgress?.({
    phase: "detect",
    message: "Verifying eflash_loader image",
    current: eflashLoaderBytes.length,
    total: eflashLoaderBytes.length
  });
  await session.command(0x19, new Uint8Array(), false, false);

  // 5. BL70x ERRATA — instead of run_image (cmd 0x1A) the chip needs three
  // write_memory (cmd 0x50) pokes to actually start the loaded RAM app.
  // The third call deliberately does not wait for a response because the
  // chip is mid-jump and won't reply.
  await writeMemory(session, 0x4000f100, 0x4e424845, true);
  await writeMemory(session, 0x4000f104, 0x22010000, true);
  await writeMemory(session, 0x40000018, 0x00000002, false);
}

async function writeMemory(
  session: BlispCommandSession,
  address: number,
  value: number,
  waitForResponse: boolean
): Promise<void> {
  const payload = new Uint8Array(8);
  writeU32LE(payload, 0, address >>> 0);
  writeU32LE(payload, 4, value >>> 0);
  if (waitForResponse) {
    await session.command(0x50, payload, true, false);
  } else {
    // Send the framed command without waiting for OK. The chip is jumping
    // to the loaded RAM app and will not respond.
    const framed = new Uint8Array(4 + payload.length);
    framed[0] = 0x50;
    framed[2] = payload.length & 0xff;
    framed[3] = (payload.length >>> 8) & 0xff;
    framed.set(payload, 4);
    let sum = framed[2] + framed[3];
    for (const b of payload) sum += b;
    framed[1] = sum & 0xff;
    await session.write(framed);
  }
}

// Reads `length` bytes from flash starting at `address` (a flash offset, e.g.
// 0x2000 for the IronOS firmware on Pinecil V2). Splits into chunks because
// some host stacks dislike very large response packets. Caller must have
// already loaded the eflash_loader and re-handshaked.
//
// `chunkSize` defaults to 256, well below blisp's tx_size-8 = 2048 ceiling
// — we keep it small both for compatibility with chips that choke on large
// transfers and to make the very first request return a recognizable
// response quickly (so a buggy chip state surfaces fast instead of after
// a 2048-byte fanout).
export async function flashRead(
  session: BlispCommandSession,
  address: number,
  length: number,
  chunkSize = 256
): Promise<Uint8Array> {
  const out = new Uint8Array(length);
  let offset = 0;
  while (offset < length) {
    const want = Math.min(chunkSize, length - offset);
    const payload = new Uint8Array(8);
    writeU32LE(payload, 0, (address + offset) >>> 0);
    writeU32LE(payload, 4, want >>> 0);
    const data = await session.command(0x32, payload, true, true);
    if (data.length === 0) break;
    const slice = data.length > want ? data.slice(0, want) : data;
    out.set(slice, offset);
    offset += slice.length;
    if (slice.length < want) break; // chip returned short — stop
  }
  return out.slice(0, offset);
}

// Scans a flash dump for an embedded IronOS BUILD_VERSION string. Per
// source/version.h the format is: `v<major>.<minor>` optionally followed by
// a single build-type letter (R/T/D/B/G/H/S/V) and optionally a `.` plus an
// 8-character commit hash. Examples: "v2.23", "v2.22H", "v2.22D.1A2B3C4D".
// Returns the first match found, or undefined.
export function findIronOsVersion(bytes: Uint8Array): string | undefined {
  // Treat the dump as latin1 so every byte maps 1:1 to a code unit. The
  // version literal itself is pure ASCII so this is safe.
  const text = new TextDecoder("latin1").decode(bytes);
  const match = text.match(/v[12]\.\d{1,2}(?:[A-Z](?:\.[A-Fa-f0-9]{6,12})?)?/);
  return match?.[0];
}

// Reads flash incrementally and returns the first IronOS version string it
// finds, stopping as soon as a match shows up. On Pinecil V2 the version
// literal sits in .rodata roughly 170 KiB into the firmware (past the vector
// table, code, and most static data), so the default scan covers the full
// 256 KiB IronOS firmware region before giving up. The eflash_loader paces
// each individual flash_read at chunkSize bytes; the optional onProgress
// callback fires after every chunk so the caller can update the UI during
// what is otherwise a multi-second scan.
//
// We pad each scan window with the tail of the previous one so a literal
// straddling a chunk boundary still matches the regex.
export async function findIronOsVersionInFlash(
  session: BlispCommandSession,
  startAddress: number,
  maxBytes = 256 * 1024,
  chunkSize = 1024,
  onProgress?: (scanned: number, total: number) => void
): Promise<{ version?: string; bytesScanned: number }> {
  const overlap = 32; // bytes carried across chunk boundaries
  let scratch: Uint8Array = new Uint8Array(0);
  let scanned = 0;
  while (scanned < maxBytes) {
    const want = Math.min(chunkSize, maxBytes - scanned);
    const chunk = await flashRead(session, startAddress + scanned, want, chunkSize);
    if (chunk.length === 0) break;
    // Concatenate previous tail + new chunk and scan the union.
    const merged = new Uint8Array(scratch.length + chunk.length);
    merged.set(scratch);
    merged.set(chunk, scratch.length);
    const found = findIronOsVersion(merged);
    if (found) return { version: found, bytesScanned: scanned + chunk.length };
    // Carry forward the last `overlap` bytes so a literal can still be found
    // if it spans this and the next chunk.
    scratch = merged.length > overlap ? merged.slice(merged.length - overlap) : merged;
    scanned += chunk.length;
    onProgress?.(scanned, maxBytes);
    if (chunk.length < want) break;
  }
  return { version: undefined, bytesScanned: scanned };
}

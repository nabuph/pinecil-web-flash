# BLISP Browser Port Assessment

This document captures what this project learned while porting the native
Pine64 `blisp` flashing flow into a browser app. It is meant as future
maintenance context for anyone touching Pinecil V2 flashing, Web Serial
connection handling, or the bundled BL70x eflash loader.

## Scope

The browser implementation lives primarily in:

- `lib/protocol/blisp.ts`: Web Serial transport, BLISP packet framing,
  handshakes, flash erase/write/check/reset, connection lifecycle handling.
- `lib/protocol/blisp-eflash.ts`: BL70x eflash_loader boot-header,
  segment-header, RAM loading, CRC helpers, flash-read helpers, version scan.
- `public/protocol/bl70x_eflash_loader.bin`: same-origin bundled loader
  binary used to gain flash access.
- `components/app-shell.tsx`: UI lifecycle, progress logging, disconnect
  handling, and installed-version display.

The target chip for Pinecil V2 is BL706/BL70x. Native `blisp` is the reference
implementation, but browser constraints require some deliberate adaptations.

## High-Level Flash Flow

For Pinecil V2 firmware `.bin` files from IronOS, the browser app does not
write flash at `0x0000`. It writes the firmware payload at `0x2000`, preserving
the existing boot header already on the iron.

The working sequence is:

1. Open a Web Serial session at 460800 baud, 8N1, no flow control, with a large
   read buffer.
2. Handshake with the BL70x ROM bootloader using the ROM wake-up probe plus a
   burst of `0x55` bytes, scanning the reply for `OK`.
3. Read boot info when talking to ROM.
4. Load Bouffalo's BL70x `eflash_loader` RAM application into TCM at
   `0x22010000`:
   - command `0x11`: 176-byte boot header
   - command `0x17`: 16-byte segment header
   - command `0x18`: chunked loader data
   - command `0x19`: check image
   - command `0x50` three times: BL70x jump errata workaround instead of
     normal `run_image`
5. Re-handshake with the running eflash_loader using only the `0x55` burst.
   Do not send the ROM `BOUFFALOLAB5555RESET` probe to the loader.
6. Erase the firmware range using `flash_erase` command `0x30`.
7. Write firmware chunks using `flash_write` command `0x31`.
8. Run `program_check` command `0x3A`.
9. Scan the written firmware region with `flash_read` command `0x32` to report
   the installed IronOS version.
10. Send reset command `0x21`; the device may disconnect or reset immediately.

## Critical Details

### Preserve The Installed Boot Header

Plain `Pinecilv2_*.bin` IronOS firmware files are treated as payload-only
images at flash offset `0x2000`. Earlier experiments showed why this matters:
writing a generated boot header to `0x0000` is high risk in a browser flow,
because a partial or malformed boot-header write can brick the iron.

The BL70x boot header field layout is also easy to get wrong. The firmware
offset belongs at byte `128` (`flashoffset`) of the 176-byte boot header. Byte
`132` is the start of `hash[0]`, not the flash offset.

The project still has `buildPinecilV2BootHeader()` and tests for the layout,
but `parseBlispFirmware()` intentionally returns `needsBootHeader: false` for
Pinecil V2 firmware.

### eflash_loader Is Required For Flash Access

The ROM bootloader can handshake, report boot info, and load a RAM image, but
it cannot erase/program/read flash directly. Real flash operations require
loading and running `bl70x_eflash_loader.bin`, then speaking the same BLISP
packet framing to that RAM app.

The eflash_loader stage differs from ROM in two important ways:

- The loader does not need the ROM reset probe. Send only the `0x55` burst and
  scan for `OK`.
- Some probes such as `get_boot_info` may return BLISP failure frames once the
  loader is running. Treating that as "not connected" and falling back to ROM
  traffic can desynchronize the session.

The current code refreshes an already-running loader by trying an eflash_loader
handshake first. If the stream looks stale, it reopens the serial session and
tries the loader handshake again before considering the ROM load path.

### Web Serial Read Robustness

Web Serial reads cannot be implemented as a naive `Promise.race(reader.read(),
timeout)`. If the timeout wins while the read later resolves, bytes are lost and
the protocol appears to hang.

`SerialBlispSession` keeps:

- an internal byte buffer for data already received but not yet consumed
- a pending `reader.read()` promise carried across timeouts

This prevents late bytes from being discarded and was essential for making
command ACK handling reliable.

### Web Serial Write Robustness

Each command write clones the frame, waits for `writer.ready`, writes, waits for
`writer.ready` again, then yields briefly. Browser streams do not expose the
same drain primitive as native serial libraries, so this is the closest
available approximation.

The serial port is opened with:

- baud: `460800`
- data bits: `8`
- stop bits: `1`
- parity: `none`
- flow control: `none`
- buffer size: `64 * 1024`

The larger buffer was a key fix for intermittent Web Serial stalls during both
loader loading and flash writes.

### Chunk Sizes And Pacing

Known-good browser settings currently are:

- eflash_loader RAM load chunk: `4032` bytes (`252 * 16`)
- firmware flash write chunk: `372` bytes
- flash write inter-chunk delay: `10 ms`
- write flush yield after Web Serial writes: `5 ms`

The `372` byte flash write chunk mirrors the conservative native `blisp` macOS
path and has been the most reliable browser value tested. Larger chunks and
smaller chunks both had failure modes during hardware testing.

The project briefly tested removing the `10 ms` inter-chunk delay. It made the
happy path faster, but physical Pinecil V2 tests produced early
`flash_write` timeouts and retries, including failures around the first few KiB
of firmware. Because of that, the shipped default remains `10 ms`.

### Timeouts And Late ACK Handling

Erase and program-check operations need much longer timeouts than basic BLISP
commands:

- erase timeout scales by 4 KiB sector count and is clamped between 30 s and
  120 s
- program check uses a 120 s timeout

For flash writes, the current code waits for a normal OK, then tries a late OK
window if the command times out. If an ACK appears late or in trailing buffered
data, the write is considered complete. Otherwise the same chunk is retried up
to three times. Rewriting identical data into already-erased/already-written
flash is acceptable because it does not require changing bits from 0 back to 1.

## Browser-Specific Adaptations

### Permission And Port Selection

Browsers cannot silently grant a serial port the first time. The user must pick
the port at least once.

After permission exists, the app can call `navigator.serial.getPorts()` and
auto-select a previously authorized port. Current behavior:

- If exactly one authorized port matches the known Pinecil V2 USB serial ID
  (`1a86:55d4`), use it.
- If no authorized port has matching USB IDs but exactly one authorized serial
  port exists, use it. This handles macOS/Chrome cases where the picker shows
  the device as `CDC Virtual ComPort (... ) - Paired` but `getInfo()` does not
  expose the expected IDs.
- If multiple candidates exist, open the picker.
- The manual picker is intentionally broad. A strict VID/PID filter caused the
  Pinecil serial port to disappear on at least one tested setup.

### Disconnect Handling

USB and Bluetooth disconnect events must be source-aware. A stale event from an
old backend can otherwise clear state for a newer connection during quick
unplug/replug cycles.

Current handling:

- `WebSerialBlispFlasher.onDisconnect(source)` only clears UI state if `source`
  is the active backend.
- `WebUsbDfuFlasher.onDisconnect(source)` provides similar immediate unplug
  handling for V1 DFU.
- `PinecilBleClient.onDisconnect(source)` clears Bluetooth state when the
  normal-mode BLE connection drops.
- Expected post-flash resets are handled without showing a misleading USB
  unplug warning.
- Close paths tolerate already-closed/already-disconnected devices.

### Logging

The app now distinguishes normal user-facing progress from trace progress.

Production hides trace entries such as:

- eflash_loader chunk progress
- BLISP timing details
- flash-read scan progress
- per-block/chunk write progress

Development builds keep those entries visible, which is useful during hardware
debugging. The status text and progress bar still update from trace events in
production; only the activity log is filtered.

## Installed Firmware Version Detection

The browser app reads flash through eflash_loader to recover the installed
IronOS version string.

On connect:

- load eflash_loader if possible
- read/scan from firmware offset `0x2000`
- display the installed IronOS version in the sidebar

After flashing:

- run program check first
- scan only the just-written firmware payload length
- update the connected target with the new version

Limiting post-flash scanning to the written payload matters when downgrading.
Otherwise stale version strings in erased-but-not-rewritten tail regions can
produce confusing results.

## Observed Hardware Behavior

The following came from Pinecil V2 hardware testing:

- Loading eflash_loader and flashing firmware works reliably with:
  - 64 KiB Web Serial buffer
  - 4032-byte loader chunks
  - 372-byte flash chunks
  - 10 ms inter-chunk flash write delay
- Removing flash write delay can succeed, but also caused flaky failures:
  - early `flash_write` timeout near the first few KiB
  - retry loops that sometimes recovered and sometimes failed
  - follow-on loader-state confusion after reconnect
- Version read before/after flash works, but failed/partial sessions can leave
  the chip in ROM or eflash_loader state. The refresh path must therefore probe
  carefully and avoid sending ROM traffic to a running loader.
- The serial picker on macOS may label the device as a paired `CDC Virtual
  ComPort` and may not expose the expected USB IDs for filtering.

## Open Questions

### Can Flashing Be Faster Without Losing Reliability?

Maybe, but not by simply removing all pacing. Zero-delay writes were observed
to be faster when they worked, but not robust enough to ship.

Future experiments should be hardware-gated and measured with full logs:

- Try intermediate delays: 2 ms, 5 ms, 8 ms.
- Try adaptive pacing: start fast, back off on first late OK or retry.
- Try maintaining 10 ms for the first N KiB and reducing delay after the loader
  appears stable.
- Try different chunk sizes only one variable at a time. Larger chunks may
  reduce command count but increase serial/loader pressure.
- Record total flash time, retry count, failure address, and whether the next
  reconnect starts in ROM or eflash_loader.

Any speed change should be validated across repeated flashes, downgrade and
upgrade directions, and unplug/replug cycles.

### Can We Identify Pinecil Ports More Precisely?

The known USB ID match is useful but not sufficient on all platforms. The
browser does not expose the display name shown in the serial picker, so the app
cannot directly match `CDC Virtual ComPort (cu.usbmodem0000000200001)`.

Possible future paths:

- Keep using the single-authorized-port fallback.
- Add a user-visible "remember this port" setting once a selected port proves
  it can complete a BLISP handshake.
- Log `port.getInfo()` in dev builds after successful connect to gather more
  real-world VID/PID combinations.

### Should Connect-Time Version Reads Be Optional?

Reading the installed version is helpful, but it requires loading eflash_loader
before the user clicks Flash. That means the chip may already be running the
loader when flashing starts. The current refresh path handles this, but it adds
complexity.

An option to skip connect-time version reads could make connection simpler at
the cost of losing sidebar version display until after flashing.

### Can Production Logs Be Even Quieter?

The production log is much cleaner than the dev log, but some operational
milestones are still visible. If the app becomes user-facing beyond development
testing, consider collapsing routine BLISP milestones into a single "Preparing
flash session" entry while preserving detailed errors.

## Maintenance Guidance

- Do not reintroduce boot-header writes for normal Pinecil V2 firmware unless
  there is a strong, tested reason.
- Keep ROM and eflash_loader handshake behavior separate.
- Treat `FL` responses as meaningful state, not just generic failures.
- Avoid canceling read promises on timeout; preserve pending reads.
- Make Web Serial changes with hardware testing, not unit tests alone.
- Keep production log filtering separate from dev trace availability.
- When changing pacing or chunk sizes, document the exact hardware test matrix
  and failure addresses.

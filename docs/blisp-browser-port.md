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
6. Read and validate the installed 176-byte boot header before a payload-only
   firmware update.
7. Erase the firmware range using `flash_erase` command `0x30`.
8. Write firmware chunks using `flash_write` command `0x31`.
9. Run `program_check` command `0x3A`.
10. Read the complete written region back with `flash_read` command `0x32` and
    require its SHA-256 to match the source payload.
11. Extract the installed IronOS version from the verified read-back bytes.
12. Send reset command `0x21`; the device may disconnect or reset immediately.

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

Before erasing firmware, the browser reads the existing header and requires:

- `BFNP` and `FCFG` magic values
- payload offset `0x2000`
- payload-only (`no_segment`) boot configuration
- image-hash checking disabled, because the preserved header cannot contain the
  hash of the replacement payload

If this preflight fails, the browser refuses to write and directs the user to
native `blisp` for boot-header recovery.

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

Fresh and refreshed sessions first try one eflash_loader U-only handshake. A
normal boot-info version classifies ROM, `ff.ff.ff.ff` classifies the loader,
and a boot-info `FL` response is also accepted as a loader variant. Only after a
clean close/reopen does the code fall back to the ROM reset-probe handshake.
This prevents ROM reset traffic and stale command responses from being sent to
or mistaken for an already-running loader.

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

For flash writes, the code waits for a normal OK, then continues waiting through
one late-ACK window if the command times out. If that deadline also expires, the
operation fails closed and reopens the serial session; it never resends the
ambiguous write. BLISP responses have no transaction IDs, so a retry plus two
eventual OK frames would shift every subsequent response by one command.

All command response timeouts are absolute deadlines. Repeated `PD` pending
frames do not restart the timeout indefinitely.

### Input And Read-Back Integrity

The release bundler records SHA-256 for every downloaded archive. The browser
requires the selected firmware archive to match that catalog digest before
extraction. Legacy local catalogs created before digests were added remain
usable for hardware recovery/testing: the browser computes and logs their
archive SHA-256, then relies on the same payload validation and full device
read-back verification. The BLISP path also rejects firmware that is
undersized, blank, larger than the region before the boot-logo sector, or
intended for another model.

After `program_check`, the browser reads the entire payload back and compares
SHA-256 with the source bytes. A truncated read or digest mismatch is a hard
failure; version-string detection runs only on bytes that passed this check.

## Browser-Specific Adaptations

### Permission And Port Selection

Browsers cannot silently grant a serial port the first time. The user must pick
the port at least once.

After permission exists, the app calls `navigator.serial.getPorts()` only to
provide a useful log message. Current behavior:

- Always open the picker so the user confirms the port for the current action.
- Report whether one or more previously authorized ports—including known
  Pinecil V2 ID `1a86:55d4`—were found.
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
- Expected-disconnect handling is armed only immediately before the BLISP reset
  command or final DFU manifestation command. An unplug during erase, write, or
  verification is always reported as an unsafe cable disconnect.
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

- handshake with the BL70x ROM

From the sidebar:

- the user can explicitly click "Read version"
- the app loads eflash_loader if needed
- the app reads/scans from firmware offset `0x2000`
- the app displays the installed IronOS and BL70x boot ROM versions in the
  sidebar together

After flashing:

- run program check first
- read back and SHA-256 verify exactly the just-written payload length
- scan the verified read-back bytes for the version string
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

Reading the installed version is helpful, but it requires loading eflash_loader.
The app now skips this during connect and exposes an explicit sidebar action
instead. That keeps USB connect focused on proving BL70x bootloader access, then
lets the user opt into the more invasive flash-read path when they need it.

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
- Never resend a write after an ambiguous ACK timeout without first
  re-establishing a clean protocol boundary.
- Keep firmware bounds, archive digests, boot-header preflight, and read-back
  verification as hard gates before reporting success.
- Make Web Serial changes with hardware testing, not unit tests alone.
- Keep production log filtering separate from dev trace availability.
- When changing pacing or chunk sizes, document the exact hardware test matrix
  and failure addresses.

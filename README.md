# Pinecil Web Flash

A browser-based flashing and configuration tool for the [Pine64 Pinecil](https://pine64.org/devices/pinecil/) soldering iron — firmware updates, boot-logo customisation, and live Bluetooth telemetry/settings, all from a single web page.

**Live site:** https://natephillips3.github.io/pinecil-web-flash/

## Why a browser tool?

The two existing options for managing a Pinecil require installing software on your machine:

- **[PineFlash](https://github.com/Spagett1/PineFlash)** — a desktop GUI app you have to download, install, and trust to run on your operating system.
- **`dfu-util` / `blisp` from the command line** — direct flashing via the terminal. Powerful, but requires installing tooling, knowing the right commands, and managing driver/permission setup yourself.

**Pinecil Web Flash does it from any Chromium-based browser.** No install, no terminal, no platform-specific binary. The page connects directly to your iron over [WebUSB](https://developer.mozilla.org/en-US/docs/Web/API/WebUSB_API), [Web Serial](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API), and [Web Bluetooth](https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API) — flashing, validation, and BLE I/O all happen client-side in your browser tab.

For Pinecil V2 firmware flashing, the browser implementation recreates the core [blisp](https://github.com/pine64/blisp) flow in TypeScript: Web Serial handshake, BL70x eflash-loader RAM boot, erase/write/check, reset, and installed-version detection.

## Features

- **Firmware flashing** for both Pinecil V1 (DFU over WebUSB) and Pinecil V2 (BLISP over Web Serial), using official IronOS release assets sourced from GitHub.
- **Boot-logo studio** — drop in any image (including animated GIF/APNG), tweak threshold and pan/zoom, and get a properly-formatted `.dfu` file ready to flash. Or restore the default logo with one click.
- **Live Bluetooth telemetry** — sampled in real time on a Pinecil V2 running IronOS 2.21+. The app can read tip temperature, set point, handle temperature, DC input voltage, heater power level, power source, tip resistance, uptime, last movement, max temperature, raw tip signal, Hall sensor value, operating mode, and estimated wattage.
- **Bluetooth settings editor** — read and write runtime settings on a connected V2, with staged drafts and explicit save-to-flash.
- **SHA-256 verification** of every binary before it leaves your browser for the device.
- **Light / dark / system theme**, sticky activity log, and a no-device demo mode (local development only) so you can explore the UI without hardware.

## Browser support

You need a **desktop Chromium-based browser** — Chrome, Edge, Brave, Arc, etc. Safari, Firefox, and mobile browsers do not implement WebUSB/Web Serial/Web Bluetooth and will not work.

The app must be served from `https://` or `localhost` for browser hardware APIs to be available. USB, serial, and Bluetooth permission prompts are always user-initiated by the browser.

## Hardware support

| Device | Browser transport | Supported actions |
| --- | --- | --- |
| Pinecil V1 | WebUSB DFU | Firmware flashing and boot-logo flashing |
| Pinecil V2 | Web Serial BLISP | Firmware flashing and boot-logo flashing |
| Pinecil V2 running IronOS 2.21+ | Web Bluetooth | Live telemetry and runtime settings |

Hardware testing note: the Pinecil V2 paths have been tested end to end on real hardware. Pinecil V1 DFU support is implemented and covered by protocol tests, but this maintainer has not physically tested it on a V1 iron.

## Connecting your Pinecil

### USB (firmware + boot logo)

Use the USB-C port (not the DC barrel jack). Hold the **`-`** button while plugging in USB-C, keep holding for 10–15 seconds, then release. A black screen means flash mode is ready.

### Bluetooth (telemetry + settings)

Requires a Pinecil **V2** running IronOS **2.21 or newer**, powered normally (not in flash mode). On the iron: Settings → Bluetooth → set to **`+`** for full read/write access (`R` is read-only).

## Repository map

- `app/` - Next.js App Router pages, layout, manifest, and global styles.
- `components/` - the app shell, sidebar, firmware panel, boot-logo studio, Bluetooth panels, activity log, and shared UI.
- `lib/protocol/` - WebUSB DFU and Web Serial BLISP implementations, including the BL70x eflash-loader path.
- `lib/ble/` - Pinecil V2 Web Bluetooth client, telemetry decoding, and setting definitions.
- `lib/firmware/`, `lib/logo/`, and `lib/flash/` - firmware extraction, validation, boot-logo generation, hashing, and flash orchestration.
- `scripts/` - release bundling for static deployment.
- `tests/` - Vitest coverage for protocol logic, release catalog handling, BLE behavior, logo generation, UI flows, and the flash pipeline.
- `docs/` - maintenance notes and README assets.

## Tech stack

- [Next.js](https://nextjs.org/) 16 (App Router) with `output: "export"` for fully static deployment
- React 19
- Native [WebUSB](https://wicg.github.io/webusb/), [Web Serial](https://wicg.github.io/serial/), and [Web Bluetooth](https://webbluetoothcg.github.io/web-bluetooth/) — no third-party hardware libraries
- [`fflate`](https://github.com/101arrowz/fflate) for unzipping IronOS firmware archives
- [Vitest](https://vitest.dev/) for unit tests covering the DFU/BLISP/BLE protocol logic

## Troubleshooting notes

- If release selection works but flashing stays disabled, make sure firmware assets are being served from the same origin as the app.
- If Bluetooth telemetry works but setting writes fail, check that the iron's Bluetooth setting is `+`, not `R`.
- If USB connection fails, make sure the iron is in the correct mode: USB-C flash mode for firmware/logo updates, normal powered mode for Bluetooth.
- If the browser reports missing hardware APIs, switch to a desktop Chromium browser on `https://` or `localhost`.

## Disclaimer

This project is **not official, administered by, or endorsed by PINE64**. It is a community tool. Firmware images are fetched directly from the [Ralim/IronOS](https://github.com/Ralim/IronOS) GitHub releases — same source the official tooling uses.

Flashing your iron always carries some risk of bricking. The app surfaces safety confirmations and SHA-256 hashes before it writes anything, but you flash at your own risk.

## Links

- [Pinecil device page](https://pine64.org/devices/pinecil/)
- [IronOS firmware](https://github.com/Ralim/IronOS) (the official open-source firmware project)
- [PINE64 community](https://pine64.org/community/)

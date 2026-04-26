# Pinecil Web Flash

A browser-based flashing and configuration tool for the [Pine64 Pinecil](https://pine64.org/devices/pinecil/) soldering iron — firmware updates, boot-logo customisation, and live Bluetooth telemetry/settings, all from a single web page.

**Live site:** https://natephillips3.github.io/pinecil-web-flash/

## Why a browser tool?

The two existing options for managing a Pinecil require installing software on your machine:

- **[PineFlash](https://github.com/Spagett1/PineFlash)** — a desktop GUI app you have to download, install, and trust to run on your operating system.
- **`dfu-util` / `blisp` from the command line** — direct flashing via the terminal. Powerful, but requires installing tooling, knowing the right commands, and managing driver/permission setup yourself.

**Pinecil Web Flash does it from any Chromium-based browser.** No install, no terminal, no platform-specific binary. The page connects directly to your iron over [WebUSB](https://developer.mozilla.org/en-US/docs/Web/API/WebUSB_API), [Web Serial](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API), and [Web Bluetooth](https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API) — flashing, validation, and BLE I/O all happen client-side in your browser tab.

## Features

- **Firmware flashing** for both Pinecil V1 (DFU over WebUSB) and Pinecil V2 (BLISP over Web Serial), pulling official IronOS releases directly from GitHub.
- **Boot-logo studio** — drop in any image (including animated GIF/APNG), tweak threshold and pan/zoom, and get a properly-formatted `.dfu` file ready to flash. Or restore the default logo with one click.
- **Live Bluetooth telemetry** — tip temperature, set point, DC input, and estimated wattage, sampled in real time on a Pinecil V2 running IronOS 2.21+.
- **Bluetooth settings editor** — read and write runtime settings on a connected V2, with staged drafts and explicit save-to-flash.
- **SHA-256 verification** of every binary before it leaves your browser for the device.
- **Light / dark / system theme**, sticky activity log, and a no-device demo mode (local development only) so you can explore the UI without hardware.

## Browser support

You need a **desktop Chromium-based browser** — Chrome, Edge, Brave, Arc, etc. Safari, Firefox, and mobile browsers do not implement WebUSB/Web Serial/Web Bluetooth and will not work.

## Connecting your Pinecil

### USB (firmware + boot logo)

Use the USB-C port (not the DC barrel jack). Hold the **`-`** button while plugging in USB-C, keep holding for 10–15 seconds, then release. A black screen means flash mode is ready.

### Bluetooth (telemetry + settings)

Requires a Pinecil **V2** running IronOS **2.21 or newer**, powered normally (not in flash mode). On the iron: Settings → Bluetooth → set to **`+`** for full read/write access (`R` is read-only).

## Local development

```bash
npm install
npm run dev
```

Open http://127.0.0.1:3000. The local dev build keeps the demo (mock device) buttons enabled so you can iterate on the UI without an iron plugged in.

### Useful scripts

```bash
npm run dev         # Next.js dev server
npm run build       # Static export to ./out
npm run typecheck   # TypeScript only, no emit
npm test            # Vitest run once
npm run test:watch  # Vitest watch mode
```

### Tech stack

- [Next.js](https://nextjs.org/) 16 (App Router) with `output: "export"` for fully static deployment
- React 19
- Native [WebUSB](https://wicg.github.io/webusb/), [Web Serial](https://wicg.github.io/serial/), and [Web Bluetooth](https://webbluetoothcg.github.io/web-bluetooth/) — no third-party hardware libraries
- [`fflate`](https://github.com/101arrowz/fflate) for unzipping IronOS firmware archives
- [Vitest](https://vitest.dev/) for unit tests covering the DFU/BLISP/BLE protocol logic

## Deployment

The site is published to GitHub Pages on every push to `main` via [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml). The workflow builds the Next.js app to a static `out/` directory and uploads it as a Pages artifact.

Two env vars control the production build:

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_BASE_PATH` | Sub-path the site is served under (e.g. `/pinecil-web-flash`). Required for project pages. |
| `NEXT_PUBLIC_DISABLE_DEMO` | Set to `"true"` to hide the demo (mock device) buttons on the live site. |

## Disclaimer

This project is **not official, administered by, or endorsed by PINE64**. It is a community tool. Firmware images are fetched directly from the [Ralim/IronOS](https://github.com/Ralim/IronOS) GitHub releases — same source the official tooling uses.

Flashing your iron always carries some risk of bricking. The app surfaces safety confirmations and SHA-256 hashes before it writes anything, but you flash at your own risk.

## Links

- [Pinecil device page](https://pine64.org/devices/pinecil/)
- [IronOS firmware](https://github.com/Ralim/IronOS) (the official open-source firmware project)
- [PINE64 community](https://pine64.org/community/)

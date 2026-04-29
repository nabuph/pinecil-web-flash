"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_LANGUAGES, compatibleFirmwareReleases, findFirmwareAsset, findMetadataAsset, firmwareFileName, normalizeReleases, sampleReleases } from "@/lib/catalog/releases";
import { KNOWN_BLE_SETTINGS, PinecilBleClient } from "@/lib/ble/pinecil-ble";
import { prepareInstall, flashPrepared } from "@/lib/flash/pipeline";
import { extractFirmwareFromZip, parseLanguagesFromMetadata } from "@/lib/firmware/zip";
import { generateLogoFromImage } from "@/lib/logo/generator";
import { WebSerialBlispFlasher } from "@/lib/protocol/blisp";
import { buildDfuSeFile, parseDfuSuffix, WebUsbDfuFlasher } from "@/lib/protocol/dfu";
import type {
  BleSetting,
  BleSettingDraft,
  BleSnapshot,
  FirmwareRelease,
  FlashInput,
  FlashPhase,
  FlashProgress,
  FlashTarget,
  FlasherBackend,
  GeneratedLogo,
  LanguageOption,
  LogoPanOffset,
  PinecilModel,
  ReleaseChannel
} from "@/lib/types";
import { formatBytes, nowStamp, sha256Hex } from "@/lib/utils/hash";
import { AlertTriangle, Bluetooth, Loader2, Play, Unplug, Usb } from "lucide-react";
import { Sidebar, type Mode, type ModeAvailability, type ThemePreference } from "@/components/sidebar";
import { ActivityLog, type LogLine } from "@/components/activity-log";
import { FirmwarePanel } from "@/components/firmware-panel";
import { LogoStudio } from "@/components/logo-studio";
import { BlePanel, BleSettingsPanel } from "@/components/ble-panel";

const initialLogs: LogLine[] = [
  { time: "--:--:--", level: "INFO", message: "Pinecil Web Flash loaded." },
  { time: "--:--:--", level: "WARN", message: "Use a Chromium desktop browser for WebUSB, Web Serial, and Web Bluetooth." }
];

// Demo (mock device) controls are hidden on production builds when
// NEXT_PUBLIC_DISABLE_DEMO is set. Local dev and `npm run build` keep them.
const SHOW_DEMO = process.env.NEXT_PUBLIC_DISABLE_DEMO !== "true";

function isAnimatedImage(file: File) {
  return file.type.includes("gif") || file.type.includes("apng") || /\.apng$/i.test(file.name);
}

// requestPort()/requestDevice() reject with NotFoundError or AbortError when
// the user dismisses the picker without choosing anything. Treat those as
// "user changed their mind" rather than a real error so we don't spam the
// activity log.
function isUserCancellation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const name = (err as { name?: unknown }).name;
  return name === "NotFoundError" || name === "AbortError";
}

function makeBleDrafts(snapshot: BleSnapshot): BleSettingDraft[] {
  return snapshot.settings.map((setting) => ({
    ...setting,
    originalValue: setting.value,
    draftValue: setting.value,
    dirty: false
  }));
}

function makeMockFirmware(model: PinecilModel, language: string): Uint8Array {
  const payload = new TextEncoder().encode(`Pinecil ${model} ${language} demo firmware image`);
  if (model === "v1") return buildDfuSeFile(payload, 0x08004000);
  const bytes = new Uint8Array(256 * 1024);
  bytes.set(payload, 0);
  return bytes;
}

function makeMockBleSnapshot(): BleSnapshot {
  return {
    deviceName: "Pinecil V2 Bluetooth demo",
    buildId: "v2.23-demo",
    serial: "PC2V2-BLE-DEMO",
    uniqueId: "70:10:64:00:00:be:ef:02",
    readOnly: false,
    telemetry: {
      tipTempC: 31,
      setPointC: 320,
      handleTempC: 280,
      dcInputMv: 200,
      powerLevel: 0,
      powerSource: 1,
      tipResistance: 62,
      uptimeSeconds: 1280,
      lastMovementSeconds: 80,
      maxTempC: 450,
      rawTip: 1840,
      hallSensor: 0,
      operatingMode: 0,
      estimatedWatts: 420
    },
    settings: KNOWN_BLE_SETTINGS.map((setting) => ({ ...setting }))
  };
}

function WorkspaceSplash({
  busy,
  bluetoothConnectDisabled,
  usbConnectDisabled,
  message,
  onConnectBluetoothDemo,
  onConnectBluetooth,
  onConnectPinecil,
  onConnectDemo,
  showBluetoothActions,
  showConnectAction,
  showUsbActions,
  title
}: {
  busy: boolean;
  bluetoothConnectDisabled: boolean;
  usbConnectDisabled: boolean;
  message: string;
  onConnectBluetoothDemo(): void;
  onConnectBluetooth(): void;
  onConnectPinecil(): void;
  onConnectDemo(): void;
  showBluetoothActions: boolean;
  showConnectAction: boolean;
  showUsbActions: boolean;
  title: string;
}) {
  return (
    <div className="panel-section">
      <div className="section-heading">
        <div className="section-heading-text">
          <h2>{title}</h2>
          <p>{message}</p>
        </div>
      </div>
      <div className="device-splash-guides">
        {showUsbActions ? (
          <section className="device-splash-guide splash-card">
            <div className="device-splash-guide-body splash-card-body">
              <h3>USB flashing</h3>
              <p>
                Use only the USB-C port, not the DC barrel jack. Hold [-] before plugging USB-C into the Pinecil,
                keep holding for 10-15 seconds, then release. A black screen means flash mode is ready for
                firmware or boot logo updates.
              </p>
              <div className="device-splash-guide-actions">
                {showConnectAction ? (
                  <button className="btn btn-primary" disabled={usbConnectDisabled} onClick={onConnectPinecil} type="button">
                    {busy ? <Loader2 className="spin" size={14} /> : <Usb size={14} />}
                    Connect USB
                  </button>
                ) : null}
                {SHOW_DEMO ? (
                  <button className="btn btn-icon" aria-label="USB demo" disabled={busy} onClick={onConnectDemo} type="button">
                    <Play size={14} />
                  </button>
                ) : null}
              </div>
            </div>
          </section>
        ) : null}
        {showBluetoothActions ? (
          <section className="device-splash-guide splash-card">
            <div className="device-splash-guide-body splash-card-body">
              <h3>Bluetooth telemetry and settings</h3>
              <p>
                Bluetooth needs a Pinecil V2 on IronOS 2.21 or newer, powered normally instead of flash mode.
                On the iron, open Settings, find Bluetooth, and set it to + for full access. R is read-only, so
                telemetry works but setting writes are blocked.
              </p>
              <div className="device-splash-guide-actions">
                <button className="btn btn-primary" disabled={bluetoothConnectDisabled} onClick={onConnectBluetooth} type="button">
                  {busy ? <Loader2 className="spin" size={14} /> : <Bluetooth size={14} />}
                  Connect Bluetooth
                </button>
                {SHOW_DEMO ? (
                  <button className="btn btn-icon" aria-label="Bluetooth demo" disabled={busy} onClick={onConnectBluetoothDemo} type="button">
                    <Play size={14} />
                  </button>
                ) : null}
              </div>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

type BleTelemetrySample = {
  at: number;
  telemetry: Record<string, number>;
};

export function AppShell() {
  const [theme, setTheme] = useState<ThemePreference>("system");
  const [releases, setReleases] = useState<FirmwareRelease[]>(() => sampleReleases());
  const [releaseChannel, setReleaseChannel] = useState<ReleaseChannel>("stable");
  const [selectedReleaseTag, setSelectedReleaseTag] = useState("v2.23.0");
  const [mode, setMode] = useState<Mode>();
  const [language, setLanguage] = useState("EN");
  const [languages, setLanguages] = useState<LanguageOption[]>(DEFAULT_LANGUAGES);
  const [target, setTarget] = useState<FlashTarget>();
  const [phase, setPhase] = useState<FlashPhase>("connect");
  const [progress, setProgress] = useState(0);
  const [progressMessage, setProgressMessage] = useState("Waiting for device access.");
  const [logs, setLogs] = useState<LogLine[]>(initialLogs);
  const [activityOpen, setActivityOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [logoBusy, setLogoBusy] = useState(false);
  const [confirmations, setConfirmations] = useState([false, false, false]);
  const [prereleaseConfirmed, setPrereleaseConfirmed] = useState(false);
  const [logoThreshold, setLogoThreshold] = useState(128);
  const [logoInvert, setLogoInvert] = useState(false);
  const [logoPan, setLogoPan] = useState<LogoPanOffset>({ x: 0, y: 0, zoom: 1 });
  const [logoImageFile, setLogoImageFile] = useState<File>();
  const [logoDfuFile, setLogoDfuFile] = useState<File>();
  const [generatedLogo, setGeneratedLogo] = useState<GeneratedLogo>();
  const [bleSnapshot, setBleSnapshot] = useState<BleSnapshot>();
  const [bleDemo, setBleDemo] = useState(false);
  const [bleTelemetryPolling, setBleTelemetryPolling] = useState(false);
  const [bleTelemetryHistory, setBleTelemetryHistory] = useState<BleTelemetrySample[]>([]);
  const [bleDrafts, setBleDrafts] = useState<BleSettingDraft[]>(() =>
    makeBleDrafts({ deviceName: "Pinecil V2", readOnly: false, telemetry: {}, settings: KNOWN_BLE_SETTINGS })
  );
  const [browserSupport, setBrowserSupport] = useState({
    webUsb: false,
    webSerial: false,
    webBluetooth: false
  });
  const [browserCapable, setBrowserCapable] = useState<boolean | null>(null);

  const backendRef = useRef<FlasherBackend | undefined>(undefined);
  const bleRef = useRef<PinecilBleClient | undefined>(undefined);
  const logoBuildIdRef = useRef(0);
  const motionReadyRef = useRef(false);
  const preserveDoneOnDisconnectRef = useRef(false);
  const skipNextSelectionResetRef = useRef(false);

  const addLog = useCallback((level: LogLine["level"], message: string) => {
    setLogs((current) => [...current, { time: nowStamp(), level, message }].slice(-90));
  }, []);

  // Forward BLISP-internal progress and soft errors (e.g. eflash_loader load
  // failures during connect) into the activity log. Static hookup; the log
  // module is shared across all WebSerialBlispFlasher instances.
  useEffect(() => {
    const showTraceLog = process.env.NODE_ENV !== "production";
    WebSerialBlispFlasher.onLog = (level, message, options) => {
      if (!options?.trace || showTraceLog) addLog(level, message);
    };
    return () => {
      WebSerialBlispFlasher.onLog = () => undefined;
    };
  }, [addLog]);

  const disconnectListenerRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    // Wire physical-cable-unplug detection. The SerialPort's "disconnect"
    // event fires from the BLISP backend and WebUSB's equivalent fires from
    // the DFU backend. Source checks prevent stale backends from clearing a
    // newer connection during quick unplug/replug cycles.
    WebSerialBlispFlasher.onDisconnect = (source) => {
      if (backendRef.current !== source) return;
      if (!preserveDoneOnDisconnectRef.current) addLog("WARN", "USB cable disconnected.");
      disconnectListenerRef.current();
    };
    WebUsbDfuFlasher.onDisconnect = (source) => {
      if (backendRef.current !== source) return;
      if (!preserveDoneOnDisconnectRef.current) addLog("WARN", "USB cable disconnected.");
      disconnectListenerRef.current();
    };
    return () => {
      WebSerialBlispFlasher.onDisconnect = () => undefined;
      WebUsbDfuFlasher.onDisconnect = () => undefined;
    };
  }, [addLog]);

  const appendBleTelemetry = useCallback((telemetry: Record<string, number>, at = Date.now()) => {
    setBleTelemetryHistory((history) => [...history, { at, telemetry: { ...telemetry } }].slice(-90));
  }, []);

  const activeModel = target?.model;

  const compatibleReleases = useMemo(
    () => compatibleFirmwareReleases(releases, activeModel),
    [activeModel, releases]
  );

  const channelReleases = useMemo(
    () => compatibleReleases.filter((r) => r.channel === releaseChannel),
    [compatibleReleases, releaseChannel]
  );

  const selectedRelease = useMemo(
    () => compatibleReleases.find((r) => r.tag === selectedReleaseTag) ?? channelReleases[0] ?? compatibleReleases[0],
    [channelReleases, compatibleReleases, selectedReleaseTag]
  );

  const firmwareAsset = useMemo(
    () => (activeModel ? findFirmwareAsset(selectedRelease, activeModel) : undefined),
    [activeModel, selectedRelease]
  );

  const metadataAsset = useMemo(() => findMetadataAsset(selectedRelease), [selectedRelease]);
  const selectedLanguage = languages.find((item) => item.code === language);
  const safetyReady = confirmations.every(Boolean);
  // A release is "bundled" when its firmware asset is served from the same
  // origin as the app (i.e. picked up from public/firmware/ via the bundler).
  // Releases that only have remote https:// URLs cannot be flashed in the
  // browser because release-assets.githubusercontent.com strips CORS, so we
  // gate the Flash button on this and surface a warning callout.
  const firmwareAssetIsBundled = Boolean(
    firmwareAsset?.downloadUrl && !/^https?:\/\//i.test(firmwareAsset.downloadUrl)
  );
  const flashReady = Boolean(
    target &&
      safetyReady &&
      firmwareAssetIsBundled &&
      (!selectedRelease || selectedRelease.channel === "stable" || prereleaseConfirmed)
  );
  // Theme
  useEffect(() => {
    const stored = window.localStorage.getItem("pinecil-theme");
    if (stored === "system" || stored === "light" || stored === "dark") setTheme(stored);
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const resolved = theme === "system" ? (media.matches ? "dark" : "light") : theme;
      document.documentElement.dataset.theme = resolved;
      document.documentElement.style.colorScheme = resolved;
      window.localStorage.setItem("pinecil-theme", theme);
    };
    applyTheme();
    if (theme !== "system") return;
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [theme]);

  // Browser support
  useEffect(() => {
    const webUsb = Boolean(navigator.usb);
    const webSerial = Boolean(navigator.serial);
    const webBluetooth = Boolean(navigator.bluetooth);
    setBrowserSupport({ webUsb, webSerial, webBluetooth });
    setBrowserCapable(webUsb && webSerial && webBluetooth);
    addLog("INFO", "Browser capability check completed.");
  }, [addLog]);

  useEffect(() => {
    motionReadyRef.current = true;
  }, []);

  // Load releases. The static deploy bundles a same-origin releases.json (see
  // scripts/bundle-releases.mjs) because release-assets.githubusercontent.com
  // does not send CORS headers, so the browser cannot fetch GitHub release
  // downloads directly. We try the bundled catalog first; if it is missing
  // (e.g. dev build without the bundler) we fall back to the GitHub API for
  // listing only — asset downloads will still error cleanly without bricking
  // the iron because validation happens before any flash write.
  useEffect(() => {
    let alive = true;
    const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
    const prefix = (path: string) => (path.startsWith("http") ? path : `${basePath}/${path}`);

    const applyReleases = (data: Parameters<typeof normalizeReleases>[0], source: string) => {
      if (!alive) return;
      const releases = normalizeReleases(data).map((release) => ({
        ...release,
        assets: release.assets.map((asset) => ({
          ...asset,
          downloadUrl: asset.downloadUrl ? prefix(asset.downloadUrl) : asset.downloadUrl
        }))
      }));
      if (!releases.length) return;
      setReleases(releases);
      const stable = releases.find((r) => r.channel === "stable") ?? releases[0];
      setSelectedReleaseTag(stable.tag);
      addLog("OK", `Loaded ${releases.length} IronOS releases (${source}).`);
    };

    (async () => {
      try {
        const res = await fetch(`${basePath}/releases.json`, { cache: "no-cache" });
        if (res.ok) {
          const payload = (await res.json()) as { releases: Parameters<typeof normalizeReleases>[0] };
          applyReleases(payload.releases, "bundled");
          return;
        }
      } catch {
        // fall through to remote fetch
      }
      try {
        const res = await fetch("https://api.github.com/repos/Ralim/IronOS/releases?per_page=30", {
          headers: { Accept: "application/vnd.github+json" }
        });
        if (!res.ok) throw new Error(`GitHub releases returned ${res.status}`);
        const data = (await res.json()) as Parameters<typeof normalizeReleases>[0];
        applyReleases(data, "github.com");
        addLog("WARN", "Using live GitHub catalog; asset downloads will fail in the browser due to CORS. Run scripts/bundle-releases.mjs before building.");
      } catch (err) {
        addLog("WARN", `${err instanceof Error ? err.message : "Release fetch failed"}; using local sample catalog.`);
      }
    })();
    return () => { alive = false; };
  }, [addLog]);

  // Keep selected release in sync when channel changes
  useEffect(() => {
    const currentRelease = compatibleReleases.find((r) => r.tag === selectedReleaseTag);
    const next = channelReleases[0] ?? compatibleReleases[0];
    if (next && (!currentRelease || currentRelease.channel !== releaseChannel)) {
      setSelectedReleaseTag(next.tag);
    }
  }, [channelReleases, compatibleReleases, releaseChannel, selectedReleaseTag]);

  const downloadAssetBytes = useCallback(async (downloadUrl: string | undefined): Promise<Uint8Array> => {
    if (!downloadUrl) throw new Error("No download URL available for this asset.");
    const res = await fetch(downloadUrl);
    if (!res.ok) throw new Error(`Asset download failed with ${res.status}.`);
    return new Uint8Array(await res.arrayBuffer());
  }, []);

  // Load languages for detected model
  useEffect(() => {
    let alive = true;
    if (!activeModel || !metadataAsset) {
      setLanguages(DEFAULT_LANGUAGES);
      return;
    }
    if (!metadataAsset.downloadUrl) {
      setLanguages(DEFAULT_LANGUAGES);
      return;
    }
    downloadAssetBytes(metadataAsset.downloadUrl)
      .then((bytes) => {
        if (!alive || !bytes.length) return;
        const parsed = parseLanguagesFromMetadata(bytes, activeModel);
        setLanguages(parsed);
        if (!parsed.some((item) => item.code === language)) setLanguage(parsed[0]?.code ?? "EN");
        addLog("OK", `Loaded ${parsed.length} language entries for ${activeModel.toUpperCase()}.`);
      })
      .catch((err) => {
        if (!alive) return;
        addLog("WARN", err instanceof Error ? err.message : "Unable to load release languages.");
        setLanguages(DEFAULT_LANGUAGES);
      });
    return () => { alive = false; };
  }, [activeModel, addLog, downloadAssetBytes, language, metadataAsset]);

  // Reset prepared state when selection changes
  useEffect(() => {
    if (skipNextSelectionResetRef.current) {
      skipNextSelectionResetRef.current = false;
      return;
    }
    const bluetoothActive = Boolean(bleRef.current) || bleDemo;
    setProgress(0);
    setPhase(target ? "select" : bluetoothActive ? "detect" : "connect");
    setProgressMessage(
      target
        ? "Ready to flash. Validation will run automatically."
        : bluetoothActive ? "Bluetooth telemetry and settings are ready." : "Waiting for device access."
    );
  }, [bleDemo, language, mode, selectedReleaseTag, target?.connectedAt]);

  const clearBluetoothState = useCallback(() => {
    try { bleRef.current?.disconnect(); } catch (err) {
      addLog("WARN", err instanceof Error ? err.message : "Unable to close Bluetooth cleanly.");
    }
    bleRef.current = undefined;
    setBleSnapshot(undefined);
    setBleDemo(false);
    setBleTelemetryPolling(false);
    setBleTelemetryHistory([]);
    setBleDrafts(makeBleDrafts({ deviceName: "Pinecil V2", readOnly: false, telemetry: {}, settings: KNOWN_BLE_SETTINGS }));
  }, [addLog]);

  useEffect(() => {
    PinecilBleClient.onDisconnect = (source) => {
      if (bleRef.current !== source) return;
      addLog("WARN", "Bluetooth device disconnected.");
      clearBluetoothState();
      setMode(undefined);
      setPhase("connect");
      setProgress(0);
      setProgressMessage("Waiting for device access.");
    };
    return () => {
      PinecilBleClient.onDisconnect = () => undefined;
    };
  }, [addLog, clearBluetoothState]);

  const clearUsbState = useCallback(() => {
    const backend = backendRef.current;
    backendRef.current = undefined;
    if (backend) {
      void backend.close().catch((err) => {
        addLog("WARN", err instanceof Error ? err.message : "Unable to close hardware backend cleanly.");
      });
    }
    logoBuildIdRef.current += 1;
    setTarget(undefined);
    setGeneratedLogo(undefined);
    setLogoDfuFile(undefined);
    setLogoImageFile(undefined);
    setLogoPan({ x: 0, y: 0, zoom: 1 });
  }, [addLog]);

  const setProgressFromEvent = useCallback(
    (event: FlashProgress) => {
      const next = event.total ? Math.round((event.current / event.total) * 100) : 0;
      const showTraceLog = process.env.NODE_ENV !== "production";
      setPhase(event.phase);
      setProgress(next);
      setProgressMessage(event.message);
      if (event.log !== false && (!event.trace || showTraceLog)) {
        addLog(
          event.level === "error" ? "ERROR"
            : event.level === "warn" ? "WARN"
            : event.level === "success" ? "OK"
            : "INFO",
          event.message
        );
      }
    },
    [addLog]
  );

  const connectDemo = useCallback(() => {
    clearUsbState();
    clearBluetoothState();
    const demoTarget: FlashTarget = {
      model: "v2",
      transport: "demo",
      label: "Pinecil V2 demo target",
      portName: "Web Serial demo",
      bootloader: "BL70x",
      serial: "PC2V2-DEMO",
      connectedAt: new Date().toISOString()
    };
    setTarget(demoTarget);
    setMode("firmware");
    setPhase("detect");
    setProgressMessage(`${demoTarget.label} connected.`);
    addLog("OK", `${demoTarget.label} connected via USB.`);
  }, [addLog, clearBluetoothState, clearUsbState]);

  const connectUsb = useCallback(async () => {
    if (!navigator.serial && !navigator.usb) throw new Error("This browser does not expose WebUSB or Web Serial.");

    // Prompt order matters. Pinecil V2 (BL70x bootloader) shows up as a USB CDC
    // serial port and only Web Serial BLISP can talk to it. Pinecil V1 in DFU
    // mode shows up as a raw USB DFU device. Most Pinecils sold today are V2,
    // so we try Web Serial first to avoid an empty WebUSB DFU picker that the
    // user has to dismiss before getting to the right one. If they cancel the
    // Web Serial picker we fall back to WebUSB DFU for V1 owners.
    const finishConnect = (detected: FlashTarget) => {
      clearBluetoothState();
      setTarget(detected);
      setMode("firmware");
      setPhase("detect");
      setProgressMessage(`${detected.label} connected.`);
      addLog("OK", `${detected.label} connected via USB.`);
      return detected;
    };

    if (navigator.serial) {
      const blisp = new WebSerialBlispFlasher();
      backendRef.current = blisp;
      try {
        return finishConnect(await blisp.connect());
      } catch (err) {
        await blisp.close().catch(() => undefined);
        backendRef.current = undefined;
        if (!isUserCancellation(err)) throw err;
      }
    }

    if (navigator.usb) {
      const dfu = new WebUsbDfuFlasher();
      backendRef.current = dfu;
      try {
        return finishConnect(await dfu.connect());
      } catch (err) {
        await dfu.close().catch(() => undefined);
        backendRef.current = undefined;
        if (!isUserCancellation(err)) throw err;
      }
    }

    return undefined;
  }, [addLog, clearBluetoothState]);

  const disconnectTarget = useCallback(async () => {
    clearUsbState();
    clearBluetoothState();
    setMode(undefined);
    setPhase("connect");
    setProgress(0);
    setProgressMessage("Waiting for device access.");
    addLog("INFO", "Device disconnected from the app.");
  }, [addLog, clearBluetoothState, clearUsbState]);

  // Keep the ref pointed at the current disconnectTarget for the static
  // SerialPort 'disconnect' event handler to invoke on physical unplug.
  disconnectListenerRef.current = () => {
    if (preserveDoneOnDisconnectRef.current) {
      preserveDoneOnDisconnectRef.current = false;
      skipNextSelectionResetRef.current = true;
      clearUsbState();
      addLog("INFO", "Device reset after flashing.");
      return;
    }
    void disconnectTarget();
  };

  const prepareFirmwareForTarget = useCallback(async () => {
    if (!target || !activeModel) throw new Error("Connect a Pinecil before flashing firmware.");
    if (!firmwareAsset || !selectedRelease) throw new Error("No firmware asset is available for the detected model.");
    if (target.transport === "demo") {
      const bytes = makeMockFirmware(activeModel, language);
      return prepareInstall(target, { kind: "firmware", fileName: firmwareFileName(activeModel, language), bytes, releaseTag: selectedRelease.tag, language });
    }
    if (!firmwareAsset.downloadUrl) {
      throw new Error("This firmware release has no downloadable asset. Rebuild with the release bundler enabled.");
    }
    const archive = await downloadAssetBytes(firmwareAsset.downloadUrl);
    const bytes = firmwareAsset.fileName.toLowerCase().endsWith(".zip")
      ? extractFirmwareFromZip(archive, activeModel, language)
      : archive;
    return prepareInstall(target, { kind: "firmware", fileName: firmwareFileName(activeModel, language), bytes, releaseTag: selectedRelease.tag, language });
  }, [activeModel, downloadAssetBytes, firmwareAsset, language, selectedRelease, target]);

  const prepareLogoForTarget = useCallback(async () => {
    if (!target) throw new Error("Connect a Pinecil before flashing a logo.");
    if (generatedLogo) {
      return prepareInstall(target, { kind: "bootLogo", fileName: generatedLogo.fileName, bytes: generatedLogo.bytes });
    }
    if (!logoDfuFile) throw new Error("Choose or generate a boot-logo .dfu file before flashing.");
    const bytes = new Uint8Array(await logoDfuFile.arrayBuffer());
    const suffix = parseDfuSuffix(bytes);
    if (!suffix.crcValid) throw new Error("DFU suffix CRC does not match.");
    return prepareInstall(target, { kind: "bootLogo", fileName: logoDfuFile.name, bytes });
  }, [generatedLogo, logoDfuFile, target]);

  const runFlash = useCallback(async (kind: "firmware" | "bootLogo") => {
    if (!target) { addLog("WARN", "Connect a Pinecil before flashing."); return; }
    if (!safetyReady) { addLog("WARN", "Complete the safety confirmations before flashing."); return; }
    if (kind === "firmware" && selectedRelease?.channel === "prerelease" && !prereleaseConfirmed) {
      addLog("WARN", "Confirm prerelease firmware before flashing."); return;
    }
    setBusy(true);
    try {
      setPhase("validate");
      setProgress(0);
      setProgressMessage("Preparing, validating, and hashing file.");
      const prepared = kind === "firmware" ? await prepareFirmwareForTarget() : await prepareLogoForTarget();
      addLog("OK", `${prepared.fileName} validated (${formatBytes(prepared.bytes.length)}, SHA-256 ${prepared.sha256?.slice(0, 16)}...).`);
      preserveDoneOnDisconnectRef.current = true;
      const result = await flashPrepared(target, backendRef.current, prepared, setProgressFromEvent);
      if (!result.ok) throw new Error(result.message);
      if (result.installedFirmwareVersion) {
        setTarget((current) => (
          current
            ? { ...current, installedFirmwareVersion: result.installedFirmwareVersion }
            : current
        ));
      }
      setPhase("done");
      setProgress(100);
      setProgressMessage(result.verifySummary ?? result.message);
      addLog("OK", result.message);
      window.setTimeout(() => {
        preserveDoneOnDisconnectRef.current = false;
      }, 5000);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Flash failed.";
      preserveDoneOnDisconnectRef.current = false;
      setPhase("fail");
      setProgress(100);
      setProgressMessage(message);
      addLog("ERROR", message);
    } finally {
      setBusy(false);
    }
  }, [addLog, prepareFirmwareForTarget, prepareLogoForTarget, prereleaseConfirmed, safetyReady, selectedRelease?.channel, setProgressFromEvent, target]);

  const buildGeneratedLogo = useCallback(async (file: File, silent = false, imagePan: LogoPanOffset = logoPan) => {
    if (!target) { addLog("WARN", "Connect a Pinecil before generating a flashable logo."); return; }
    const buildId = logoBuildIdRef.current + 1;
    logoBuildIdRef.current = buildId;
    setLogoBusy(true);
    try {
      const generated = await generateLogoFromImage({
        model: target.model, image: file, imagePan, threshold: logoThreshold, invert: logoInvert,
        animationMode: isAnimatedImage(file) ? "animated" : "static"
      });
      if (buildId !== logoBuildIdRef.current) return;
      setGeneratedLogo(generated);
      setLogoDfuFile(undefined);
      const prepared = await prepareInstall(target, { kind: "bootLogo", fileName: generated.fileName, bytes: generated.bytes });
      if (buildId !== logoBuildIdRef.current) return;
      if (!silent) addLog("OK", `Generated ${generated.fileName} from ${file.name}.`);
    } catch (err) {
      if (buildId === logoBuildIdRef.current) {
        addLog("ERROR", err instanceof Error ? err.message : "Logo generation failed.");
      }
    } finally {
      if (buildId === logoBuildIdRef.current) setLogoBusy(false);
    }
  }, [addLog, logoInvert, logoPan, logoThreshold, target]);

  useEffect(() => {
    if (!logoImageFile || mode !== "logo" || !target) return;
    void buildGeneratedLogo(logoImageFile, true);
  }, [buildGeneratedLogo, logoImageFile, mode, target]);

  const onLogoImageFile = useCallback((file: File) => {
    const centeredPan = { x: 0, y: 0, zoom: 1 };
    setMode("logo");
    setLogoPan(centeredPan);
    setLogoImageFile(file);
    void buildGeneratedLogo(file, false, centeredPan);
  }, [buildGeneratedLogo]);

  const onLogoDfuFile = useCallback(async (file: File) => {
    if (!target) { addLog("WARN", "Connect a Pinecil before choosing a logo .dfu file."); return; }
    logoBuildIdRef.current += 1;
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const suffix = parseDfuSuffix(bytes);
      if (!suffix.crcValid) throw new Error("DFU suffix CRC does not match.");
      const prepared = await prepareInstall(target, { kind: "bootLogo", fileName: file.name, bytes });
      setLogoDfuFile(file);
      setLogoImageFile(undefined);
      setLogoPan({ x: 0, y: 0, zoom: 1 });
      setGeneratedLogo(undefined);
      setMode("logo");
      addLog("OK", `Selected existing boot-logo .dfu file ${file.name}.`);
    } catch (err) {
      addLog("ERROR", err instanceof Error ? err.message : "Logo file validation failed.");
    } finally {
      setBusy(false);
    }
  }, [addLog, target]);

  const restoreDefaultLogo = useCallback(async () => {
    if (!target) { addLog("WARN", "Connect a Pinecil before creating a default-logo restore .dfu file."); return; }
    logoBuildIdRef.current += 1;
    setLogoBusy(true);
    try {
      const generated = await generateLogoFromImage({
        model: target.model, threshold: logoThreshold, invert: logoInvert, erase: true, animationMode: "static"
      });
      const prepared = await prepareInstall(target, { kind: "bootLogo", fileName: generated.fileName, bytes: generated.bytes });
      setGeneratedLogo(generated);
      setLogoDfuFile(undefined);
      setLogoImageFile(undefined);
      setLogoPan({ x: 0, y: 0, zoom: 1 });
      setMode("logo");
      addLog("OK", `Created default-logo restore .dfu file ${generated.fileName}. Flash it to return the boot logo to default.`);
    } catch (err) {
      addLog("ERROR", err instanceof Error ? err.message : "Unable to create default-logo restore .dfu file.");
    } finally {
      setLogoBusy(false);
    }
  }, [addLog, logoInvert, logoThreshold, target]);

  const downloadLogo = useCallback(() => {
    if (!generatedLogo) return;
    const url = URL.createObjectURL(new Blob([generatedLogo.bytes.buffer as ArrayBuffer], { type: "application/octet-stream" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = generatedLogo.fileName;
    a.click();
    URL.revokeObjectURL(url);
    addLog("INFO", `Prepared download for ${generatedLogo.fileName}.`);
  }, [addLog, generatedLogo]);

  const connectBluetooth = useCallback(async () => {
    const client = new PinecilBleClient();
    let name: string | undefined;
    try {
      name = await client.connect();
      const snapshot = await client.snapshot(name);
      clearUsbState();
      bleRef.current = client;
      setBleSnapshot(snapshot);
      setBleDrafts(makeBleDrafts(snapshot));
      setBleTelemetryHistory([]);
      appendBleTelemetry(snapshot.telemetry);
      setBleDemo(false);
      setMode("ble");
      setPhase("detect");
      setProgress(0);
      setProgressMessage(`${name} connected via Bluetooth.`);
      addLog("OK", `Connected to ${name} via Bluetooth.`);
      if (snapshot.readOnly) addLog("WARN", "Bluetooth reports read-only mode; settings writes are disabled.");
      return snapshot;
    } catch (err) {
      client.disconnect();
      throw err;
    }
  }, [addLog, appendBleTelemetry, clearUsbState]);

  const connectUsbOnly = useCallback(async () => {
    setBusy(true);
    setPhase("connect");
    setProgress(0);
    setProgressMessage("Waiting for USB device selection.");
    try {
      await connectUsb();
    } catch (err) {
      if (isUserCancellation(err)) {
        setProgressMessage("Waiting for device access.");
      } else {
        addLog("ERROR", err instanceof Error ? err.message : "USB connection failed.");
      }
    } finally {
      setBusy(false);
    }
  }, [addLog, connectUsb]);

  const connectBluetoothOnly = useCallback(async () => {
    setBusy(true);
    setPhase("detect");
    setProgress(0);
    setProgressMessage("Connecting over Bluetooth.");
    try {
      await connectBluetooth();
    } catch (err) {
      bleRef.current = undefined;
      setBleSnapshot(undefined);
      if (isUserCancellation(err)) {
        setPhase(target ? "select" : "connect");
        setProgressMessage(target ? "Ready to flash. Validation will run automatically." : "Waiting for device access.");
      } else {
        addLog("ERROR", err instanceof Error ? err.message : "Bluetooth connection failed.");
      }
    } finally {
      setBusy(false);
    }
  }, [addLog, connectBluetooth, target]);

  const connectPinecil = useCallback(async () => {
    await connectUsbOnly();
  }, [connectUsbOnly]);

  const connectBluetoothDemo = useCallback(() => {
    clearUsbState();
    bleRef.current = undefined;
    const snapshot = makeMockBleSnapshot();
    setBleSnapshot(snapshot);
    setBleDrafts(makeBleDrafts(snapshot));
    setBleTelemetryHistory([]);
    appendBleTelemetry(snapshot.telemetry);
    setBleDemo(true);
    setMode("ble");
    setPhase("detect");
    setProgress(0);
    setProgressMessage(`${snapshot.deviceName} connected via Bluetooth.`);
    addLog("OK", `${snapshot.deviceName} connected via Bluetooth.`);
  }, [addLog, appendBleTelemetry, clearUsbState]);

  const blePollingActive = Boolean(bleSnapshot);

  useEffect(() => {
    if (!blePollingActive) return;

    if (bleDemo) {
      const connectedAt = Date.now();
      const timer = window.setInterval(() => {
        const seconds = (Date.now() - connectedAt) / 1000;
        const telemetry = {
          tipTempC: Math.round(190 + Math.sin(seconds / 2.7) * 46 + Math.sin(seconds / 0.9) * 7),
          setPointC: 320,
          handleTempC: Math.round(300 + Math.sin(seconds / 5.5) * 30),
          dcInputMv: Math.round(199 + Math.sin(seconds / 3.1) * 3),
          powerLevel: Math.max(0, Math.round(54 + Math.sin(seconds / 1.6) * 30)),
          powerSource: 1,
          tipResistance: 62,
          uptimeSeconds: Math.round(1280 + seconds * 10),
          lastMovementSeconds: Math.round((seconds % 18) * 10 + 10),
          maxTempC: 450,
          rawTip: Math.round(1840 + Math.sin(seconds / 1.9) * 180),
          hallSensor: Math.max(0, Math.round(6 + Math.sin(seconds / 2.2) * 6)),
          operatingMode: seconds % 24 > 18 ? 1 : 0,
          estimatedWatts: Math.max(0, Math.round(340 + Math.sin(seconds / 1.6) * 190))
        };
        setBleSnapshot((snapshot) => (snapshot ? { ...snapshot, telemetry: { ...snapshot.telemetry, ...telemetry } } : snapshot));
        appendBleTelemetry(telemetry);
      }, 1000);
      return () => window.clearInterval(timer);
    }

    let polling = false;
    const timer = window.setInterval(() => {
      if (polling || !bleRef.current) return;
      polling = true;
      setBleTelemetryPolling(true);
      bleRef.current
        .readLiveTelemetry()
        .then((telemetry) => {
          setBleSnapshot((snapshot) => (snapshot ? { ...snapshot, telemetry } : snapshot));
          appendBleTelemetry(telemetry);
        })
        .catch((err) => {
          window.clearInterval(timer);
          addLog("WARN", err instanceof Error ? `Bluetooth telemetry polling stopped: ${err.message}` : "Bluetooth telemetry polling stopped.");
        })
        .finally(() => {
          polling = false;
          setBleTelemetryPolling(false);
        });
    }, 1000);

    return () => {
      window.clearInterval(timer);
      setBleTelemetryPolling(false);
    };
  }, [addLog, appendBleTelemetry, bleDemo, blePollingActive]);

  const updateBleDraft = useCallback((setting: BleSettingDraft, value: number) => {
    setBleDrafts((drafts) =>
      drafts.map((d) =>
        d.id === setting.id ? { ...d, draftValue: value, value, dirty: value !== d.originalValue } : d
      )
    );
  }, []);

  const applyBleDrafts = useCallback(async () => {
    const dirtyDrafts = bleDrafts.filter((draft) => draft.dirty);
    const startMessage = dirtyDrafts.length
      ? `Applying ${dirtyDrafts.length} Bluetooth setting change${dirtyDrafts.length === 1 ? "" : "s"} to runtime settings.`
      : "Checking Bluetooth settings for staged changes.";
    setPhase("flash");
    setProgress(dirtyDrafts.length ? 20 : 80);
    setProgressMessage(startMessage);

    if (bleDemo) {
      setBleDrafts((drafts) => drafts.map((d) => ({ ...d, value: d.draftValue, originalValue: d.draftValue, dirty: false })));
      setBleSnapshot((snapshot) =>
        snapshot
          ? {
              ...snapshot,
              settings: snapshot.settings.map((s) => {
                const d = bleDrafts.find((x) => x.id === s.id);
                return d ? { ...s, value: d.draftValue } : s;
              })
            }
          : snapshot
      );
      const message = dirtyDrafts.length
        ? `Applied ${dirtyDrafts.length} demo Bluetooth setting change${dirtyDrafts.length === 1 ? "" : "s"}.`
        : "No Bluetooth setting changes to apply.";
      setPhase("done");
      setProgress(100);
      setProgressMessage(message);
      addLog("OK", message);
      return;
    }
    if (!bleRef.current) {
      const message = "Connect over Bluetooth before applying settings.";
      setPhase("fail");
      setProgress(100);
      setProgressMessage(message);
      addLog("WARN", message);
      return;
    }
    setBusy(true);
    try {
      const count = await bleRef.current.writeSettingDrafts(bleDrafts);
      setBleDrafts((drafts) => drafts.map((d) => ({ ...d, value: d.draftValue, originalValue: d.draftValue, dirty: false })));
      setBleSnapshot((snapshot) =>
        snapshot
          ? { ...snapshot, settings: snapshot.settings.map((s) => { const d = bleDrafts.find((x) => x.id === s.id); return d ? { ...s, value: d.draftValue } : s; }) }
          : snapshot
      );
      const message = count
        ? `Applied ${count} Bluetooth setting change${count === 1 ? "" : "s"} to runtime settings.`
        : "No Bluetooth setting changes to apply.";
      setPhase("done");
      setProgress(100);
      setProgressMessage(message);
      addLog("OK", message);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Bluetooth setting write failed.";
      setPhase("fail");
      setProgress(100);
      setProgressMessage(message);
      addLog("ERROR", message);
    } finally {
      setBusy(false);
    }
  }, [addLog, bleDemo, bleDrafts]);

  const saveBle = useCallback(async () => {
    setPhase("flash");
    setProgress(35);
    setProgressMessage("Saving Bluetooth settings to device flash.");

    if (bleDemo) {
      const message = "Demo Bluetooth settings saved to flash.";
      setPhase("done");
      setProgress(100);
      setProgressMessage(message);
      addLog("OK", message);
      return;
    }
    if (!bleRef.current) {
      const message = "Connect over Bluetooth before saving settings to flash.";
      setPhase("fail");
      setProgress(100);
      setProgressMessage(message);
      addLog("WARN", message);
      return;
    }
    setBusy(true);
    try {
      await bleRef.current.saveSettings();
      const message = "Bluetooth settings saved to device flash.";
      setPhase("done");
      setProgress(100);
      setProgressMessage(message);
      addLog("OK", message);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to save Bluetooth settings.";
      setPhase("fail");
      setProgress(100);
      setProgressMessage(message);
      addLog("ERROR", message);
    } finally {
      setBusy(false);
    }
  }, [addLog, bleDemo]);

  const usbConnected = Boolean(target);
  const bluetoothConnected = Boolean(bleSnapshot);
  const usbConnectBusy = busy && phase === "connect";
  const bluetoothBusy = busy && (mode === "ble" || mode === "ble-settings");
  const activityPulse = usbConnectBusy || bluetoothBusy || bleTelemetryPolling;
  const connected = usbConnected || bluetoothConnected;
  const connectionKind = usbConnected ? "usb" : bluetoothConnected ? "bluetooth" : undefined;
  const v1Connected = connectionKind === "usb" && target?.model === "v1";
  const bluetoothLabel = bluetoothConnected ? "Connected" : "Disconnected";
  const modeAvailability: ModeAvailability = {
    firmware: connectionKind === "usb"
      ? undefined
      : connectionKind === "bluetooth" ? "Disconnect Bluetooth before using USB firmware flashing." : "Connect over USB to flash firmware.",
    logo: connectionKind === "usb"
      ? undefined
      : connectionKind === "bluetooth" ? "Disconnect Bluetooth before using USB boot-logo flashing." : "Connect over USB to flash a boot logo.",
    ble: v1Connected
      ? "Telemetry requires a Pinecil V2 Bluetooth connection."
      : connectionKind === "bluetooth" ? undefined : connectionKind === "usb" ? "Disconnect USB before using Bluetooth telemetry." : "Connect over Bluetooth to view telemetry.",
    "ble-settings": v1Connected
      ? "Settings over Bluetooth require Pinecil V2."
      : connectionKind === "bluetooth" ? undefined : connectionKind === "usb" ? "Disconnect USB before using Bluetooth settings." : "Connect over Bluetooth to edit settings."
  };
  const unavailableReason = mode ? modeAvailability[mode] : undefined;
  const needsUsbForMode = mode === "firmware" || mode === "logo";
  const needsBluetoothForMode = mode === "ble" || mode === "ble-settings";
  const showSplash = !connected || Boolean(unavailableReason);
  const splashTitle = !connected ? "Connect a Pinecil" : "Page unavailable";
  const splashMessage = !connected
    ? "Choose USB for flashing or Bluetooth for telemetry and settings."
    : `${unavailableReason ?? "This page is unavailable for the current connection."} Disconnect before switching connection modes.`;
  const changeMode = useCallback((nextMode: Mode) => {
    const disabledReason = modeAvailability[nextMode];
    if (disabledReason) {
      addLog("WARN", disabledReason);
      return;
    }
    setMode(nextMode);
  }, [addLog, modeAvailability]);
  const modeHelp = target?.bootloader
    ? bluetoothConnected
      ? "USB flash mode is ready for flashing. Bluetooth may still be connected, but settings are changed in normal powered mode."
      : ""
    : bluetoothConnected
      ? usbConnected
        ? "Normal powered mode is ready for Bluetooth settings while USB can remain connected for power."
        : ""
      : "Use USB flash mode for flashing. Use normal powered mode for Bluetooth settings.";
  // What we show under the device name. Bluetooth talks to running IronOS so
  // we get a build id. USB BLISP loads the eflash_loader and reads flash to
  // recover the installed IronOS version, plus reports the BL70x boot ROM
  // version separately. Both lines render in the sidebar so the user can
  // compare "currently installed" vs the version they're about to flash.
  const sidebarFirmwareVersion =
    bleSnapshot?.buildId
      ?? (target?.transport === "demo" ? "v2.23-demo" : undefined)
      ?? target?.installedFirmwareVersion;
  const sidebarBootRomVersion = target?.bootRomVersion;
  const mobileModel = target?.model ?? (bluetoothConnected ? "v2" : undefined);
  const mobileTransport = usbConnected ? "USB" : bluetoothConnected ? "Bluetooth" : undefined;
  const mobileDisplayName = mobileModel && mobileTransport
    ? `Pinecil ${mobileModel.toUpperCase()} connected via ${mobileTransport}`
    : "No device connected";
  const mobileModeLine = connected
    ? [
        sidebarFirmwareVersion ? `Firmware ${sidebarFirmwareVersion}` : undefined,
        sidebarBootRomVersion ? `Boot ROM ${sidebarBootRomVersion}` : undefined,
        target?.bootloader ? "Flash mode" : "Normal mode"
      ]
        .filter(Boolean)
        .join(" / ")
    : undefined;

  const usbConnectDisabled = busy || (browserCapable !== null && !browserSupport.webUsb && !browserSupport.webSerial);
  const bluetoothConnectDisabled = busy || (browserCapable !== null && !browserSupport.webBluetooth);

  const workspaceStateKey = showSplash
    ? `splash-${connected ? "unavailable" : "disconnected"}-${needsUsbForMode ? "usb" : needsBluetoothForMode ? "ble" : "any"}`
    : `workspace-${connectionKind ?? "none"}-${mode ?? "none"}`;
  const fadeStateClass = motionReadyRef.current ? " fade-in" : "";

  return (
    <div className="app-layout">
      <Sidebar
        bluetoothLabel={bluetoothLabel}
        bluetoothDeviceName={bleSnapshot?.deviceName}
        busy={busy}
        firmwareVersion={sidebarFirmwareVersion}
        bootRomVersion={sidebarBootRomVersion}
        fadeContent={motionReadyRef.current}
        modeAvailability={modeAvailability}
        modeHelp={modeHelp}
        mode={mode}
        onDisconnect={disconnectTarget}
        onMode={changeMode}
        onTheme={setTheme}
        target={target}
        theme={theme}
      />

      <div className="main">
        <header className="mobile-connection-header">
          <div className="mobile-connection-copy">
            <div className="mobile-device-name" data-connected={connected ? "true" : "false"}>
              <span className="sidebar-connection-indicator" aria-hidden="true">
                <span className="sidebar-connection-dot" />
              </span>
              <span className={motionReadyRef.current ? "fade-in" : undefined} key={mobileDisplayName}>{mobileDisplayName}</span>
            </div>
            {mobileModeLine ? <div className={`mobile-device-meta${fadeStateClass}`} key={mobileModeLine}>{mobileModeLine}</div> : null}
          </div>
          <div className="mobile-connection-actions">
            {connected ? (
              <button
                className="btn btn-compact"
                disabled={busy}
                onClick={disconnectTarget}
                type="button"
              >
                <Unplug size={13} />
                Disconnect device
              </button>
            ) : null}
          </div>
        </header>

        <div className="main-content">
          {browserCapable === false ? (
            <section className="browser-notice splash-card" role="alert">
              <span className="browser-notice-icon"><AlertTriangle size={18} /></span>
              <div className="browser-notice-body splash-card-body">
                <h3>Chromium-based browser required</h3>
                <p>
                  WebUSB, Web Serial, and Web Bluetooth are only available in desktop Chrome or Edge.
                  Safari, Firefox, and mobile browsers are not supported.{" "}
                  <a href="https://www.google.com/chrome/" target="_blank" rel="noreferrer">Download Chrome →</a>
                </p>
              </div>
            </section>
          ) : null}

          <div className={`workspace-state${fadeStateClass}`} data-state={showSplash ? "splash" : "workspace"} key={workspaceStateKey}>
            {showSplash ? (
              <WorkspaceSplash
                busy={busy}
                bluetoothConnectDisabled={bluetoothConnectDisabled}
                usbConnectDisabled={usbConnectDisabled}
                message={splashMessage}
                onConnectBluetoothDemo={connectBluetoothDemo}
                onConnectBluetooth={connectBluetoothOnly}
                onConnectDemo={connectDemo}
                onConnectPinecil={connectPinecil}
                showBluetoothActions={!connected && !v1Connected && (!connected || needsBluetoothForMode)}
                showConnectAction={!connected}
                showUsbActions={!connected && (!connected || needsUsbForMode)}
                title={splashTitle}
              />
            ) : (
              <>
                {mode === "firmware" ? (
                  <FirmwarePanel
                    busy={busy}
                    channelReleases={channelReleases}
                    flashReady={flashReady && Boolean(firmwareAsset)}
                    language={language}
                    languages={languages}
                    onChannel={setReleaseChannel}
                    onFlash={() => runFlash("firmware")}
                    onLanguage={setLanguage}
                    onPrereleaseConfirmed={setPrereleaseConfirmed}
                    onRelease={setSelectedReleaseTag}
                    onSafetyChange={setConfirmations}
                    prereleaseConfirmed={prereleaseConfirmed}
                    releaseChannel={releaseChannel}
                    selectedRelease={selectedRelease}
                    selectedReleaseTag={selectedReleaseTag}
                    safety={confirmations}
                    target={target}
                  />
                ) : null}

                {mode === "logo" ? (
                  <LogoStudio
                    busy={busy}
                    converting={logoBusy}
                    generatedLogo={generatedLogo}
                    imagePan={logoPan}
                    invert={logoInvert}
                    logoDfuFile={logoDfuFile}
                    onDownload={downloadLogo}
                    onErase={restoreDefaultLogo}
                    onFlash={() => runFlash("bootLogo")}
                    onImageFile={onLogoImageFile}
                    onImagePan={setLogoPan}
                    onInvert={setLogoInvert}
                    onLogoDfuFile={onLogoDfuFile}
                    onSafetyChange={setConfirmations}
                    onThreshold={setLogoThreshold}
                    safety={confirmations}
                    safetyReady={safetyReady}
                    target={target}
                    threshold={logoThreshold}
                  />
                ) : null}

                {mode === "ble" ? (
                  <BlePanel
                    snapshot={bleSnapshot}
                    telemetryHistory={bleTelemetryHistory}
                  />
                ) : null}

                {mode === "ble-settings" ? (
                  <BleSettingsPanel
                    busy={busy}
                    drafts={bleDrafts}
                    onApply={applyBleDrafts}
                    onDraftChange={updateBleDraft}
                    onSave={saveBle}
                    snapshot={bleSnapshot}
                  />
                ) : null}
              </>
            )}
          </div>

        </div>

        <div className="activity-panel-outer">
          <ActivityLog
            logs={logs}
            onClear={() => setLogs([])}
            onOpenChange={setActivityOpen}
            open={activityOpen}
            phase={phase}
            pulse={activityPulse}
            progress={progress}
          />
        </div>
      </div>
    </div>
  );
}

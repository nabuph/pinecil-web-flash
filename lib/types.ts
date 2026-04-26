export type PinecilModel = "v1" | "v2";
export type InstallKind = "firmware" | "bootLogo";
export type TransportKind = "webusb-dfu" | "webserial-blisp" | "webbluetooth-ble" | "demo";
export type ReleaseChannel = "stable" | "prerelease";
export type FlashPhase = "connect" | "detect" | "select" | "validate" | "flash" | "verify" | "done" | "fail";

export interface FirmwareRelease {
  tag: string;
  name: string;
  channel: ReleaseChannel;
  publishedAt: string;
  htmlUrl: string;
  assets: FirmwareAsset[];
}

export interface FirmwareAsset {
  assetId: number;
  fileName: string;
  model: PinecilModel | "all";
  kind: InstallKind | "metadata";
  size: number;
  sha256?: string;
  downloadUrl?: string;
  contentType?: string;
}

export interface LanguageOption {
  code: string;
  name: string;
}

export interface FlashTarget {
  model: PinecilModel;
  transport: TransportKind;
  label: string;
  portName?: string;
  serial?: string;
  bootloader?: string;
  connectedAt: string;
}

export interface FlashInput {
  model: PinecilModel;
  kind: InstallKind;
  fileName: string;
  bytes: Uint8Array;
  releaseTag?: string;
  language?: string;
  sha256?: string;
}

export interface FlashProgress {
  phase: FlashPhase;
  message: string;
  current: number;
  total: number;
  level?: "info" | "warn" | "error" | "success";
}

export interface FlashResult {
  ok: boolean;
  message: string;
  verifySummary?: string;
}

export interface FlasherBackend {
  connect(): Promise<FlashTarget>;
  flash(input: FlashInput, onProgress: (event: FlashProgress) => void): Promise<FlashResult>;
  close(): Promise<void>;
}

export interface LogoGenerationInput {
  model: PinecilModel;
  image?: File;
  imagePan?: LogoPanOffset;
  threshold: number;
  invert: boolean;
  erase?: boolean;
  animationMode: "static" | "animated";
}

export interface LogoPanOffset {
  x: number;
  y: number;
  zoom?: number;
}

export interface GeneratedLogo {
  fileName: string;
  bytes: Uint8Array;
  pixels: Uint8Array;
  width: number;
  height: number;
  previewUrl: string;
  formatNote: string;
  isErase: boolean;
}

export interface BleSettingOption {
  value: number;
  label: string;
}

export interface BleSetting {
  id: number;
  name: string;
  value: number;
  writable: boolean;
  min?: number;
  max?: number;
  description?: string;
  unit?: string;
  options?: BleSettingOption[];
}

export interface BleSnapshot {
  deviceName: string;
  buildId?: string;
  serial?: string;
  uniqueId?: string;
  readOnly: boolean;
  telemetry: Record<string, number>;
  settings: BleSetting[];
}

export interface BleSettingDraft extends BleSetting {
  originalValue: number;
  draftValue: number;
  dirty: boolean;
}

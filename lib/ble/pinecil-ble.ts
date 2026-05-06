import type { BleSetting, BleSettingDraft, BleSnapshot } from "@/lib/types";

export const BLE_BULK_SERVICE = "9eae1000-9d0d-48c5-aa55-33e27f9bc533";
export const BLE_LIVE_SERVICE = "d85ef000-168e-4a71-aa55-33e27f9bc533";
export const BLE_SETTINGS_SERVICE = "f6d80000-5a10-4eba-aa55-33e27f9bc533";
export const BLE_SAVE_CHARACTERISTIC = "f6d7ffff-5a10-4eba-aa55-33e27f9bc533";

const BULK_CHARACTERISTICS = {
  live: "9eae1001-9d0d-48c5-aa55-33e27f9bc533",
  build: "9eae1003-9d0d-48c5-aa55-33e27f9bc533",
  serial: "9eae1004-9d0d-48c5-aa55-33e27f9bc533",
  uniqueId: "9eae1005-9d0d-48c5-aa55-33e27f9bc533"
} as const;

export const KNOWN_BLE_SETTINGS: BleSetting[] = [
  { id: 0, name: "Soldering temperature", value: 320, min: 10, max: 450, writable: true, unit: "°C", description: "Main set point used while soldering" },
  { id: 1, name: "Sleep temperature", value: 150, min: 10, max: 300, writable: true, unit: "°C", description: "Reduced set point while the iron is idle" },
  { id: 2, name: "Sleep timeout", value: 5, min: 0, max: 60, writable: true, unit: "min", description: "Idle time before the iron enters sleep" },
  {
    id: 15, name: "Temperature units", value: 0, min: 0, max: 1, writable: true,
    description: "Display scale used for all temperatures",
    options: [
      { value: 0, label: "°C" },
      { value: 1, label: "°F" }
    ]
  },
  { id: 24, name: "Power limit", value: 65, min: 0, max: 140, writable: true, unit: "W", description: "Maximum power the iron will draw" },
  {
    id: 33, name: "OLED inversion", value: 0, min: 0, max: 1, writable: true,
    description: "Swap light and dark pixels on the display",
    options: [
      { value: 0, label: "Normal" },
      { value: 1, label: "Inverted" }
    ]
  },
  { id: 34, name: "OLED brightness", value: 16, min: 1, max: 32, writable: true, unit: "/32", description: "Display brightness level" },
  { id: 35, name: "Logo duration", value: 5, min: 0, max: 60, writable: true, unit: "sec", description: "How long the boot logo is shown at startup" },
  {
    id: 37, name: "Bluetooth mode", value: 1, min: 0, max: 2, writable: false,
    description: "Bluetooth advertising mode (changed on the iron)",
    options: [
      { value: 0, label: "Off" },
      { value: 1, label: "Full" },
      { value: 2, label: "Read-only" }
    ]
  },
  {
    id: 38, name: "USB-PD mode", value: 1, min: 0, max: 2, writable: true,
    description: "USB Power Delivery PPS and EPR behavior",
    options: [
      { value: 0, label: "Off" },
      { value: 1, label: "PPS" },
      { value: 2, label: "EPR" }
    ]
  }
];

export function settingCharacteristicUuid(id: number): string {
  if (!Number.isInteger(id) || id < 0 || id > 0xffff) throw new Error("BLE setting id must be a uint16.");
  return `f6d7${id.toString(16).padStart(4, "0")}-5a10-4eba-aa55-33e27f9bc533`;
}

function uint16Bytes(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
}

function uint16Buffer(value: number): ArrayBuffer {
  const copy = new Uint8Array(2);
  copy.set(uint16Bytes(value));
  return copy.buffer;
}

function readU16(view: DataView): number {
  return view.getUint16(0, true);
}

function decodeText(view: DataView): string {
  return new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)).replace(/\0+$/g, "");
}

export function decodeBinaryIdentifier(view: DataView): string {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join(":");
}

function readTelemetry(view: DataView): Record<string, number> {
  const names = [
    "tipTempC",
    "setPointC",
    "dcInputMv",
    "handleTempC",
    "powerLevel",
    "powerSource",
    "tipResistance",
    "uptimeSeconds",
    "lastMovementSeconds",
    "maxTempC",
    "rawTip",
    "hallSensor",
    "operatingMode",
    "estimatedWatts"
  ];
  const result: Record<string, number> = {};
  for (let index = 0; index < names.length && index * 4 + 4 <= view.byteLength; index += 1) {
    result[names[index]] = view.getUint32(index * 4, true);
  }
  return result;
}

export class PinecilBleClient {
  static onDisconnect: (source: PinecilBleClient) => void = () => undefined;
  private device?: BluetoothDevice;
  private server?: BluetoothRemoteGATTServer;
  private disconnectListener?: () => void;
  private readOnly = false;

  async connect(): Promise<string> {
    if (!navigator.bluetooth) throw new Error("Web Bluetooth is not available in this browser.");
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [BLE_BULK_SERVICE] }],
      optionalServices: [BLE_BULK_SERVICE, BLE_LIVE_SERVICE, BLE_SETTINGS_SERVICE]
    });
    if (!device.gatt) throw new Error("Selected device does not expose GATT.");
    this.device = device;
    this.disconnectListener = () => PinecilBleClient.onDisconnect(this);
    (device as unknown as EventTarget).addEventListener("gattserverdisconnected", this.disconnectListener);
    this.server = await device.gatt.connect();
    return device.name ?? "Pinecil V2";
  }

  async snapshot(deviceName = "Pinecil V2"): Promise<BleSnapshot> {
    if (!this.server) throw new Error("Bluetooth client is not connected.");
    const [bulk, settingsService] = await Promise.all([
      this.server.getPrimaryService(BLE_BULK_SERVICE),
      this.server.getPrimaryService(BLE_SETTINGS_SERVICE)
    ]);

    const [buildId, serial, uniqueId, telemetry, settings] = await Promise.all([
      this.readText(bulk, BULK_CHARACTERISTICS.build).catch(() => undefined),
      this.readBinaryIdentifier(bulk, BULK_CHARACTERISTICS.serial).catch(() => undefined),
      this.readBinaryIdentifier(bulk, BULK_CHARACTERISTICS.uniqueId).catch(() => undefined),
      this.readBulkTelemetry(bulk).catch(() => ({})),
      this.readSettings(settingsService)
    ]);

    const bleMode = settings.find((setting) => setting.id === 37)?.value;
    this.readOnly = bleMode === 2;
    return {
      deviceName,
      buildId,
      serial,
      uniqueId,
      readOnly: this.readOnly,
      telemetry,
      settings: settings.map((setting) => ({ ...setting, writable: setting.writable && !this.readOnly }))
    };
  }

  async writeSetting(setting: BleSetting, value: number) {
    if (!this.server) throw new Error("Bluetooth client is not connected.");
    if (this.readOnly || !setting.writable) throw new Error("This setting is read-only.");
    if (setting.min !== undefined && value < setting.min) throw new Error(`${setting.name} must be at least ${setting.min}.`);
    if (setting.max !== undefined && value > setting.max) throw new Error(`${setting.name} must be at most ${setting.max}.`);
    const settingsService = await this.server.getPrimaryService(BLE_SETTINGS_SERVICE);
    const characteristic = await settingsService.getCharacteristic(settingCharacteristicUuid(setting.id));
    await characteristic.writeValue(uint16Buffer(value));
  }

  async writeSettingDrafts(drafts: BleSettingDraft[]) {
    const dirtyDrafts = drafts.filter((draft) => draft.dirty);
    for (const draft of dirtyDrafts) {
      await this.writeSetting(draft, draft.draftValue);
    }
    return dirtyDrafts.length;
  }

  async saveSettings() {
    if (!this.server) throw new Error("Bluetooth client is not connected.");
    if (this.readOnly) throw new Error("The iron is in Bluetooth read-only mode.");
    const settingsService = await this.server.getPrimaryService(BLE_SETTINGS_SERVICE);
    const characteristic = await settingsService.getCharacteristic(BLE_SAVE_CHARACTERISTIC);
    await characteristic.writeValue(uint16Buffer(1));
  }

  async readLiveTelemetry(): Promise<Record<string, number>> {
    if (!this.server) throw new Error("Bluetooth client is not connected.");
    const bulk = await this.server.getPrimaryService(BLE_BULK_SERVICE);
    return this.readBulkTelemetry(bulk);
  }

  disconnect() {
    if (this.device && this.disconnectListener) {
      try {
        (this.device as unknown as EventTarget).removeEventListener("gattserverdisconnected", this.disconnectListener);
      } catch { /* ignore */ }
    }
    this.server?.disconnect();
    this.server = undefined;
    this.device = undefined;
    this.disconnectListener = undefined;
  }

  private async readText(service: BluetoothRemoteGATTService, uuid: string) {
    return decodeText(await (await service.getCharacteristic(uuid)).readValue());
  }

  private async readBinaryIdentifier(service: BluetoothRemoteGATTService, uuid: string) {
    return decodeBinaryIdentifier(await (await service.getCharacteristic(uuid)).readValue());
  }

  private async readBulkTelemetry(service: BluetoothRemoteGATTService) {
    return readTelemetry(await (await service.getCharacteristic(BULK_CHARACTERISTICS.live)).readValue());
  }

  private async readSettings(service: BluetoothRemoteGATTService): Promise<BleSetting[]> {
    const values = await Promise.all(
      KNOWN_BLE_SETTINGS.map(async (setting) => {
        try {
          const characteristic = await service.getCharacteristic(settingCharacteristicUuid(setting.id));
          return { ...setting, value: readU16(await characteristic.readValue()) };
        } catch {
          return setting;
        }
      })
    );
    return values;
  }
}

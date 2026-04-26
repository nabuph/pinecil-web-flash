import { describe, expect, it } from "vitest";
import { BLE_BULK_SERVICE, decodeBinaryIdentifier, settingCharacteristicUuid } from "@/lib/ble/pinecil-ble";

describe("Pinecil BLE helpers", () => {
  it("uses the IronOS bulk service UUID", () => {
    expect(BLE_BULK_SERVICE).toBe("9eae1000-9d0d-48c5-aa55-33e27f9bc533");
  });

  it("builds setting characteristic UUIDs", () => {
    expect(settingCharacteristicUuid(37)).toBe("f6d70025-5a10-4eba-aa55-33e27f9bc533");
  });

  it("decodes binary identifiers as hex instead of text", () => {
    const view = new DataView(new Uint8Array([0xde, 0xad, 0xbe, 0xef]).buffer);
    expect(decodeBinaryIdentifier(view)).toBe("de:ad:be:ef");
  });
});

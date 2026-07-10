import { describe, expect, it } from "vitest";
import { prepareInstall, simulatePreparedFlash, verifyExpectedSha256 } from "@/lib/flash/pipeline";
import { sha256Hex } from "@/lib/utils/hash";
import type { FlashTarget } from "@/lib/types";

const demoTarget: FlashTarget = {
  model: "v2",
  transport: "demo",
  label: "Pinecil V2 demo target",
  connectedAt: "2026-04-24T00:00:00.000Z"
};

describe("flash pipeline", () => {
  it("prepares and hashes a model-compatible install file", async () => {
    const prepared = await prepareInstall(demoTarget, {
      kind: "firmware",
      fileName: "Pinecilv2_EN.bin",
      language: "EN",
      bytes: new Uint8Array([1, 2, 3])
    });

    expect(prepared.model).toBe("v2");
    expect(prepared.sha256).toHaveLength(64);
    expect(prepared.warnings).toEqual([]);
  });

  it("blocks wrong firmware types before flashing", async () => {
    await expect(
      prepareInstall(demoTarget, {
        kind: "firmware",
        fileName: "Pinecil_EN.dfu",
        language: "EN",
        bytes: new Uint8Array([1, 2, 3])
      })
    ).rejects.toThrow("expects .bin");
  });

  it("requires bundled assets to match their catalog SHA-256", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const digest = await sha256Hex(bytes);
    await expect(verifyExpectedSha256(bytes, digest, "Firmware archive")).resolves.toBe(digest);
    await expect(verifyExpectedSha256(bytes, "0".repeat(64), "Firmware archive"))
      .rejects.toThrow(/SHA-256 mismatch/i);
    await expect(verifyExpectedSha256(bytes, undefined, "Firmware archive"))
      .rejects.toThrow(/no SHA-256 digest/i);
  });

  it("runs validate-to-verify through the demo flash path", async () => {
    const prepared = await prepareInstall(demoTarget, {
      kind: "firmware",
      fileName: "Pinecilv2_EN.bin",
      language: "EN",
      bytes: new Uint8Array([1, 2, 3])
    });
    const phases: string[] = [];
    const result = await simulatePreparedFlash(prepared, (event) => phases.push(event.phase));

    expect(result.ok).toBe(true);
    expect(phases).toContain("flash");
    expect(phases).toContain("verify");
  });
});

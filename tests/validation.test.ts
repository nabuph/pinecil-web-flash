import { describe, expect, it } from "vitest";
import { expectedExtension, validateInstallFileName } from "@/lib/firmware/validation";

describe("firmware validation", () => {
  it("uses model-specific extensions", () => {
    expect(expectedExtension("v1", "firmware")).toBe("dfu");
    expect(expectedExtension("v2", "firmware")).toBe("bin");
    expect(expectedExtension("v2", "bootLogo")).toBe("dfu");
  });

  it("warns on mismatched file names", () => {
    expect(validateInstallFileName("Pinecilv2_EN.bin", "v1", "firmware", "EN")).toHaveLength(2);
    expect(validateInstallFileName("Pinecil_EN.dfu", "v1", "firmware", "EN")).toHaveLength(0);
  });
});

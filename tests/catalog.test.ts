import { describe, expect, it } from "vitest";
import { classifyAsset, compatibleFirmwareReleases, firmwareFileName, normalizeReleases } from "@/lib/catalog/releases";

describe("release catalog", () => {
  it("classifies IronOS Pinecil assets", () => {
    expect(
      classifyAsset({
        id: 1,
        name: "Pinecilv2.zip",
        size: 123,
        browser_download_url: "https://example.test/Pinecilv2.zip"
      })
    ).toMatchObject({ model: "v2", kind: "firmware" });
    expect(
      classifyAsset({
        id: 2,
        name: "metadata.zip",
        size: 123,
        browser_download_url: "https://example.test/metadata.zip"
      })
    ).toMatchObject({ model: "all", kind: "metadata" });
  });

  it("normalizes stable and prerelease data", () => {
    const releases = normalizeReleases([
      {
        tag_name: "v2.23.0",
        name: "IronOS v2.23.0",
        prerelease: false,
        draft: false,
        published_at: "2026-01-01T00:00:00Z",
        html_url: "https://example.test/release",
        assets: [
          { id: 1, name: "Pinecil.zip", size: 10, browser_download_url: "x" },
          { id: 2, name: "Pinecilv2.zip", size: 10, browser_download_url: "x" }
        ]
      }
    ]);
    expect(releases).toHaveLength(1);
    expect(releases[0].channel).toBe("stable");
    expect(releases[0].assets).toHaveLength(2);
  });

  it("constructs model-specific firmware file names", () => {
    expect(firmwareFileName("v1", "EN")).toBe("Pinecil_EN.dfu");
    expect(firmwareFileName("v2", "EN")).toBe("Pinecilv2_EN.bin");
  });

  it("filters firmware releases by connected model", () => {
    const releases = normalizeReleases([
      {
        tag_name: "v2.19",
        name: "IronOS v2.19",
        prerelease: false,
        draft: false,
        published_at: "2022-07-13T00:00:00Z",
        html_url: "https://example.test/v2.19",
        assets: [
          { id: 1, name: "Pinecil.zip", size: 10, browser_download_url: "x" }
        ]
      },
      {
        tag_name: "v2.21",
        name: "IronOS v2.21",
        prerelease: false,
        draft: false,
        published_at: "2023-01-01T00:00:00Z",
        html_url: "https://example.test/v2.21",
        assets: [
          { id: 2, name: "Pinecil.zip", size: 10, browser_download_url: "x" },
          { id: 3, name: "Pinecilv2.zip", size: 10, browser_download_url: "x" }
        ]
      }
    ]);

    expect(compatibleFirmwareReleases(releases, "v1").map((release) => release.tag)).toEqual(["v2.19", "v2.21"]);
    expect(compatibleFirmwareReleases(releases, "v2").map((release) => release.tag)).toEqual(["v2.21"]);
  });
});

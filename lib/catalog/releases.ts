import type { FirmwareAsset, FirmwareRelease, LanguageOption, PinecilModel, ReleaseChannel } from "@/lib/types";

interface GitHubReleaseAsset {
  id: number;
  name: string;
  size: number;
  browser_download_url: string;
  content_type?: string;
}

interface GitHubRelease {
  tag_name: string;
  name: string | null;
  prerelease: boolean;
  draft: boolean;
  published_at: string;
  html_url: string;
  assets: GitHubReleaseAsset[];
}

const MODEL_BY_PREFIX: Array<[RegExp, PinecilModel]> = [
  [/^Pinecilv2/i, "v2"],
  [/^Pinecil(?!v2)/i, "v1"]
];

export const DEFAULT_LANGUAGES: LanguageOption[] = [
  { code: "EN", name: "English" },
  { code: "DE", name: "Deutsch" },
  { code: "ES", name: "Español" },
  { code: "FR", name: "Français" },
  { code: "IT", name: "Italiano" },
  { code: "JA", name: "日本語" },
  { code: "NL", name: "Nederlands" },
  { code: "PL", name: "Polski" },
  { code: "PT", name: "Português" },
  { code: "RU", name: "Русский" },
  { code: "ZH_TW", name: "繁體中文" }
];

export function classifyAsset(asset: GitHubReleaseAsset): FirmwareAsset | null {
  const fileName = asset.name;
  if (/^metadata\.zip$/i.test(fileName)) {
    return {
      assetId: asset.id,
      fileName,
      model: "all",
      kind: "metadata",
      size: asset.size,
      downloadUrl: asset.browser_download_url,
      contentType: asset.content_type
    };
  }

  const modelMatch = MODEL_BY_PREFIX.find(([pattern]) => pattern.test(fileName));
  if (!modelMatch) return null;

  const isFirmwareZip = /\.zip$/i.test(fileName);
  const isLogoDfu = /logo|boot/i.test(fileName) && /\.dfu$/i.test(fileName);
  if (!isFirmwareZip && !isLogoDfu) return null;

  return {
    assetId: asset.id,
    fileName,
    model: modelMatch[1],
    kind: isLogoDfu ? "bootLogo" : "firmware",
    size: asset.size,
    downloadUrl: asset.browser_download_url,
    contentType: asset.content_type
  };
}

export function normalizeReleases(releases: GitHubRelease[]): FirmwareRelease[] {
  return releases
    .filter((release) => !release.draft)
    .map((release): FirmwareRelease => {
      const channel: ReleaseChannel = release.prerelease ? "prerelease" : "stable";
      return {
        tag: release.tag_name,
        name: release.name ?? release.tag_name,
        channel,
        publishedAt: release.published_at,
        htmlUrl: release.html_url,
        assets: release.assets.flatMap((asset) => {
          const normalized = classifyAsset(asset);
          return normalized ? [normalized] : [];
        })
      };
    })
    .filter((release) => release.assets.some((asset) => asset.kind === "firmware"));
}

export function findFirmwareAsset(
  release: FirmwareRelease | undefined,
  model: PinecilModel
): FirmwareAsset | undefined {
  return release?.assets.find((asset) => asset.kind === "firmware" && asset.model === model);
}

export function hasFirmwareForModel(release: FirmwareRelease, model: PinecilModel): boolean {
  return Boolean(findFirmwareAsset(release, model));
}

export function compatibleFirmwareReleases(
  releases: FirmwareRelease[],
  model?: PinecilModel
): FirmwareRelease[] {
  if (!model) return releases;
  return releases.filter((release) => hasFirmwareForModel(release, model));
}

export function findMetadataAsset(release: FirmwareRelease | undefined): FirmwareAsset | undefined {
  return release?.assets.find((asset) => asset.kind === "metadata");
}

export function firmwareFileName(model: PinecilModel, language: string): string {
  return `${model === "v1" ? "Pinecil" : "Pinecilv2"}_${language}.${model === "v1" ? "dfu" : "bin"}`;
}

export function sampleReleases(): FirmwareRelease[] {
  return [
    {
      tag: "v2.23.0",
      name: "IronOS v2.23.0",
      channel: "stable",
      publishedAt: "2026-03-14T00:00:00Z",
      htmlUrl: "https://github.com/Ralim/IronOS/releases",
      assets: [
        { assetId: 101, fileName: "Pinecil.zip", model: "v1", kind: "firmware", size: 412672 },
        { assetId: 102, fileName: "Pinecilv2.zip", model: "v2", kind: "firmware", size: 484352 },
        { assetId: 103, fileName: "metadata.zip", model: "all", kind: "metadata", size: 15872 }
      ]
    },
    {
      tag: "v2.24.0-rc1",
      name: "IronOS v2.24.0 RC1",
      channel: "prerelease",
      publishedAt: "2026-04-05T00:00:00Z",
      htmlUrl: "https://github.com/Ralim/IronOS/releases",
      assets: [
        { assetId: 201, fileName: "Pinecil.zip", model: "v1", kind: "firmware", size: 418144 },
        { assetId: 202, fileName: "Pinecilv2.zip", model: "v2", kind: "firmware", size: 492080 },
        { assetId: 203, fileName: "metadata.zip", model: "all", kind: "metadata", size: 16320 }
      ]
    }
  ];
}

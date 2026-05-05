import { afterEach, describe, expect, it, vi } from "vitest";

const envNames = [
  "GITHUB_TOKEN",
  "BUNDLE_RELEASES_BUDGET_BYTES",
  "BUNDLE_RELEASES_SITE_LIMIT_BYTES",
  "BUNDLE_RELEASES_SITE_RESERVE_BYTES",
  "BUNDLE_RELEASES_MAX_PAGES"
] as const;
const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));

interface ReleaseAssetFixture {
  id: number;
  name: string;
  size: number;
  browser_download_url: string;
}

interface ReleaseFixture {
  tag_name: string;
  prerelease: boolean;
  draft: boolean;
  published_at?: string;
  assets: ReleaseAssetFixture[];
}

function firmwareAsset(name: string, size: number): ReleaseAssetFixture {
  return {
    id: size,
    name,
    size,
    browser_download_url: `https://example.test/${name}`
  };
}

function release(tag: string, size: number, options: Partial<ReleaseFixture> = {}): ReleaseFixture {
  return {
    tag_name: tag,
    prerelease: false,
    draft: false,
    assets: [firmwareAsset("Pinecil.zip", size)],
    ...options
  };
}

async function loadBundler() {
  // @ts-expect-error The release bundler is a Node ESM script, not part of the TS app bundle.
  return import("../scripts/bundle-releases.mjs") as Promise<{
    expectedBundleSize: (release: ReleaseFixture) => number;
    loadSelectableReleases: (options?: { logger?: Pick<Console, "warn">; budgetBytes?: number; maxPages?: number }) => Promise<ReleaseFixture[]>;
    pickReleases: (releases: ReleaseFixture[], options?: { budgetBytes?: number }) => ReleaseFixture[];
  }>;
}

describe("release bundler", () => {
  afterEach(() => {
    for (const name of envNames) {
      const value = originalEnv[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    vi.restoreAllMocks();
  });

  it("fills the release list from the Pages byte budget instead of a fixed count", async () => {
    const { pickReleases } = await loadBundler();
    const releases = [
      release("v2.27", 100),
      release("v2.26", 100),
      release("v2.25", 100),
      release("v2.24", 100),
      release("v2.23", 100),
      release("v2.22", 100)
    ];

    const picked = pickReleases(releases, { budgetBytes: 1_000 });

    expect(picked.map((item) => item.tag_name)).toEqual(["v2.27", "v2.26", "v2.25", "v2.24", "v2.23", "v2.22"]);
  });

  it("drops older releases when the release asset budget is full", async () => {
    const { pickReleases } = await loadBundler();
    const releases = [
      release("v2.27", 120),
      release("v2.26", 120),
      release("v2.25", 120),
      release("v2.24", 40)
    ];

    const picked = pickReleases(releases, { budgetBytes: 280 });

    expect(picked.map((item) => item.tag_name)).toEqual(["v2.27", "v2.26"]);
  });

  it("fills stable releases first, then prereleases with remaining room", async () => {
    const { pickReleases } = await loadBundler();
    const releases = [
      release("v2.26-rc1", 100, { prerelease: true, published_at: "2026-03-15T00:00:00Z" }),
      release("v2.25", 100, { published_at: "2026-01-15T00:00:00Z" }),
      release("v2.27-rc1", 100, { prerelease: true, published_at: "2026-04-15T00:00:00Z" }),
      release("v2.26", 100, { published_at: "2026-02-15T00:00:00Z" })
    ];

    const picked = pickReleases(releases, { budgetBytes: 300 });

    expect(picked.map((item) => item.tag_name)).toEqual(["v2.26", "v2.25", "v2.27-rc1"]);
  });

  it("counts only bundled Pinecil assets toward release size", async () => {
    const { expectedBundleSize } = await loadBundler();
    const fixture = release("v2.27", 120, {
      assets: [
        firmwareAsset("Pinecil.zip", 120),
        firmwareAsset("Pinecilv2.zip", 240),
        firmwareAsset("metadata.zip", 10),
        firmwareAsset("Source code.zip", 1_000)
      ]
    });

    expect(expectedBundleSize(fixture)).toBe(370);
  });

  it("falls back to unauthenticated release lookup when a repo-scoped token sees no public releases", async () => {
    process.env.GITHUB_TOKEN = "repo-scoped-token";
    const releases = [
      release("v2.23", 100),
      release("v2.23-rc4", 100, { prerelease: true })
    ];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => ({
      ok: true,
      json: async () => (init?.headers && "Authorization" in init.headers ? [] : releases)
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { loadSelectableReleases } = await loadBundler();
    const warn = vi.fn();
    const picked = await loadSelectableReleases({ logger: { warn } });

    expect(picked.map((release) => release.tag_name)).toEqual(["v2.23", "v2.23-rc4"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("retrying without GITHUB_TOKEN"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer repo-scoped-token"
    });
    expect(fetchMock.mock.calls[1]?.[1]?.headers).not.toHaveProperty("Authorization");
  });
});

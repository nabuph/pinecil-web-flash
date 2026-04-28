import { afterEach, describe, expect, it, vi } from "vitest";

const originalToken = process.env.GITHUB_TOKEN;

async function loadBundler() {
  // @ts-expect-error The release bundler is a Node ESM script, not part of the TS app bundle.
  return import("../scripts/bundle-releases.mjs") as Promise<{
    loadSelectableReleases: (options?: { logger?: Pick<Console, "warn"> }) => Promise<Array<{ tag_name: string }>>;
  }>;
}

describe("release bundler", () => {
  afterEach(() => {
    process.env.GITHUB_TOKEN = originalToken;
    vi.restoreAllMocks();
  });

  it("falls back to unauthenticated release lookup when a repo-scoped token sees no public releases", async () => {
    process.env.GITHUB_TOKEN = "repo-scoped-token";
    const releases = [
      { tag_name: "v2.23", prerelease: false, draft: false },
      { tag_name: "v2.23-rc4", prerelease: true, draft: false }
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

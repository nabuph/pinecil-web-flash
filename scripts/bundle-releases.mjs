#!/usr/bin/env node
// Bundles IronOS releases into public/firmware/{tag}/ so the static deploy can
// serve firmware assets same-origin (release-assets.githubusercontent.com does
// not send CORS headers, so the browser cannot fetch GitHub release downloads
// directly). Generates public/releases.json for the runtime catalog.
//
// Set BUNDLE_RELEASES=skip to bypass network access (useful for offline dev or
// CI failures). The runtime falls back to the sample catalog when the file is
// missing, so demos still work.

import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = "Ralim/IronOS";
// Bundle the latest few stable releases so users can roll back without a
// rebuild, plus the latest prerelease for adventurous testers.
const STABLE_COUNT = 3;
const PRERELEASE_COUNT = 1;
const PER_PAGE = 100;
const ASSET_NAMES = new Set(["Pinecil.zip", "Pinecilv2.zip", "metadata.zip"]);

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const publicDir = join(repoRoot, "public");
const firmwareDir = join(publicDir, "firmware");
const catalogPath = join(publicDir, "releases.json");

export async function gh(path, { useToken = true } = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "pinecil-web-flasher-bundler",
      ...(useToken && process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {})
    }
  });
  if (!res.ok) throw new Error(`GitHub API ${path} returned ${res.status} ${res.statusText}`);
  return res.json();
}

export async function fetchReleasePages({ useToken }) {
  const releases = [];
  for (let page = 1; page <= 3; page += 1) {
    const batch = await gh(`/repos/${REPO}/releases?per_page=${PER_PAGE}&page=${page}`, { useToken });
    if (!Array.isArray(batch)) throw new Error("GitHub releases API returned an unexpected response.");
    releases.push(...batch);
    if (batch.length < PER_PAGE) break;
    if (pickReleases(releases).length >= STABLE_COUNT + PRERELEASE_COUNT) break;
  }
  return releases;
}

async function downloadTo(url, destination) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Download ${url} returned ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, buffer);
  return buffer.length;
}

export function pickReleases(releases) {
  const stable = releases.filter((r) => !r.prerelease && !r.draft).slice(0, STABLE_COUNT);
  const prerelease = releases.filter((r) => r.prerelease && !r.draft).slice(0, PRERELEASE_COUNT);
  return [...stable, ...prerelease];
}

export async function loadSelectableReleases({ logger = console } = {}) {
  let all = await fetchReleasePages({ useToken: true });
  let picked = pickReleases(all);
  if (!picked.length && process.env.GITHUB_TOKEN) {
    logger.warn("[bundle-releases] Authenticated release lookup found no selectable public releases; retrying without GITHUB_TOKEN.");
    all = await fetchReleasePages({ useToken: false });
    picked = pickReleases(all);
  }
  return picked;
}

async function main() {
  if (process.env.BUNDLE_RELEASES === "skip") {
    console.log("[bundle-releases] BUNDLE_RELEASES=skip — leaving public/firmware untouched.");
    return;
  }

  console.log(`[bundle-releases] Fetching ${REPO} releases…`);
  const picked = await loadSelectableReleases();
  if (!picked.length) throw new Error("No releases matched the stable/prerelease filter.");

  if (existsSync(firmwareDir)) await rm(firmwareDir, { recursive: true, force: true });
  await mkdir(firmwareDir, { recursive: true });

  const catalog = [];
  for (const release of picked) {
    const safeTag = release.tag_name.replace(/[^A-Za-z0-9._-]/g, "_");
    const tagDir = join(firmwareDir, safeTag);
    await mkdir(tagDir, { recursive: true });

    const localAssets = [];
    for (const asset of release.assets) {
      if (!ASSET_NAMES.has(asset.name)) continue;
      const dest = join(tagDir, asset.name);
      console.log(`[bundle-releases]   ${release.tag_name}/${asset.name} (${(asset.size / 1024).toFixed(0)} KiB)`);
      const size = await downloadTo(asset.browser_download_url, dest);
      localAssets.push({
        id: asset.id,
        name: asset.name,
        size,
        content_type: asset.content_type,
        // Path is relative to the deployed root; the runtime prefixes basePath.
        browser_download_url: `firmware/${safeTag}/${asset.name}`
      });
    }
    if (!localAssets.length) {
      console.warn(`[bundle-releases]   skipping ${release.tag_name} — no expected assets present`);
      continue;
    }
    // Emit the same shape as the GitHub releases API so the runtime can reuse normalizeReleases().
    catalog.push({
      tag_name: release.tag_name,
      name: release.name ?? release.tag_name,
      prerelease: Boolean(release.prerelease),
      draft: false,
      published_at: release.published_at,
      html_url: release.html_url,
      assets: localAssets
    });
  }

  await writeFile(catalogPath, JSON.stringify({ generatedAt: new Date().toISOString(), releases: catalog }, null, 2));
  console.log(`[bundle-releases] Wrote ${catalog.length} releases to ${catalogPath}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("[bundle-releases] Failed:", err);
    process.exit(1);
  });
}

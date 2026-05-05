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
// GitHub Pages currently caps published sites at 1 GB. Keep a small reserve for
// the exported Next.js app, icons, protocol assets, and releases.json, then fill
// the rest with same-origin IronOS release assets.
export const GITHUB_PAGES_SITE_LIMIT_BYTES = 1_000_000_000;
export const DEFAULT_SITE_RESERVE_BYTES = 25 * 1024 * 1024;
const PER_PAGE = 100;
const DEFAULT_MAX_RELEASE_PAGES = 20;
const ASSET_NAMES = new Set(["Pinecil.zip", "Pinecilv2.zip", "metadata.zip"]);
const FIRMWARE_ASSET_NAMES = new Set(["Pinecil.zip", "Pinecilv2.zip"]);

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

function readPositiveIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer byte count.`);
  }
  return Math.floor(parsed);
}

function readNonNegativeIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer byte count.`);
  }
  return Math.floor(parsed);
}

export function releaseBundleBudgetBytes() {
  const explicitBudget = process.env.BUNDLE_RELEASES_BUDGET_BYTES;
  if (explicitBudget) {
    return readPositiveIntegerEnv("BUNDLE_RELEASES_BUDGET_BYTES", 0);
  }

  const siteLimit = readPositiveIntegerEnv("BUNDLE_RELEASES_SITE_LIMIT_BYTES", GITHUB_PAGES_SITE_LIMIT_BYTES);
  const reserve = readNonNegativeIntegerEnv("BUNDLE_RELEASES_SITE_RESERVE_BYTES", DEFAULT_SITE_RESERVE_BYTES);
  const budget = siteLimit - reserve;
  if (budget <= 0) {
    throw new Error("Release bundle budget must be positive after subtracting the site reserve.");
  }
  return budget;
}

function maxReleasePages() {
  return readPositiveIntegerEnv("BUNDLE_RELEASES_MAX_PAGES", DEFAULT_MAX_RELEASE_PAGES);
}

function expectedBundleAssets(release) {
  return (release.assets ?? []).filter((asset) => ASSET_NAMES.has(asset.name));
}

function hasExpectedFirmwareAsset(release) {
  return (release.assets ?? []).some((asset) => FIRMWARE_ASSET_NAMES.has(asset.name));
}

function releaseTimestamp(release) {
  const rawDate = release.published_at ?? release.created_at ?? "";
  const timestamp = Date.parse(rawDate);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function expectedBundleSize(release) {
  return expectedBundleAssets(release).reduce((total, asset) => total + (Number(asset.size) || 0), 0);
}

export function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

export async function fetchReleasePages({ useToken, maxPages = maxReleasePages() }) {
  const releases = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const batch = await gh(`/repos/${REPO}/releases?per_page=${PER_PAGE}&page=${page}`, { useToken });
    if (!Array.isArray(batch)) throw new Error("GitHub releases API returned an unexpected response.");
    releases.push(...batch);
    if (batch.length < PER_PAGE) break;
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

export function pickReleases(releases, { budgetBytes = releaseBundleBudgetBytes() } = {}) {
  const picked = [];
  let selectedBytes = 0;
  const selectable = releases
    .filter((release) => !release.draft && hasExpectedFirmwareAsset(release))
    .sort((a, b) => releaseTimestamp(b) - releaseTimestamp(a));
  const stable = selectable.filter((release) => !release.prerelease);
  const prerelease = selectable.filter((release) => release.prerelease);

  const addNewestUntilFull = (candidates) => {
    for (const release of candidates) {
      const releaseBytes = expectedBundleSize(release);
      if (releaseBytes <= 0) continue;
      if (releaseBytes > budgetBytes || selectedBytes + releaseBytes > budgetBytes) break;

      picked.push(release);
      selectedBytes += releaseBytes;
    }
  };

  addNewestUntilFull(stable);
  addNewestUntilFull(prerelease);

  return picked;
}

export async function loadSelectableReleases({ logger = console, budgetBytes = releaseBundleBudgetBytes(), maxPages } = {}) {
  let all = await fetchReleasePages({ useToken: true, maxPages });
  let picked = pickReleases(all, { budgetBytes });
  if (!picked.length && process.env.GITHUB_TOKEN) {
    logger.warn("[bundle-releases] Authenticated release lookup found no selectable public releases; retrying without GITHUB_TOKEN.");
    all = await fetchReleasePages({ useToken: false, maxPages });
    picked = pickReleases(all, { budgetBytes });
  }
  return picked;
}

async function main() {
  if (process.env.BUNDLE_RELEASES === "skip") {
    console.log("[bundle-releases] BUNDLE_RELEASES=skip — leaving public/firmware untouched.");
    return;
  }

  console.log(`[bundle-releases] Fetching ${REPO} releases…`);
  const budgetBytes = releaseBundleBudgetBytes();
  console.log(`[bundle-releases] Release asset budget: ${formatBytes(budgetBytes)}.`);
  const picked = await loadSelectableReleases({ budgetBytes });
  if (!picked.length) throw new Error("No releases matched the stable/prerelease filter.");

  if (existsSync(firmwareDir)) await rm(firmwareDir, { recursive: true, force: true });
  await mkdir(firmwareDir, { recursive: true });

  const catalog = [];
  let bundledBytes = 0;
  for (const release of picked) {
    const safeTag = release.tag_name.replace(/[^A-Za-z0-9._-]/g, "_");
    const tagDir = join(firmwareDir, safeTag);
    await mkdir(tagDir, { recursive: true });

    const localAssets = [];
    let releaseBytes = 0;
    for (const asset of release.assets) {
      if (!ASSET_NAMES.has(asset.name)) continue;
      const dest = join(tagDir, asset.name);
      console.log(`[bundle-releases]   ${release.tag_name}/${asset.name} (${(asset.size / 1024).toFixed(0)} KiB)`);
      const size = await downloadTo(asset.browser_download_url, dest);
      releaseBytes += size;
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
    if (bundledBytes + releaseBytes > budgetBytes) {
      await rm(tagDir, { recursive: true, force: true });
      console.warn(`[bundle-releases]   skipping ${release.tag_name} — downloaded assets would exceed the release asset budget`);
      break;
    }
    bundledBytes += releaseBytes;
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
  console.log(`[bundle-releases] Wrote ${catalog.length} releases to ${catalogPath} (${formatBytes(bundledBytes)} bundled assets).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("[bundle-releases] Failed:", err);
    process.exit(1);
  });
}

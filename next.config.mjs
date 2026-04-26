/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  // Set NEXT_PUBLIC_BASE_PATH to /your-repo-name for project pages (e.g. /pinecil-flasher).
  // Leave unset for a user/org page (username.github.io).
  basePath: process.env.NEXT_PUBLIC_BASE_PATH ?? "",
  reactStrictMode: true,
  typedRoutes: true,
  devIndicators: false,
  images: { unoptimized: true }
};

export default nextConfig;

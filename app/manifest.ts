import type { MetadataRoute } from "next";

export const dynamic = "force-static";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Pinecil Web Flash",
    short_name: "Pinecil Flash",
    description: "Update Pinecil firmware, boot logos, and Bluetooth settings from Chromium browsers.",
    start_url: `${basePath}/`,
    scope: `${basePath}/`,
    display: "standalone",
    background_color: "#f7f7f2",
    theme_color: "#168947",
    icons: [
      {
        src: `${basePath}/icon.svg`,
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any"
      }
    ]
  };
}

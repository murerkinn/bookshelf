import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {};

// Makes the Cloudflare bindings (R2, etc.) available to `next dev`.
initOpenNextCloudflareForDev();

export default nextConfig;

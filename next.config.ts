import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module — keep it out of the server bundle
  serverExternalPackages: ["better-sqlite3"],
  // the dev-tools overlay badge isn't part of the product
  devIndicators: false,
};

export default nextConfig;

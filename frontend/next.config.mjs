/**
 * CONTROL_PLANE_URL is read at build time, server-side only. When set, the
 * app proxies /api/v1/* to the Control Plane so REST calls — and the
 * refresh-token cookie — are same-origin. See lib/api-client.ts for why that
 * matters: cross-site cookies are not sent on fetch and are blocked on Safari.
 *
 * Only /api/v1 is proxied. Next.js route handlers under /api stay local.
 */
const controlPlaneUrl =
  process.env.CONTROL_PLANE_URL?.replace(/\/+$/, "") ||
  "https://odysseus-control-plane.onrender.com";
/** @type {import('next').NextConfig} */
const nextConfig = {
  // A second dev server (e.g. against a demo Control Plane) needs its own build folder.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  transpilePackages: ['@odysseus/protocol'],
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  // The installers are piped straight into a shell (`irm … | iex`,
  // `curl … | sh`): serve them as UTF-8 text, and keep caches short so a
  // fixed installer reaches people quickly.
  async headers() {
    return ['/install.ps1', '/install.sh'].map((source) => ({
      source,
      headers: [
        { key: 'Content-Type', value: 'text/plain; charset=utf-8' },
        { key: 'Cache-Control', value: 'public, max-age=300' },
      ],
    }))
  },
  async rewrites() {
    if (!controlPlaneUrl) return []
    return [
      {
        source: '/api/v1/:path*',
        destination: `${controlPlaneUrl}/api/v1/:path*`,
      },
      {
        source: '/health',
        destination: `${controlPlaneUrl}/health`,
      },
    ]
  },
}

export default nextConfig

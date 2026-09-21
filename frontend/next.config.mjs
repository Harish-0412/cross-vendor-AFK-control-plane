/**
 * CONTROL_PLANE_URL is read at build time, server-side only. When set, the
 * app proxies /api/v1/* to the Control Plane so REST calls — and the
 * refresh-token cookie — are same-origin. See lib/api-client.ts for why that
 * matters: cross-site cookies are not sent on fetch and are blocked on Safari.
 *
 * Only /api/v1 is proxied. Next.js route handlers under /api stay local.
 */
const controlPlaneUrl = process.env.CONTROL_PLANE_URL?.replace(/\/+$/, "")

/** @type {import('next').NextConfig} */
const nextConfig = {
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

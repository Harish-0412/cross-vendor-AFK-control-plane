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
}

export default nextConfig

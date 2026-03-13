/** @type {import('next').NextConfig} */

const BACKEND_URL =
  process.env.NEXT_PUBLIC_API_URL ||
  "https://watchtogether-production-b75c.up.railway.app";

const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${BACKEND_URL}/api/:path*`,
      },
      {
        source: "/uploads/:path*",
        destination: `${BACKEND_URL}/uploads/:path*`,
      },
    ];
  },
}

export default nextConfig

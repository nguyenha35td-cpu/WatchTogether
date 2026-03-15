/** @type {import('next').NextConfig} */

const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  // 前后端部署在同一台腾讯云 Lighthouse 服务器上，不再需要 rewrites 代理
}

export default nextConfig

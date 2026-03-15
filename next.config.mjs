/** @type {import('next').NextConfig} */

const nextConfig = {
  output: 'standalone',
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  // 前后端在同一台腾讯云 Lighthouse 上但不同容器
  // API 请求由浏览器直接发往后端 3001 端口，不走 Next.js 代理
}

export default nextConfig

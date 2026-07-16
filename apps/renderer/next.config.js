/** @type {import('next').NextConfig} */
const backendImpl = process.env.SQUADFLOW_BACKEND_IMPL ?? 'ts';
const defaultBackendTarget = backendImpl === 'python'
  ? 'http://127.0.0.1:8000'
  : 'http://127.0.0.1:8001';
const backendTarget = process.env.SQUADFLOW_BACKEND_URL ?? defaultBackendTarget;
const backendWsTarget = process.env.SQUADFLOW_BACKEND_WS_URL
  ?? backendTarget.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
const backendWsRewriteTarget = backendWsTarget.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');

const nextConfig = {
  reactStrictMode: false,
  output: 'standalone',
  outputFileTracingRoot: __dirname,
  transpilePackages: [
    'streamdown',
    '@streamdown/cjk',
    '@streamdown/code',
    '@streamdown/mermaid',
  ],
  async rewrites() {
    return [
      {
        source: '/health',
        destination: `${backendTarget}/health`,
      },
      {
        source: '/api/ws',
        destination: `${backendWsRewriteTarget}/api/ws`,
      },
      {
        source: '/api/:path*',
        destination: `${backendTarget}/api/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;

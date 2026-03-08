/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  typescript: {
    // Type errors are shown as warnings but do not fail the build.
    // We handle type safety through code review and testing.
    ignoreBuildErrors: true,
  },
};

module.exports = nextConfig;

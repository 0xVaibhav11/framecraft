/** @type {import('next').NextConfig} */
const config = {
  transpilePackages: ["@framepay/sdk", "@forshtat/hegota-support"],
  poweredByHeader: false,
  experimental: { cpus: 2 },
};
export default config;

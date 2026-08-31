import type { NextConfig } from 'next';

/**
 * Baseline response headers. A full Content-Security-Policy is defined with the
 * dashboard itself (docs/SECURITY.md §8); these three are safe to apply now and cost
 * nothing to keep.
 */
const securityHeaders = [
  { key: 'x-content-type-options', value: 'nosniff' },
  { key: 'referrer-policy', value: 'no-referrer' },
  { key: 'x-frame-options', value: 'DENY' },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Do not advertise the framework in responses.
  poweredByHeader: false,
  headers: () => Promise.resolve([{ source: '/:path*', headers: securityHeaders }]),
};

export default nextConfig;

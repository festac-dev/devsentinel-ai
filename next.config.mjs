/** @type {import('next').NextConfig} */
const isProd = process.env.NODE_ENV === "production";

// CSP is set per-request with a nonce in src/proxy.ts. The Docker image builds
// with NEXT_OUTPUT_STANDALONE=1 to get the self-contained server bundle it runs
// via `node server.js`; every other host (next start) uses the normal output —
// `next start` does not work with `output: "standalone"`.
const nextConfig = {
  ...(process.env.NEXT_OUTPUT_STANDALONE === "1" ? { output: "standalone" } : {}),
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "X-Frame-Options", value: "DENY" },
          ...(isProd ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }] : []),
        ],
      },
    ];
  },
};

export default nextConfig;

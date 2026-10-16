import { NextRequest, NextResponse } from "next/server";

/**
 * Nonce-based Content-Security-Policy (spec 16: no inline scripts without nonces).
 * Next.js reads the CSP header from the request and automatically adds the nonce
 * to its own inline bootstrap scripts. (Next.js 16 renamed middleware.ts → proxy.ts.)
 */
export default function proxy(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const isProd = process.env.NODE_ENV === "production";
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isProd ? "" : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    // Skip static assets; run on everything else.
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};

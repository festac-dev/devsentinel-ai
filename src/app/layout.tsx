import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export const metadata: Metadata = {
  title: "DevSentinel AI",
  description: "Build confidently. Deploy safely. Know what broke. Automated PR testing through TestSprite, bound to exact commits.",
};

/** Applies the stored theme before first paint (companion to components/theme-toggle.tsx). */
function themeScript() {
  return 'try{var t=localStorage.getItem("ds-theme");if(t==="dark"||(!t&&window.matchMedia("(prefers-color-scheme: dark)").matches)){document.documentElement.classList.add("dark")}}catch(e){}';
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased bg-white text-slate-900 dark:bg-slate-950 dark:text-slate-100">
        {nonce ? (
          <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeScript() }} />
        ) : null}
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:p-2 focus:bg-white focus:text-slate-900">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}

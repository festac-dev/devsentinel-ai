import Link from "next/link";
import { LandingHeader } from "@/components/landing-header";

const features = [
  {
    title: "Automated pull request testing",
    body: "Every pull request triggers a TestSprite test run through the official CLI. A run is reported as passed only after the provider confirms it.",
  },
  {
    title: "Results bound to the exact commit",
    body: "Each run is permanently bound to the commit SHA it tested. When a new commit lands, earlier results are marked Stale and can never validate the new head.",
  },
  {
    title: "Secure deployment monitoring",
    body: "Check a deployed URL on a schedule. Requests to internal addresses, cloud metadata endpoints, and reserved ranges are blocked, and health is reported only after a completed check.",
  },
  {
    title: "Evidence-backed incidents",
    body: "Incidents open automatically from verified events, such as threshold breaches and failed runs on the current head, and keep a full evidence timeline.",
  },
  {
    title: "Transparent integration status",
    body: "Each integration shows whether it is configured and healthy, so you always know what is connected.",
  },
  {
    title: "AI-assisted investigation",
    body: "An optional assistant separates confirmed facts, each linked to its evidence, from hypotheses and open questions.",
  },
];

const faqs = [
  {
    q: "What does it test?",
    a: "Pull requests on connected GitHub repositories are tested through TestSprite frontend test runs against your deployed target URL. Each run is executed by TestSprite and labeled accordingly.",
  },
  {
    q: "Does it deploy anything?",
    a: "No. DevSentinel observes deployments via HTTP checks. It does not deploy or manage infrastructure.",
  },
  {
    q: "How is my data handled?",
    a: "Credentials are encrypted at rest (AES-256-GCM) and write-only in the UI. Run output is capped, truncated visibly, and redacted for common secret patterns.",
  },
  {
    q: "What do I need to set up?",
    a: "A DevSentinel account, a GitHub repository you control, a TestSprite account with an API key (and a project ID), plus a reachable webhook endpoint. Optional: GitHub token for commit statuses, an AI provider key for investigations.",
  },
];

export default function LandingPage() {
  return (
    <main id="main">
      <LandingHeader />

      <section className="max-w-6xl mx-auto px-4 py-12 sm:py-20 text-center">
        <p className="text-sm uppercase tracking-wide text-slate-500 dark:text-slate-400">Continuous testing for pull requests</p>
        <h1 className="text-4xl sm:text-5xl font-bold mt-4 mb-4">Build confidently. Deploy safely. Know what broke.</h1>
        <p className="text-lg text-slate-600 dark:text-slate-400 max-w-2xl mx-auto">
          DevSentinel AI connects your GitHub pull requests to TestSprite test runs and ties every result to the exact commit it tested, so you always know which change passes, which fails, and whether a fix has landed.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
          <Link href="/register" className="rounded-md bg-slate-900 px-5 py-2.5 font-medium text-white hover:bg-slate-700 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200">Get Started</Link>
          <a href="#features" className="rounded-md border border-slate-300 dark:border-slate-700 px-5 py-2.5 font-medium hover:bg-slate-100 dark:hover:bg-slate-800">Explore Features</a>
        </div>
      </section>

      <section id="workflow" className="max-w-6xl mx-auto px-4 py-12 border-t border-slate-200 dark:border-slate-800">
        <h2 className="text-2xl font-semibold mb-8 text-center">The pull request testing workflow</h2>
        <ol className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6 text-sm">
          {[
            "Open a PR on a connected repository",
            "GitHub delivers a signed webhook",
            "Signature verified; job queued (deduped)",
            "TestSprite runs through the official CLI",
            "Result bound to the head commit SHA",
            "Status published to the same SHA",
          ].map((step, i) => (
            <li key={i} className="rounded-lg border border-slate-200 dark:border-slate-800 p-4">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-slate-900 text-white dark:bg-white dark:text-slate-900 text-xs font-semibold mb-2">{i + 1}</span>
              <p>{step}</p>
            </li>
          ))}
        </ol>
        <p className="text-center text-sm text-slate-500 dark:text-slate-400 mt-4">
          Results never carry over to a new commit. When the head moves, earlier runs are marked Stale, and a status is published only after the head SHA is re-checked.
        </p>
      </section>

      <section id="features" className="max-w-6xl mx-auto px-4 py-12 border-t border-slate-200 dark:border-slate-800">
        <h2 className="text-2xl font-semibold mb-8 text-center">What DevSentinel AI does</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f) => (
            <div key={f.title} className="rounded-lg border border-slate-200 dark:border-slate-800 p-5">
              <h3 className="font-semibold mb-2">{f.title}</h3>
              <p className="text-sm text-slate-600 dark:text-slate-400">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="security" className="max-w-6xl mx-auto px-4 py-12 border-t border-slate-200 dark:border-slate-800">
        <h2 className="text-2xl font-semibold mb-6 text-center">Security and privacy</h2>
        <ul className="max-w-3xl mx-auto text-sm space-y-2 list-disc pl-5 text-slate-600 dark:text-slate-400">
          <li>Server-side authentication and authorization on every route; cross-user access returns 404.</li>
          <li>GitHub webhooks are verified with HMAC-SHA256 over the raw body, constant-time, before parsing; deliveries are deduplicated by delivery ID.</li>
          <li>TestSprite and GitHub credentials are encrypted with AES-256-GCM and shown write-only (last four characters at most).</li>
          <li>Run output is size-capped and passed through a central secret-redaction utility before storage.</li>
          <li>Monitoring performs no requests to loopback, private, link-local, CGNAT, or reserved ranges — including DNS-resolved addresses and redirect targets.</li>
          <li>Passwords use scrypt with per-user salts; sessions are httpOnly cookies with idle and absolute timeouts.</li>
        </ul>
      </section>

      <section id="faq" className="max-w-3xl mx-auto px-4 py-12 border-t border-slate-200 dark:border-slate-800">
        <h2 className="text-2xl font-semibold mb-6 text-center">FAQ</h2>
        <div className="space-y-6">
          {faqs.map((f) => (
            <div key={f.q}>
              <h3 className="font-semibold">{f.q}</h3>
              <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">{f.a}</p>
            </div>
          ))}
        </div>
      </section>

      <footer className="border-t border-slate-200 dark:border-slate-800 mt-8">
        <div className="max-w-6xl mx-auto px-4 py-8 text-sm text-slate-500 dark:text-slate-400 flex flex-wrap gap-6">
          <span>© 2026 DevSentinel AI. Built for the TestSprite Hackathon.</span>
          <a href="#faq" className="hover:underline">Documentation</a>
          <a href="#security" className="hover:underline">Privacy</a>
          <a href="https://www.testsprite.com" target="_blank" rel="noreferrer" className="hover:underline">TestSprite</a>
        </div>
      </footer>
    </main>
  );
}

export const dynamic = "force-dynamic";
